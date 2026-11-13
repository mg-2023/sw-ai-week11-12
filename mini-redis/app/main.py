"""
mini-redis HTTP API 서버

    실행 (mini-redis 폴더에서):  python app/main.py
    또는:                        python -m uvicorn app.main:app --reload
    API 문서/테스트 페이지:      http://127.0.0.1:8000/docs

계층:  웹사이트(fetch) → [이 파일: HTTP ↔ store 변환] → RedisStore → HashTable
이 파일은 Redis 규칙을 직접 판단하지 않는다. 검증과 동작은 전부 store가 하고,
여기서는 요청을 store 호출로 바꾸고 결과를 JSON으로 돌려주는 일만 한다.
"""

import os
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, StrictInt

# store.py가 `from hashtable import ...`로 import하므로 app/ 폴더를 import 경로에 넣는다.
# 이렇게 하면 app/ 안에서 실행하든 루트에서 `app.main:app`으로 실행하든 동작한다.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from store import RedisStore  # noqa: E402


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


# ----------------------------------------------------------------------
# Swagger UI(/docs) 그룹
#   엔드포인트마다 tags=[...]를 달면 같은 태그끼리 묶여서 보인다.
#   openapi_tags에 적은 순서대로 그룹이 나열되고, description은 그룹 제목 옆에 표시된다.
# ----------------------------------------------------------------------
TAG_BASIC = "기본 명령"
TAG_TTL = "TTL"
TAG_COUNTER = "증감"
TAG_ADMIN = "관리"

OPENAPI_TAGS = [
    {"name": TAG_BASIC, "description": "SET / GET / DEL / EXISTS"},
    {"name": TAG_TTL, "description": "EXPIRE / TTL / PERSIST"},
    {"name": TAG_COUNTER, "description": "INCR / DECR (원자적 증감)"},
    {"name": TAG_ADMIN, "description": "KEYS / DBSIZE / FLUSHALL"},
]


# ----------------------------------------------------------------------
# 앱 생성
#   store를 밖에서 넣을 수 있게 해서, 테스트에서는 가짜 시계를 단 store를 쓸 수 있다.
#   store는 앱 하나당 딱 하나. 요청마다 새로 만들면 데이터가 매번 사라진다.
# ----------------------------------------------------------------------
def create_app(store: RedisStore | None = None) -> FastAPI:
    store = store if store is not None else RedisStore()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store.start_active_expire()     # 서버 켤 때 만료 키 정리 스레드 시작
        yield
        store.stop_active_expire()      # 서버 끌 때 정리

    app = FastAPI(title="mini-redis", lifespan=lifespan, openapi_tags=OPENAPI_TAGS)
    app.state.store = store

    # store는 잘못된 입력에 ValueError를 던진다 (예: "value is not an integer or out of range").
    # 핸들러마다 try/except를 쓰지 않고 여기서 한 번에 400으로 바꾼다.
    @app.exception_handler(ValueError)
    async def value_error_handler(request: Request, exc: ValueError):
        return JSONResponse(status_code=400, content={"detail": str(exc)})

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

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
