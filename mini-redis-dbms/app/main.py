"""
mini-redis HTTP API 서버

    실행 (mini-redis 폴더에서):  python app/main.py
    또는:                        python -m uvicorn app.main:app --reload
    API 문서/테스트 페이지:      http://127.0.0.1:8000/docs

계층:  웹사이트(fetch) → [이 파일: HTTP ↔ store 변환] → RedisStore → HashTable
                    └ /sql → CachedSQL ─ SELECT ─→ RedisStore (캐시)
                                       └ miss / INSERT → Executor → CSV + B+ 트리
                    └ /shorten, /r/{code} → URLShortener ─→ RedisStore (short:<code>)
                                                        └ miss / 생성 → CachedSQL.execute_uncached → links 테이블
이 파일은 Redis 규칙이나 캐시 규칙을 직접 판단하지 않는다. 검증과 동작은 전부 store / sqlcache가 하고,
여기서는 요청을 그 호출로 바꾸고 결과를 JSON으로 돌려주는 일만 한다.
"""

import asyncio
import logging
import os
import sys
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, StrictInt
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# uvicorn이 설정해 둔 로거를 쓰면 "INFO:     ..." 형식으로 서버 시작 로그와 같이 찍힌다
logger = logging.getLogger("uvicorn.error")


# store.py가 `from hashtable import ...`로 import하므로 app/ 폴더를 import 경로에 넣는다.
# 이렇게 하면 app/ 안에서 실행하든 루트에서 `app.main:app`으로 실행하든 동작한다.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from shortener import URLShortener  # noqa: E402
from sqlcache import CachedSQL  # noqa: E402
from sqlparser import SQLError  # noqa: E402
from store import RedisStore  # noqa: E402
# 대기열 방식(store2)이 요청을 거부할 때 던지는 예외. 락 방식(store)을 쓸 때는 발생하지 않으므로
# 위의 RedisStore import를 어느 쪽으로 바꾸든 이 줄은 그대로 둬도 된다.
from store2 import QueueFullError  # noqa: E402


# ----------------------------------------------------------------------
# 요청 body 형식
#   StrictInt: JSON의 true나 "5" 같은 값을 정수로 몰래 바꾸지 않고 422로 거부
# ----------------------------------------------------------------------
class SetBody(BaseModel):
    value: str                      # Redis 값은 문자열
    ttl: StrictInt | None = None    # 초 단위 (SET ... EX ttl)
    nx: bool = False
    xx: bool = False


class ExpireBody(BaseModel):
    seconds: StrictInt


class AmountBody(BaseModel):
    amount: StrictInt = 1


class SQLBody(BaseModel):
    sql: str                  # 문장 여러 개를 ;로 이어서 보내도 됨
    use_cache: bool = True    # False면 SELECT가 캐시를 읽지도 쓰지도 않음 (성능 비교용)


class ShortenBody(BaseModel):
    url: str                  # http:// 또는 https:// 주소만 (검사는 shortener.normalize_url)


class ShortenerSettingsBody(BaseModel):
    prewarm: bool             # True: 생성할 때도 캐시에 SET (방식 A+B), False: 첫 클릭 때만 (방식 B)


# ----------------------------------------------------------------------
# Swagger UI(/docs) 그룹
#   엔드포인트마다 tags=[...]를 달면 같은 태그끼리 묶여서 보인다.
#   openapi_tags에 적은 순서대로 그룹이 나열되고, description은 그룹 제목 옆에 표시된다.
# ----------------------------------------------------------------------
TAG_BASIC = "기본 명령"
TAG_TTL = "TTL"
TAG_COUNTER = "증감"
TAG_ADMIN = "관리"
TAG_SQL = "SQL (DBMS + 캐시)"
TAG_SHORT = "URL 단축"

OPENAPI_TAGS = [
    {"name": TAG_BASIC, "description": "SET / GET / DEL / EXISTS"},
    {"name": TAG_TTL, "description": "EXPIRE / TTL / PERSIST"},
    {"name": TAG_COUNTER, "description": "INCR / DECR (원자적 증감)"},
    {"name": TAG_ADMIN, "description": "KEYS / DBSIZE / FLUSHALL"},
    {"name": TAG_SQL, "description": "CSV DBMS에 SQL 실행. SELECT 결과는 Redis에 캐시 (Cache-aside + 테이블 버전 키)"},
    {"name": TAG_SHORT, "description": "긴 URL → 짧은 URL. links 테이블이 원본, Redis `short:<code>` 키가 캐시 (생성 시 미리 채우기 + Cache-aside)"},
]


# ----------------------------------------------------------------------
# 앱 생성
#   store를 밖에서 넣을 수 있게 해서, 테스트에서는 가짜 시계를 단 store를 쓸 수 있다.
#   store는 앱 하나당 딱 하나. 요청마다 새로 만들면 데이터가 매번 사라진다.
# ----------------------------------------------------------------------
def create_app(store: RedisStore | None = None, sql: CachedSQL | None = None,
               warm_up: bool = True, shortener: URLShortener | None = None) -> FastAPI:
    store = store if store is not None else RedisStore()
    # SQL 캐시는 위 store를 그대로 쓴다 → /keys로 캐시 키(dbcache:...)를 직접 들여다볼 수 있다
    sql = sql if sql is not None else CachedSQL(store)
    # URL 단축도 같은 store(캐시)와 같은 sql(DB 락)을 쓴다 → /keys로 short:<code> 키도 보인다
    shortener = shortener if shortener is not None else URLShortener(store, sql)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store.start_active_expire()     # 서버 켤 때 만료 키 정리 스레드 시작
        if warm_up:
            # 모든 테이블의 id 인덱스를 미리 만든다. 끝날 때까지 서버가 요청을 받지 않으므로
            # 첫 id 조회가 인덱스 생성 시간(50만 행이면 약 1초)을 기다리지 않는다.
            # 시간이 걸리는 동기 작업이라 별도 스레드에서 돌려 이벤트 루프를 막지 않는다.
            started = time.perf_counter()
            report = await asyncio.to_thread(sql.warm_up)
            for item in report:
                if "error" in item:
                    logger.warning("워밍업 실패: %s (%s)", item["table"], item["error"])
                elif item["rows"] is None:
                    logger.info("워밍업: %s - id 컬럼 없음, 인덱스 안 만듦", item["table"])
                else:
                    logger.info("워밍업: %s - id 인덱스 %d행, %.1f ms", item["table"], item["rows"], item["elapsed_ms"])
            logger.info("워밍업 완료: 테이블 %d개, %.1f ms", len(report), (time.perf_counter() - started) * 1000)
        yield
        store.stop_active_expire()      # 서버 끌 때 정리

    app = FastAPI(title="mini-redis", lifespan=lifespan, openapi_tags=OPENAPI_TAGS)
    app.state.store = store
    app.state.sql = sql
    app.state.shortener = shortener

    # store는 잘못된 입력에 ValueError를 던진다 (예: "value is not an integer or out of range").
    # 핸들러마다 try/except를 쓰지 않고 여기서 한 번에 400으로 바꾼다.
    @app.exception_handler(ValueError)
    async def value_error_handler(request: Request, exc: ValueError):
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    # 대기열이 가득 차서 store가 요청을 거부한 경우.
    # 클라이언트 잘못(4xx)이 아니라 서버가 바쁜 것이므로 503, Retry-After로 잠시 뒤 재시도하라고 알려준다.
    @app.exception_handler(QueueFullError)
    async def queue_full_handler(request: Request, exc: QueueFullError):
        return JSONResponse(status_code=503, content={"detail": str(exc)},
                            headers={"Retry-After": "1"})

    # 핸들러를 async가 아닌 일반 def로 둔 이유:
    #   FastAPI가 스레드풀에서 동시에 실행하므로, store의 threading.Lock이 실제로 동시 요청을 보호한다.
    #   (async def 안에서 Lock을 잡으면 이벤트 루프 전체가 멈출 수 있다.)

    # ---------------- 기본 명령: SET / GET / DEL / EXISTS ----------------
    @app.put("/keys/{key}", tags=[TAG_BASIC])
    def set_key(key: str, body: SetBody):
        """SET key value [EX ttl] [NX|XX] — 조건 때문에 안 썼으면 ok=false"""
        ok = store.set(key, body.value, ttl=body.ttl, nx=body.nx, xx=body.xx)
        return {"ok": ok}

    @app.get("/keys/{key}", tags=[TAG_BASIC])
    def get_key(key: str):
        """GET key — 없거나 만료됐으면 404"""
        value = store.get(key)
        if value is None:
            raise HTTPException(status_code=404, detail="not found")
        return {"key": key, "value": value}

    @app.delete("/keys/{key}", tags=[TAG_BASIC])
    def delete_key(key: str):
        """DEL key — 실제로 지운 개수 (0 또는 1)"""
        return {"deleted": store.delete(key)}

    @app.get("/keys/{key}/exists", tags=[TAG_BASIC])
    def exists_key(key: str):
        return {"exists": store.exists(key)}

    # ---------------- TTL: EXPIRE / TTL / PERSIST ----------------
    @app.post("/keys/{key}/expire", tags=[TAG_TTL])
    def expire_key(key: str, body: ExpireBody):
        """EXPIRE key seconds — 키가 없으면 ok=false, 0 이하면 즉시 삭제"""
        return {"ok": store.expire(key, body.seconds)}

    @app.get("/keys/{key}/ttl", tags=[TAG_TTL])
    def ttl_key(key: str):
        """TTL key — 남은 초, 키 없음 -2, TTL 없음 -1"""
        return {"ttl": store.ttl(key)}

    @app.post("/keys/{key}/persist", tags=[TAG_TTL])
    def persist_key(key: str):
        """PERSIST key — TTL이 있어서 지웠으면 ok=true"""
        return {"ok": store.persist(key)}

    # ---------------- 원자적 증감: INCR / DECR ----------------
    #   body를 생략하면 1씩 증감 (INCR key), {"amount": n}을 주면 INCRBY key n
    @app.post("/keys/{key}/incr", tags=[TAG_COUNTER])
    def incr_key(key: str, body: AmountBody | None = None):
        amount = body.amount if body is not None else 1
        return {"value": store.incr(key, amount)}

    @app.post("/keys/{key}/decr", tags=[TAG_COUNTER])
    def decr_key(key: str, body: AmountBody | None = None):
        amount = body.amount if body is not None else 1
        return {"value": store.decr(key, amount)}

    # ---------------- 관리용: KEYS / DBSIZE / FLUSHALL ----------------
    @app.get("/keys", tags=[TAG_ADMIN])
    def list_keys():
        return {"keys": store.keys()}

    @app.get("/dbsize", tags=[TAG_ADMIN])
    def dbsize():
        return {"size": store.dbsize()}

    @app.post("/flushall", tags=[TAG_ADMIN])
    def flushall():
        store.flushall()
        return {"ok": True}

    # ---------------- SQL: DBMS + Redis 캐시 ----------------
    @app.post("/sql", tags=[TAG_SQL])
    def run_sql(body: SQLBody):
        """SQL 실행 — 문장마다 결과를 돌려주고, SELECT 결과에는 cache: hit / miss / bypass가 붙는다.
        한 문장이 실패해도 다음 문장은 계속 실행하며, 실패한 문장은 type=error로 들어간다."""
        start = time.perf_counter()
        try:
            results = sql.run(body.sql, use_cache=body.use_cache)
        except SQLError as e:     # 닫히지 않은 문자열 등, 스크립트 전체를 읽을 수 없는 오류
            raise HTTPException(status_code=400, detail=str(e))
        return {
            "results": results,
            "errors": sum(r["type"] == "error" for r in results),
            "elapsed_ms": round((time.perf_counter() - start) * 1000, 3),   # 서버 처리 시간 (네트워크 제외)
        }

    @app.get("/sql/stats", tags=[TAG_SQL])
    def sql_stats():
        """캐시 hit / miss 횟수, hit률, 무효화(INSERT) 횟수"""
        return sql.stats()

    @app.get("/sql/cache", tags=[TAG_SQL])
    def sql_cache():
        """캐시 키 목록 — 테이블별 현재 버전, 쿼리 결과 키마다 남은 TTL과 현재 버전 여부"""
        return sql.cache_entries()

    # ---------------- URL 단축: links 테이블 + short:<code> 캐시 ----------------
    @app.post("/shorten", status_code=201, tags=[TAG_SHORT])
    def shorten(body: ShortenBody, request: Request):
        """링크 생성 — DB에 INSERT한 뒤, 미리 채우기가 켜져 있으면 캐시에도 SET (prewarmed=true)"""
        link = shortener.shorten(body.url)
        link["short_url"] = f"{str(request.base_url).rstrip('/')}/r/{link['code']}"
        return link

    @app.get("/r/{code}", tags=[TAG_SHORT])
    def follow(code: str):
        """리디렉션 — 302 + Location. 응답 헤더 X-Cache에 hit / miss가 붙는다."""
        url, cache = shortener.resolve(code)
        if url is None:
            raise HTTPException(status_code=404, detail="없는 링크입니다")
        # 301(영구 이동)은 브라우저가 결과를 기억해서 다음 클릭부터 서버에 오지 않는다.
        # 그러면 클릭마다 캐시가 hit인지 miss인지 볼 수 없으므로 302를 쓰고, 브라우저 캐시도 막는다.
        return RedirectResponse(url, status_code=302,
                                headers={"X-Cache": cache, "Cache-Control": "no-store"})

    @app.get("/links", tags=[TAG_SHORT])
    def recent_links(limit: int = 20):
        """최근 링크 목록 (최신순) — 링크마다 캐시에 있는지(cached)와 남은 TTL"""
        return {"links": shortener.recent(max(1, min(limit, 200)))}

    @app.get("/links/{code}", tags=[TAG_SHORT])
    def resolve_link(code: str):
        """/r/{code}와 같은 조회 경로(캐시 → DB)를 거치되, 리디렉션 대신 결과를 JSON으로 돌려준다 (테스트 페이지용)"""
        start = time.perf_counter()
        url, cache = shortener.resolve(code)
        elapsed_ms = round((time.perf_counter() - start) * 1000, 3)
        if url is None:
            raise HTTPException(status_code=404, detail="없는 링크입니다")
        return {"code": code, "url": url, "cache": cache, "elapsed_ms": elapsed_ms}

    @app.delete("/links/{code}/cache", tags=[TAG_SHORT])
    def evict_link(code: str):
        """캐시 키(`short:<code>`)만 지운다 — TTL이 끝난 상황을 재현. DB의 링크는 그대로"""
        return {"deleted": shortener.evict(code)}

    @app.get("/shortener/stats", tags=[TAG_SHORT])
    def shortener_stats():
        """생성 / 미리 채움 / hit / miss / 없는 링크 횟수, hit률, 캐시에 있는 링크 수"""
        return shortener.stats()

    @app.put("/shortener/settings", tags=[TAG_SHORT])
    def shortener_settings(body: ShortenerSettingsBody):
        """미리 채우기 켜기/끄기 — 끄면 첫 클릭이 항상 miss"""
        shortener.set_prewarm(body.prewarm)
        return {"prewarm": shortener.prewarm}

    # ---------------- html 라우팅 / js, css 마운트 ----------------
    @app.get("/", include_in_schema=False)   # /docs 목록에서는 숨김
    def index():
        return FileResponse(os.path.join(BASE_DIR, "static", "index.html"))

    app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
