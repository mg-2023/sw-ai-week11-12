"""
URL 단축 서비스 — DB(links 테이블)가 원본, RedisStore 는 링크 하나당 키 하나인 캐시

    POST /shorten ─→ [이 파일: URLShortener.shorten]
                       1) INSERT INTO links (url, created_at) → id 자동 부여 (CSV + B+ 트리)   ← 영구 보존
                       2) 미리 채우기가 켜져 있으면 SET short:<code> <url> EX ttl              ← 방식 A
    GET /r/<code> ─→ [URLShortener.resolve]
                       1) GET short:<code> → 있으면(hit) 끝
                       2) 없으면(miss) code 를 id 로 되돌려
                          SELECT url FROM links WHERE id = N (B+ 트리)
                          → SET short:<code> <url> EX ttl                                     ← 방식 B
                     → 302 Location: <url>

짧은 코드 = id 의 base62 표기
    id 125 → "21" (125 = 2×62 + 1). code 에서 id 를 바로 계산할 수 있으므로 code 를 따로 저장하지 않고,
    miss 가 나도 id 조건 SELECT 라서 CSV 전체를 읽지 않고 B+ 트리에서 바로 찾는다.

CachedSQL 의 쿼리 결과 캐시(테이블 버전 키)를 쓰지 않는 이유
    그 캐시는 INSERT 마다 테이블 버전을 올려서 그 테이블의 SELECT 결과를 전부 버린다.
    여기서는 링크를 하나 만들 때마다 다른 링크들의 캐시까지 전부 버려지게 된다.
    링크는 한 번 만들면 바뀌지 않으므로 버릴 이유가 없다. 그래서 short:<code> 키를 직접 GET/SET 한다.
    (DB 접근은 CachedSQL.execute_uncached 로 해서 DB 락은 /sql 과 같이 쓴다)

순서: DB 에 먼저 쓰고, 그다음 Redis
    Redis SET 이 실패해도 링크는 DB 에 있으므로 다음 클릭이 miss 로 DB 에서 읽어 다시 채운다.
    반대 순서면 DB INSERT 가 실패했을 때 DB 에 없는 링크가 TTL 동안 캐시에서만 동작한다.

TTL
    링크는 바뀌지 않으므로 TTL 은 정합성이 아니라 메모리 관리용이다.
    안 쓰이는 링크는 만료되어 빠지고, 자주 쓰이는 링크는 만료되어도 다음 클릭에 다시 채워진다.
"""

from __future__ import annotations

import random
import threading
import time
from datetime import datetime
from urllib.parse import urlsplit

from sqlcache import CachedSQL
from sqlparser import Parser, SQLError, Statement

TABLE = "links"
KEY_PREFIX = "short"
DEFAULT_TTL = 3600         # 초
DEFAULT_TTL_JITTER = 60    # 한꺼번에 만든 링크들이 같은 순간 만료되지 않게 0~이 값(초)을 더한다
MAX_URL_LENGTH = 2048

ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
_DIGIT = {ch: i for i, ch in enumerate(ALPHABET)}
MAX_CODE_LENGTH = 11       # 62^11 > 2^63 이므로 이보다 긴 code 는 받지 않는다


# ----------------------------------------------------------------------
# base62
# ----------------------------------------------------------------------
def encode_id(n: int) -> str:
    if n < 0:
        raise ValueError("id must not be negative")
    if n == 0:
        return ALPHABET[0]
    digits = []
    while n:
        n, r = divmod(n, 62)
        digits.append(ALPHABET[r])
    return "".join(reversed(digits))


def decode_code(code: str) -> int | None:
    """code → id. 형식이 틀렸으면 None.

    "021" 처럼 앞에 0 이 붙은 code 도 같은 id 로 풀리지만 받지 않는다.
    한 링크에 code 가 여러 개 생기면 캐시 키도 여러 개가 되기 때문이다.
    """
    if not code or len(code) > MAX_CODE_LENGTH or any(ch not in _DIGIT for ch in code):
        return None
    if len(code) > 1 and code[0] == ALPHABET[0]:
        return None
    n = 0
    for ch in code:
        n = n * 62 + _DIGIT[ch]
    return n


def cache_key(code: str) -> str:
    return f"{KEY_PREFIX}:{code}"


# ----------------------------------------------------------------------
# 입력 검사
# ----------------------------------------------------------------------
def normalize_url(raw: str) -> str:
    """단축할 수 있는 URL 인지 검사하고 앞뒤 공백을 뗀 값을 돌려준다. 안 되면 ValueError (API 에서 400).

    http / https 만 받는다. javascript:alert(1) 같은 주소로 리디렉션하면 보안 문제가 되기 때문이다.
    """
    url = raw.strip()
    if not url:
        raise ValueError("URL 을 입력해 주세요")
    if len(url) > MAX_URL_LENGTH:
        raise ValueError(f"URL 은 {MAX_URL_LENGTH}자까지만 받습니다")
    if any(ch.isspace() or ord(ch) < 32 or ord(ch) == 127 for ch in url):
        raise ValueError("URL 에 공백이나 제어 문자를 넣을 수 없습니다")
    try:
        parts = urlsplit(url)
        host = parts.hostname
    except ValueError:   # http://[ 처럼 대괄호가 안 닫힌 주소 등
        raise ValueError("URL 형식이 올바르지 않습니다") from None
    if parts.scheme.lower() not in ("http", "https") or not host:
        raise ValueError("http:// 또는 https:// 로 시작하는 주소만 단축할 수 있습니다")
    return url


def sql_string(value: str) -> str:
    """SQL 문자열 리터럴로 감싼다. 작은따옴표는 '' 로 바꾼다 (sqlparser 토크나이저 규칙)"""
    return "'" + value.replace("'", "''") + "'"


def parse_one(source: str) -> Statement:
    item = next(Parser(source).iter_statements())
    if isinstance(item, SQLError):
        raise item
    return item


# ----------------------------------------------------------------------
# 서비스
# ----------------------------------------------------------------------
class URLShortener:
    """링크 생성(DB INSERT + 미리 채우기)과 조회(Cache-aside)

    store 는 RedisStore(get, set, delete, ttl, keys 사용), sql 은 DB 를 같이 쓰는 CachedSQL.
    prewarm=True 면 방식 A+B(생성할 때도 SET), False 면 방식 B 만(첫 클릭 때 SET).
    """

    def __init__(
        self,
        store,
        sql: CachedSQL,
        ttl: int = DEFAULT_TTL,
        ttl_jitter: int = DEFAULT_TTL_JITTER,
        prewarm: bool = True,
        clock=time.time,
        rng: random.Random | None = None,
    ):
        if ttl <= 0:
            raise ValueError("ttl must be positive")
        if ttl_jitter < 0:
            raise ValueError("ttl_jitter must not be negative")
        self.store = store
        self.sql = sql
        self.ttl = ttl
        self.ttl_jitter = ttl_jitter
        self.prewarm = prewarm
        self._clock = clock
        self._rng = rng if rng is not None else random.Random()

        # links 테이블은 첫 링크를 만들 때 만든다. 서버를 켜기만 해도 data/links.csv 가 생기지 않게 하기 위함
        self._table_lock = threading.Lock()
        self._table_ready = False

        self._stats_lock = threading.Lock()
        self._counts = {"created": 0, "prewarmed": 0, "hits": 0, "misses": 0, "not_found": 0}

    # ------------------------------------------------------------------
    # 생성
    # ------------------------------------------------------------------
    def shorten(self, raw_url: str) -> dict:
        url = normalize_url(raw_url)
        created_at = datetime.fromtimestamp(self._clock()).isoformat(timespec="seconds")
        stmt = parse_one(
            f"INSERT INTO {TABLE} (url, created_at) VALUES ({sql_string(url)}, {sql_string(created_at)});"
        )

        # 1) DB 에 먼저 쓴다. id 를 빼고 넣으므로 DBMS 가 (최대 id + 1)을 부여한다
        self._ensure_table()
        result = self.sql.execute_uncached(stmt)
        link_id = result.ids[0]
        code = encode_id(link_id)

        # 2) 방식 A: 만들자마자 캐시에도 넣어 둔다 → 첫 클릭부터 hit
        prewarmed = False
        if self.prewarm:
            try:
                self.store.set(cache_key(code), url, ttl=self._next_ttl())
                prewarmed = True
            except Exception:
                # 링크는 이미 DB 에 있으므로 생성은 성공이다. 첫 클릭이 miss 로 DB 에서 읽어 채운다.
                # (store2 의 대기열이 가득 찬 경우 등)
                pass

        self._count("created")
        if prewarmed:
            self._count("prewarmed")
        return {"id": link_id, "code": code, "url": url, "created_at": created_at,
                "prewarmed": prewarmed, "sql": stmt.text}

    def _ensure_table(self) -> None:
        if self._table_ready:
            return
        with self._table_lock:
            if not self._table_ready:
                self.sql.execute_uncached(
                    parse_one(f"CREATE TABLE IF NOT EXISTS {TABLE} (id, url, created_at);")
                )
                self._table_ready = True

    # ------------------------------------------------------------------
    # 조회 (Cache-aside)
    # ------------------------------------------------------------------
    def resolve(self, code: str) -> tuple[str | None, str]:
        """code → (원본 URL, "hit" | "miss" | "not_found"). 없는 링크면 URL 이 None."""
        link_id = decode_code(code)
        if link_id is None:
            self._count("not_found")
            return None, "not_found"

        key = cache_key(code)
        url = self.store.get(key)
        if url is not None:
            self._count("hits")
            return url, "hit"

        url = self._load(link_id)
        if url is None:
            self._count("not_found")
            return None, "not_found"
        # 방식 B: 읽은 김에 캐시에 넣는다. 링크는 바뀌지 않으므로 동시에 여러 요청이 miss 나서
        # 각자 SET 해도 같은 값이 들어갈 뿐이다 (CachedSQL 처럼 single-flight 를 할 필요가 없다)
        self.store.set(key, url, ttl=self._next_ttl())
        self._count("misses")
        return url, "miss"

    def _load(self, link_id: int) -> str | None:
        if not self.sql.db.exists(TABLE):
            return None
        result = self.sql.execute_uncached(parse_one(f"SELECT url FROM {TABLE} WHERE id = {link_id};"))
        return result.rows[0][0] if result.rows else None

    # ------------------------------------------------------------------
    # 화면용: 목록 / 캐시 지우기 / 설정 / 통계
    # ------------------------------------------------------------------
    def recent(self, limit: int = 20) -> list[dict]:
        """최근에 만든 링크 limit 개 (최신순)와 각 링크의 캐시 상태. 조회 통계에는 넣지 않는다."""
        if limit <= 0 or not self.sql.db.exists(TABLE):
            return []
        result = self.sql.execute_uncached(parse_one(f"SELECT id, url, created_at FROM {TABLE};"))
        links = []
        for raw_id, url, created_at in reversed(result.rows[-limit:]):
            code = encode_id(int(raw_id))
            ttl = self.store.ttl(cache_key(code))   # -2 = 캐시에 없음
            links.append({"id": int(raw_id), "code": code, "url": url, "created_at": created_at,
                          "cached": ttl != -2, "ttl": ttl if ttl >= 0 else None})
        return links

    def evict(self, code: str) -> int:
        """캐시 키만 지운다 (TTL 이 끝난 상황 재현용). DB 의 링크는 그대로"""
        return self.store.delete(cache_key(code))

    def set_prewarm(self, enabled: bool) -> None:
        self.prewarm = enabled

    def stats(self) -> dict:
        with self._stats_lock:
            c = dict(self._counts)
        lookups = c["hits"] + c["misses"]
        cached = sum(1 for k in self.store.keys() if k.startswith(f"{KEY_PREFIX}:"))
        return {
            **c,
            "hit_rate": round(c["hits"] / lookups, 4) if lookups else 0.0,
            "cached_links": cached,
            "prewarm": self.prewarm,
            "ttl": self.ttl,
            "ttl_jitter": self.ttl_jitter,
        }

    def _next_ttl(self) -> int:
        return self.ttl + self._rng.randint(0, self.ttl_jitter)

    def _count(self, kind: str) -> None:
        with self._stats_lock:
            self._counts[kind] += 1
