"""
mini-redis HTTP API 서버

    실행 (mini-redis 폴더에서):  python app/main.py
    또는:                        python -m uvicorn app.main:app --reload
    API 문서/테스트 페이지:      http://127.0.0.1:8000/docs

계층:  웹사이트(fetch) → [이 파일: HTTP ↔ store 변환] → RedisStore → HashTable
                    └ /sql → CachedSQL ─ SELECT ─→ RedisStore (캐시)
                                       └ miss / INSERT → Executor → CSV + B+ 트리
이 파일은 Redis 규칙이나 캐시 규칙을 직접 판단하지 않는다. 검증과 동작은 전부 store / sqlcache가 하고,
여기서는 요청을 그 호출로 바꾸고 결과를 JSON으로 돌려주는 일만 한다.
"""

import os
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, StrictInt
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


# store.py가 `from hashtable import ...`로 import하므로 app/ 폴더를 import 경로에 넣는다.
# 이렇게 하면 app/ 안에서 실행하든 루트에서 `app.main:app`으로 실행하든 동작한다.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

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

OPENAPI_TAGS = [
    {"name": TAG_BASIC, "description": "SET / GET / DEL / EXISTS"},
    {"name": TAG_TTL, "description": "EXPIRE / TTL / PERSIST"},
    {"name": TAG_COUNTER, "description": "INCR / DECR (원자적 증감)"},
    {"name": TAG_ADMIN, "description": "KEYS / DBSIZE / FLUSHALL"},
    {"name": TAG_SQL, "description": "CSV DBMS에 SQL 실행. SELECT 결과는 Redis에 캐시 (Cache-aside + 테이블 버전 키)"},
]


# ----------------------------------------------------------------------
# 앱 생성
#   store를 밖에서 넣을 수 있게 해서, 테스트에서는 가짜 시계를 단 store를 쓸 수 있다.
#   store는 앱 하나당 딱 하나. 요청마다 새로 만들면 데이터가 매번 사라진다.
# ----------------------------------------------------------------------
def create_app(store: RedisStore | None = None, sql: CachedSQL | None = None) -> FastAPI:
    store = store if store is not None else RedisStore()
    # SQL 캐시는 위 store를 그대로 쓴다 → /keys로 캐시 키(dbcache:...)를 직접 들여다볼 수 있다
    sql = sql if sql is not None else CachedSQL(store)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store.start_active_expire()     # 서버 켤 때 만료 키 정리 스레드 시작
        yield
        store.stop_active_expire()      # 서버 끌 때 정리

    app = FastAPI(title="mini-redis", lifespan=lifespan, openapi_tags=OPENAPI_TAGS)
    app.state.store = store
    app.state.sql = sql

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
        try:
            results = sql.run(body.sql, use_cache=body.use_cache)
        except SQLError as e:     # 닫히지 않은 문자열 등, 스크립트 전체를 읽을 수 없는 오류
            raise HTTPException(status_code=400, detail=str(e))
        return {"results": results, "errors": sum(r["type"] == "error" for r in results)}

    @app.get("/sql/stats", tags=[TAG_SQL])
    def sql_stats():
        """캐시 hit / miss 횟수, hit률, 무효화(INSERT) 횟수"""
        return sql.stats()

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
