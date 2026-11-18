"""
DBMS(sqlparser) 앞에 RedisStore 를 캐시로 두는 계층 — Cache-aside + 테이블 버전 키

    API(/sql) → [이 파일: CachedSQL] ─ SELECT ─→ RedisStore (hit 이면 여기서 끝)
                                      │              │ miss
                                      │              ▼
                                      └ INSERT/CREATE → Executor → CSV 파일 + B+ 트리

캐시에 넣는 것은 행 하나가 아니라 SELECT 결과 전체다.
id 로 찾는 조회는 B+ 트리가 이미 메모리에서 빠르게 끝내므로, 캐시가 실제로 효과를 내는 곳은
id 조건이 없어서 CSV 를 처음부터 끝까지 읽어야 하는 SELECT 이다.

키 구조
    dbcache:ver:<테이블>                      → 테이블 버전 (INSERT 할 때마다 INCR, TTL 없음)
    dbcache:q:<테이블>:v<버전>:<SQL 해시>      → SELECT 결과 JSON (TTL = ttl + 0~ttl_jitter 초)

무효화
    INSERT 가 들어오면 "어떤 쿼리 결과가 낡았는지"를 따지지 않고 테이블 버전만 1 올린다.
    이후 SELECT 는 새 버전 번호로 키를 만들기 때문에 옛 결과를 다시 찾지 않고,
    옛 키는 TTL 이 지나면 저절로 사라진다. (이 DBMS 는 INSERT 만 있고 UPDATE/DELETE 가 없어서
    기존 행이 바뀌는 일이 없다. 그래서 테이블 단위 버전 하나로 충분하다.)

일관성
    DB 쓰기와 버전 증가를 같은 락 안에서 한다. SELECT 가 캐시를 못 찾아 DB 를 읽을 때도 그 락을 잡고
    버전을 다시 읽으므로, "v<N> 키에 들어 있는 결과 = 버전 N 시점의 테이블 내용"이 항상 성립한다.
    (CSV 파일을 이 서버 밖에서 직접 고치면 버전이 안 바뀌므로 최대 TTL 동안 옛 결과가 보일 수 있다.)
"""

from __future__ import annotations

import hashlib
import json
import random
import threading
import time

from sqlparser import (
    CreateResult,
    CSVDatabase,
    Executor,
    InsertResult,
    Parser,
    SelectResult,
    SelectStatement,
    SQLError,
    Statement,
)

KEY_PREFIX = "dbcache"
DEFAULT_TTL = 60          # 초
DEFAULT_TTL_JITTER = 10   # TTL 에 0~이 값(초)만큼 무작위로 더한다. 한꺼번에 넣은 키들이 같은 순간 만료되는 것을 막음


def version_key(table: str) -> str:
    # Windows 는 파일 이름 대소문자를 구분하지 않아 Users.csv 와 users.csv 가 같은 파일이다.
    # 그래서 버전은 소문자 이름으로 하나만 둔다. (대소문자를 구분하는 OS 에서는 두 테이블이
    # 버전을 같이 쓰게 되지만, 필요 없는 무효화가 조금 늘 뿐 틀린 결과가 나오지는 않는다.)
    return f"{KEY_PREFIX}:ver:{table.lower()}"


def query_key(table: str, version: str, stmt: SelectStatement) -> str:
    # 원문 SQL 대신 구문 트리로 키를 만든다.
    # → 공백, 줄바꿈, 키워드 대소문자, 주석이 달라도 같은 쿼리면 같은 키
    # 테이블 이름은 원래 모양 그대로 넣는다. (대소문자를 구분하는 OS 에서 서로 다른 테이블이 섞이지 않게)
    canonical = repr((stmt.columns, stmt.table, stmt.where))
    digest = hashlib.sha1(canonical.encode("utf-8")).hexdigest()
    return f"{KEY_PREFIX}:q:{table.lower()}:v{version}:{digest}"


class CachedSQL:
    """SQL 문을 실행하되, SELECT 결과는 RedisStore 에 캐시한다.

    store 는 store.RedisStore / store2.RedisStore 어느 쪽이든 된다 (get, set, incr 만 사용).
    """

    def __init__(
        self,
        store,
        db: CSVDatabase | None = None,
        ttl: int = DEFAULT_TTL,
        ttl_jitter: int = DEFAULT_TTL_JITTER,
        rng: random.Random | None = None,
    ):
        if ttl <= 0:
            raise ValueError("ttl must be positive")
        if ttl_jitter < 0:
            raise ValueError("ttl_jitter must not be negative")
        self.store = store
        self.db = db if db is not None else CSVDatabase()
        self.executor = Executor(self.db)
        self.ttl = ttl
        self.ttl_jitter = ttl_jitter
        self._rng = rng if rng is not None else random.Random()

        # CSVDatabase 는 스레드 안전하지 않다 (인덱스 dict, 파일 append). FastAPI 는 def 핸들러를
        # 스레드풀에서 동시에 돌리므로 DB 를 만지는 일은 이 락 하나로 줄 세운다.
        # 캐시 hit 는 이 락을 잡지 않는다 → hit 가 많을수록 DB 락 대기도 줄어든다.
        self._db_lock = threading.Lock()

        self._stats_lock = threading.Lock()
        self._hits = 0
        self._misses = 0
        self._bypassed = 0
        self._invalidations = 0

    # ------------------------------------------------------------------
    # 실행
    # ------------------------------------------------------------------
    def run(self, source: str, use_cache: bool = True) -> list[dict]:
        """SQL 스크립트(문장 여러 개 가능)를 실행하고 문장마다 결과 dict 를 돌려준다.

        sqlparser.run_script 처럼 한 문장이 실패해도 다음 문장은 계속 실행하고, 실패한 문장은
        {"type": "error", ...} 로 돌려준다. 토큰화 단계 오류는 스크립트 전체를 읽을 수 없으므로 SQLError 를 던진다.
        결과마다 elapsed_ms(그 문장을 서버에서 처리한 시간, 밀리초)가 붙는다.
        """
        statements = Parser(source).iter_statements()
        results = []
        while True:
            start = time.perf_counter()   # 파싱 시간까지 그 문장의 처리 시간에 넣는다
            item = next(statements, None)
            if item is None:
                break
            if isinstance(item, SQLError):
                result = {"type": "error", "statement": None, "error": str(item)}
            else:
                try:
                    result = self.execute(item, use_cache=use_cache)
                except SQLError as e:
                    message = str(e) if e.line is not None else f"{item.line}번째 줄: {e}"
                    result = {"type": "error", "statement": item.text, "error": message}
            result["elapsed_ms"] = round((time.perf_counter() - start) * 1000, 3)
            results.append(result)
        return results

    def execute(self, stmt: Statement, use_cache: bool = True) -> dict:
        if isinstance(stmt, SelectStatement):
            return self._select(stmt, use_cache)

        result = self.execute_uncached(stmt)
        if isinstance(result, InsertResult):
            return {"type": "insert", "statement": stmt.text, "table": result.table,
                    "count": result.count, "ids": result.ids}
        return {"type": "create", "statement": stmt.text, "table": result.table,
                "columns": result.columns, "created": result.created}

    def execute_uncached(self, stmt: Statement) -> CreateResult | InsertResult | SelectResult:
        """쿼리 결과 캐시를 거치지 않고 DB 에서 바로 실행해 Executor 의 결과 객체를 그대로 돌려준다.

        자기만의 캐시 키를 따로 쓰는 계층(예: shortener 의 short:<code>)이 DB 를 읽고 쓸 때 쓴다.
        - SELECT: 캐시를 읽지도 쓰지도 않고, hit/miss/bypass 통계에도 넣지 않는다
        - 쓰기: DB 에 먼저 쓰고, 성공했을 때만 같은 락 안에서 테이블 버전을 올린다
                (그래야 /sql 로 캐시해 둔 같은 테이블의 SELECT 결과가 낡은 채로 남지 않는다)
        """
        with self._db_lock:
            result = self.executor.execute(stmt)
            if isinstance(result, InsertResult) or (isinstance(result, CreateResult) and result.created):
                self._invalidate(result.table)
        return result

    def _select(self, stmt: SelectStatement, use_cache: bool) -> dict:
        if not use_cache:   # 성능 비교용: 캐시를 읽지도 쓰지도 않음
            with self._db_lock:
                result = self.executor.execute_select(stmt)
            self._count("bypass")
            return self._select_payload(stmt, self._to_cached(result), "bypass")

        # 1) 캐시 확인 (DB 락 없이)
        key = query_key(stmt.table, self._version(stmt.table), stmt)
        cached = self.store.get(key)
        if cached is not None:
            self._count("hit")
            return self._select_payload(stmt, json.loads(cached), "hit")

        # 2) miss → DB 락을 잡고 다시 확인한 뒤 읽는다
        with self._db_lock:
            # 락을 기다리는 동안 INSERT 로 버전이 바뀌었을 수 있으니 키를 다시 만든다
            key = query_key(stmt.table, self._version(stmt.table), stmt)
            # 같은 쿼리를 먼저 처리한 요청이 이미 채워 놨으면 DB 를 또 읽지 않는다 (single-flight)
            cached = self.store.get(key)
            if cached is not None:
                self._count("hit")
                return self._select_payload(stmt, json.loads(cached), "hit")

            data = self._to_cached(self.executor.execute_select(stmt))  # 테이블이 없는 등 오류면 캐시하지 않음
            data["sql"] = stmt.text  # 캐시 키 목록(/sql/cache)에서 어떤 쿼리의 결과인지 보여주기 위함
            self.store.set(key, json.dumps(data, ensure_ascii=False), ttl=self._next_ttl())
        self._count("miss")
        return self._select_payload(stmt, data, "miss")

    # ------------------------------------------------------------------
    # 버전 / TTL
    # ------------------------------------------------------------------
    def _version(self, table: str) -> str:
        key = version_key(table)
        version = self.store.get(key)
        if version is None:
            # 처음 쓰는 테이블이거나 FLUSHALL/DEL 로 버전 키가 지워진 경우.
            # 1 부터 다시 세면, 지워지기 전 세대의 v1 결과가 TTL 안에 남아 있을 때 그걸 읽게 된다.
            # 그래서 현재 시각(ns)으로 새 세대를 시작한다. nx=True 라 동시에 와도 한 값만 들어간다.
            self.store.set(key, str(time.time_ns()), nx=True)
            version = self.store.get(key)
        return version

    def _invalidate(self, table: str) -> None:
        self._version(table)                 # 버전 키가 없으면 새 세대로 만든 뒤
        self.store.incr(version_key(table))  # 1 올린다 → 이 테이블의 이전 결과는 전부 안 쓰임
        with self._stats_lock:
            self._invalidations += 1

    def _next_ttl(self) -> int:
        return self.ttl + self._rng.randint(0, self.ttl_jitter)

    # ------------------------------------------------------------------
    # 결과 모양 / 통계
    # ------------------------------------------------------------------
    @staticmethod
    def _to_cached(result: SelectResult) -> dict:
        return {"columns": result.columns, "rows": result.rows, "used_index": result.used_index}

    @staticmethod
    def _select_payload(stmt: SelectStatement, data: dict, cache: str) -> dict:
        return {"type": "select", "statement": stmt.text, "columns": data["columns"],
                "rows": data["rows"], "count": len(data["rows"]),
                "used_index": data["used_index"], "cache": cache}

    def _count(self, kind: str) -> None:
        with self._stats_lock:
            if kind == "hit":
                self._hits += 1
            elif kind == "miss":
                self._misses += 1
            else:
                self._bypassed += 1

    # ------------------------------------------------------------------
    # 워밍업
    # ------------------------------------------------------------------
    def warm_up(self) -> list[dict]:
        """모든 테이블의 id 인덱스(B+ 트리)를 미리 만든다. 서버를 켤 때 한 번 부른다.

        인덱스는 메모리에만 있어서, 워밍업을 안 하면 서버를 켠 뒤 그 테이블에 처음 들어온
        id 조회(또는 INSERT)가 CSV 전체 읽기 + 트리 삽입 시간(50만 행이면 약 1초)을 대신 기다린다.
        한 테이블에서 오류가 나도(id 가 정수가 아님 등) 서버는 켜져야 하므로, 오류는 결과에 담고 다음 테이블로 넘어간다.

        돌려주는 값: 테이블마다 {"table", "rows"(인덱스에 들어간 행 수, id 컬럼이 없으면 None), "elapsed_ms"}
                     오류면 {"table", "error", "elapsed_ms"}
        """
        report = []
        for table in self.db.tables():
            start = time.perf_counter()
            try:
                with self._db_lock:   # 요청 처리와 겹쳐도 안전하도록 다른 DB 작업과 같은 락을 쓴다
                    index = self.db.index(table)
                item = {"table": table, "rows": len(index.tree) if index is not None else None}
            except (SQLError, OSError) as e:
                item = {"table": table, "error": str(e)}
            item["elapsed_ms"] = round((time.perf_counter() - start) * 1000, 1)
            report.append(item)
        return report

    def cache_entries(self) -> dict:
        """지금 RedisStore 에 있는 캐시 키 목록 (웹 페이지의 캐시 키 보기용).

        versions: 테이블 -> 현재 버전
        entries:  쿼리 결과 키마다 테이블, 버전, 남은 TTL, 현재 버전인지(current), 원문 SQL
                  current=false 인 키는 INSERT 로 버전이 바뀌어 더 이상 조회되지 않고 TTL 만 기다리는 키
        """
        keys = [k for k in self.store.keys() if k.startswith(f"{KEY_PREFIX}:")]
        versions = {}
        for key in keys:
            parts = key.split(":")
            if len(parts) == 3 and parts[1] == "ver":
                version = self.store.get(key)
                if version is not None:
                    versions[parts[2]] = version

        entries = []
        for key in keys:
            parts = key.split(":")   # dbcache : q : <테이블> : v<버전> : <해시>  (테이블 이름에는 ':'가 못 들어감)
            if len(parts) != 5 or parts[1] != "q":
                continue
            raw = self.store.get(key)
            ttl = self.store.ttl(key)
            if raw is None or ttl == -2:   # 목록을 읽는 사이에 만료됨
                continue
            table, version = parts[2], parts[3][1:]
            entries.append({
                "key": key,
                "table": table,
                "version": version,
                "current": versions.get(table) == version,
                "ttl": ttl,
                "sql": json.loads(raw).get("sql"),
            })
        entries.sort(key=lambda e: (e["table"], not e["current"], -e["ttl"]))
        return {"versions": versions, "entries": entries}

    def stats(self) -> dict:
        with self._stats_lock:
            lookups = self._hits + self._misses
            return {
                "hits": self._hits,
                "misses": self._misses,
                "bypassed": self._bypassed,
                "invalidations": self._invalidations,
                "hit_rate": round(self._hits / lookups, 4) if lookups else 0.0,
                "ttl": self.ttl,
                "ttl_jitter": self.ttl_jitter,
            }
