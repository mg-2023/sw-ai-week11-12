"""
asyncio 대기열(Queue) 방식의 RedisStore

store.py와 public API(메서드 이름, 인자, 반환값, 예외)가 같아서 import 한 줄로 바꿔 쓸 수 있다.
    from store import RedisStore     # 락 방식
    from store2 import RedisStore    # 대기열 방식

store.py(락 방식)의 문제:
    여러 스레드가 동시에 threading.Lock을 기다리면, 락이 풀렸을 때 누가 먼저 잡을지는 OS 마음이다.
    → 먼저 온 요청이 먼저 처리된다는 보장이 없다.

이 파일(대기열 방식):
    - 전용 스레드 하나에서 asyncio 이벤트 루프를 돌린다.
    - 모든 명령은 asyncio.Queue에 (함수, 인자, 결과 future) 형태로 들어간다.
    - 워커 코루틴 하나가 큐에서 하나씩 꺼내 순서대로 실행한다.
      → 데이터를 만지는 건 워커 하나뿐이므로 락이 필요 없고, 들어온 순서(FIFO) = 처리 순서.
    - 큐가 가득 차 있으면 기다리지 않고 바로 QueueFullError로 거부한다.
      (Redis가 maxclients를 넘으면 연결을 거부하는 것과 비슷한 "부하 차단")

    호출 흐름 (예: store.set("a", "1")):
        호출 스레드 ──call_soon_threadsafe──▶ 이벤트 루프: put_nowait(작업)   ─ 가득 차면 QueueFullError
            │                                      │
            │ (결과가 나올 때까지 대기)             ▼
            ◀──────── future.set_result ──── 워커: 큐에서 꺼내 실행
"""

from hashtable import HashTable

import asyncio
import concurrent.futures
import threading
import time

# store.py와 같은 상수/검증 함수를 그대로 사용 (Redis 규칙은 한 곳에서만 관리)
from store import (  # noqa: F401  (INT64_*, *_ERR는 store.py처럼 여기서도 import할 수 있게 다시 내보냄)
    ACTIVE_EXPIRE_REPEAT_RATIO,
    ACTIVE_EXPIRE_SAMPLE,
    ACTIVE_EXPIRE_TIME_LIMIT,
    DECR_OVERFLOW_ERR,
    INT64_MAX,
    INT64_MIN,
    NOT_INTEGER_ERR,
    OVERFLOW_ERR,
    _check_amount,
    _parse_int,
)

DEFAULT_MAX_QUEUE_SIZE = 1024    # 대기열에 동시에 쌓일 수 있는 최대 요청 수


class QueueFullError(Exception):
    """대기열이 가득 차서 요청을 거부함 (HTTP로는 503 Service Unavailable에 해당)"""

    def __init__(self, max_size):
        super().__init__(f"server busy: request queue is full (max {max_size})")
        self.max_size = max_size


class StoreClosedError(RuntimeError):
    """close()된 store에 요청함"""


class RedisStore:
    """
    규칙: 밑줄(_)로 시작하는 내부 헬퍼(_set, _get, ...)는 워커(이벤트 루프 스레드)에서만 실행된다.
          public 메서드는 작업을 큐에 넣고 결과를 기다리기만 한다.
          → 워커 안에서 public 메서드를 부르면 자기 자신을 기다리게 되어 멈추므로 막아 둠.
    """

    def __init__(self, clock=time.time, max_queue_size=DEFAULT_MAX_QUEUE_SIZE):
        if max_queue_size <= 0:
            # asyncio.Queue는 0 이하를 "무제한"으로 보는데, 그러면 거부 기능이 사라짐
            raise ValueError("max_queue_size must be positive")
        self._data = HashTable()
        self._expires = HashTable()      # key → 만료 시각
        self._clock = clock              # 테스트에서 가짜 시계를 넣을 수 있게 주입
        self._max_queue_size = max_queue_size

        self._closed = False
        # close()와 요청 등록이 엇갈려 요청이 영영 응답을 못 받는 일을 막기 위한 락.
        # 처리 순서를 정하는 락이 아니라 "닫혔는지 확인 + 루프에 등록"을 한 덩어리로 묶을 뿐이라 아주 잠깐만 잡는다.
        self._closing_lock = threading.Lock()
        self._expire_task = None         # 능동 만료 asyncio Task

        # 이벤트 루프 전용 스레드 시작. 큐와 워커는 그 루프 안에서 만들어야 하므로 준비될 때까지 기다림
        self._loop = asyncio.new_event_loop()
        self._ready = threading.Event()
        self._thread = threading.Thread(target=self._run_loop, name="redis-store-loop", daemon=True)
        self._thread.start()
        self._ready.wait()

    # ------------------------------------------------------------------
    # 이벤트 루프 / 대기열 / 워커
    # ------------------------------------------------------------------
    def _run_loop(self):
        asyncio.set_event_loop(self._loop)
        self._queue = asyncio.Queue(maxsize=self._max_queue_size)
        self._worker_task = self._loop.create_task(self._worker())
        self._ready.set()
        self._loop.run_forever()

    async def _worker(self):
        """큐에서 하나씩 꺼내 순서대로 실행. 데이터를 만지는 유일한 곳"""
        while True:
            fn, args, future = await self._queue.get()
            try:
                if future.cancelled():
                    continue
                try:
                    result = fn(*args)
                except Exception as exc:      # ValueError 등은 호출한 쪽으로 그대로 전달
                    future.set_exception(exc)
                else:
                    future.set_result(result)
            finally:
                self._queue.task_done()
            # 큐가 비어 있지 않으면 get()은 양보 없이 바로 반환하므로, 여기서 한 번 양보해야
            # 그 사이 도착한 요청들의 enqueue 콜백(과 능동 만료 코루틴)이 실행되어 큐에 반영된다
            await asyncio.sleep(0)

    def _submit(self, fn, *args):
        """다른 스레드에서 호출: 작업을 큐에 넣고 결과가 나올 때까지 기다린다"""
        if threading.current_thread() is self._thread:
            raise RuntimeError("public RedisStore methods must not be called from the store's worker")
        future = concurrent.futures.Future()

        def enqueue():                 # 이벤트 루프 스레드에서 실행됨
            try:
                self._queue.put_nowait((fn, args, future))
            except asyncio.QueueFull:
                future.set_exception(QueueFullError(self._max_queue_size))

        # call_soon_threadsafe로 등록한 콜백은 등록된 순서대로 실행된다 → 도착 순서 = 큐에 들어가는 순서
        with self._closing_lock:
            if self._closed:
                raise StoreClosedError("store is closed")
            self._loop.call_soon_threadsafe(enqueue)
        return future.result()

    async def _submit_async(self, fn, *args):
        """이벤트 루프 안(능동 만료 코루틴)에서 호출. 큐가 차 있으면 거부하지 않고 자리가 날 때까지 기다림"""
        future = self._loop.create_future()
        await self._queue.put((fn, args, future))
        return await future

    def _run_in_loop(self, coro):
        """다른 스레드에서 코루틴을 이벤트 루프에 맡기고 결과를 기다림 (큐를 거치지 않는 관리용)"""
        if self._closed:
            coro.close()
            raise StoreClosedError("store is closed")
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result()

    @property
    def queue_size(self):
        """지금 대기열에 쌓여 있는 요청 수 (모니터링용, 대략적인 값)"""
        return self._queue.qsize()

    @property
    def max_queue_size(self):
        return self._max_queue_size

    def close(self):
        """능동 만료와 이벤트 루프를 멈춘다. 아직 처리 안 된 요청은 StoreClosedError로 끝냄"""
        if self._closed:
            return
        self.stop_active_expire()

        async def finish():
            self._worker_task.cancel()
            try:
                await self._worker_task      # 워커가 실제로 끝날 때까지 기다림
            except asyncio.CancelledError:
                pass
            while not self._queue.empty():
                _, _, future = self._queue.get_nowait()
                if not future.done():
                    future.set_exception(StoreClosedError("store is closed"))
            self._loop.stop()

        def shutdown():
            self._shutdown_task = self._loop.create_task(finish())

        with self._closing_lock:
            self._closed = True
            # 이미 등록된 요청 콜백들 뒤에 shutdown이 붙으므로, 그 요청들은 큐에 들어간 뒤 아래에서 정리된다
            self._loop.call_soon_threadsafe(shutdown)
        self._thread.join()
        self._loop.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        self.close()

    # ------------------------------------------------------------------
    # 내부 헬퍼 (워커에서만 실행)
    # ------------------------------------------------------------------
    def _is_expired(self, key):
        exp_time = self._expires.get(key)
        if exp_time is None:
            return False
        return exp_time < self._clock()

    def _delete(self, key):
        deleted = self._data.delete(key)
        exp_deleted = self._expires.delete(key)
        return deleted or exp_deleted

    def _exists(self, key):
        # 만료된 키는 이 시점에 지우고(지연 삭제) 없는 키로 취급
        if self._is_expired(key):
            self._delete(key)
            return False
        return key in self._data

    def _set(self, key, value, ttl, nx, xx):
        exists = self._exists(key)           # 만료된 키는 여기서 지워지고 False
        if (nx and exists) or (xx and not exists):
            return False                     # 조건 불만족 → 값과 TTL 모두 그대로
        self._data.put(key, value)
        if ttl is not None:
            self._expires.put(key, self._clock() + ttl)
        else:
            self._expires.delete(key)        # Redis SET은 기존 TTL을 지움
        return True

    def _get(self, key):
        if self._is_expired(key):            # 지연 삭제(lazy expiration)
            self._delete(key)
            return None
        return self._data.get(key)

    def _delete_many(self, keys):
        count = 0
        for key in keys:
            if self._exists(key):            # 이미 만료된 키는 지운 개수에 넣지 않음
                self._delete(key)
                count += 1
        return count

    def _expire(self, key, seconds):
        if not self._exists(key):
            return False
        if seconds <= 0:                     # Redis처럼 0 이하면 즉시 삭제
            self._delete(key)
        else:
            self._expires.put(key, self._clock() + seconds)
        return True

    def _ttl(self, key):
        if not self._exists(key):
            return -2
        exp_time = self._expires.get(key)
        if exp_time is None:
            return -1
        return max(0, round(exp_time - self._clock()))

    def _persist(self, key):
        if not self._exists(key):
            return False
        return self._expires.delete(key)

    def _incr(self, key, amount):
        # get → +1 → set 이 워커 안에서 한 번에 실행되므로 중간에 다른 요청이 끼어들 수 없음
        current = _parse_int(self._data.get(key)) if self._exists(key) else 0
        new_value = current + amount
        if not INT64_MIN <= new_value <= INT64_MAX:
            raise ValueError(OVERFLOW_ERR)
        self._data.put(key, str(new_value))  # TTL은 건드리지 않음 (Redis와 동일)
        return new_value

    def _keys(self):
        return [k for k in self._data.keys() if self._exists(k)]

    def _dbsize(self):
        self._purge_all_expired()
        return len(self._data)

    def _flushall(self):
        self._data.clear()
        self._expires.clear()

    # ------------------------------------------------------------------
    # 기본 명령: SET / GET / DEL / EXISTS
    #   인자 검증처럼 데이터를 안 보는 일은 큐에 넣기 전에 호출한 쪽에서 끝낸다 (워커 부담 줄이기)
    # ------------------------------------------------------------------
    def set(self, key, value, ttl=None, nx=False, xx=False):
        """
        SET key value [EX ttl] [NX | XX]
          nx: 키가 없을 때만 씀 / xx: 키가 있을 때만 씀
          썼으면 True(Redis의 OK), 조건 때문에 안 썼으면 False(Redis의 nil)
        """
        if nx and xx:
            raise ValueError("syntax error")    # Redis도 NX와 XX를 같이 주면 에러
        if ttl is not None and ttl <= 0:
            raise ValueError("ttl must be positive")
        return self._submit(self._set, key, value, ttl, nx, xx)

    def get(self, key):
        return self._submit(self._get, key)

    def delete(self, *keys):
        """DEL key [key ...] → 실제로 지운 키 개수"""
        return self._submit(self._delete_many, keys)

    def exists(self, key):
        return self._submit(self._exists, key)

    # ------------------------------------------------------------------
    # TTL 관련: EXPIRE / TTL / PERSIST
    # ------------------------------------------------------------------
    def expire(self, key, seconds):
        """이미 있는 키에 TTL 설정. 키가 없으면 False"""
        return self._submit(self._expire, key, seconds)

    def ttl(self, key):
        """남은 초. 키가 없으면 -2, TTL이 없으면 -1 (Redis 관례)"""
        return self._submit(self._ttl, key)

    def persist(self, key):
        """TTL 제거. TTL이 있어서 지웠으면 True"""
        return self._submit(self._persist, key)

    # ------------------------------------------------------------------
    # 원자적 증감: INCR / DECR
    # ------------------------------------------------------------------
    def incr(self, key, amount=1):
        _check_amount(amount)
        return self._submit(self._incr, key, amount)

    def decr(self, key, amount=1):
        _check_amount(amount)
        if amount == INT64_MIN:              # -INT64_MIN은 INT64_MAX보다 1 커서 표현 불가
            raise ValueError(DECR_OVERFLOW_ERR)
        return self._submit(self._incr, key, -amount)

    # ------------------------------------------------------------------
    # 관리용: KEYS / DBSIZE / FLUSHALL
    # ------------------------------------------------------------------
    def keys(self):
        return self._submit(self._keys)

    def dbsize(self):
        # 정확한 개수를 위해 전체를 훑음 (O(n))
        return self._submit(self._dbsize)

    def flushall(self):
        self._submit(self._flushall)

    # ------------------------------------------------------------------
    # 능동 만료(active expiration)
    #   store.py와 같은 Redis 방식(20개 샘플 → 25% 이상 만료면 반복 → 시간 상한).
    #   차이점: 한 라운드가 큐의 작업 하나라서, 라운드 사이사이에 먼저 와 있던 요청들이 처리된다.
    #   능동 만료는 별도 스레드가 아니라 같은 이벤트 루프의 코루틴으로 돈다.
    # ------------------------------------------------------------------
    def _expire_round(self, sample_size):
        """한 라운드: 무작위 sample_size개를 검사해 만료된 것을 삭제. (검사 수, 삭제 수) 반환"""
        now = self._clock()
        sampled = self._expires.sample(sample_size)
        expired = 0
        for key, exp_time in sampled:
            if exp_time < now:
                self._delete(key)
                expired += 1
        return len(sampled), expired

    def _purge_all_expired(self):
        """전체를 훑어 만료 키를 모두 삭제 (O(n)). 정확한 결과가 필요한 dbsize 전용"""
        now = self._clock()
        removed = 0
        for key, exp_time in self._expires.items():   # items()는 복사본이라 순회 중 삭제 OK
            if exp_time < now:
                self._delete(key)
                removed += 1
        return removed

    @staticmethod
    def _should_continue(sampled, expired, start, time_limit):
        if sampled == 0 or expired / sampled < ACTIVE_EXPIRE_REPEAT_RATIO:
            return False
        if time_limit is not None and time.perf_counter() - start >= time_limit:
            return False
        return True

    def purge_expired(self, sample_size=ACTIVE_EXPIRE_SAMPLE,
                      time_limit=ACTIVE_EXPIRE_TIME_LIMIT):
        """Redis 방식으로 만료 키를 정리하고 지운 개수를 반환. time_limit=None이면 시간 제한 없음"""
        start = time.perf_counter()
        total = 0
        while True:
            sampled, expired = self._submit(self._expire_round, sample_size)
            total += expired
            if not self._should_continue(sampled, expired, start, time_limit):
                return total

    async def _active_expire_loop(self, interval):
        while True:
            await asyncio.sleep(interval)
            start = time.perf_counter()
            while True:
                sampled, expired = await self._submit_async(self._expire_round, ACTIVE_EXPIRE_SAMPLE)
                if not self._should_continue(sampled, expired, start, ACTIVE_EXPIRE_TIME_LIMIT):
                    break

    def start_active_expire(self, interval=0.1):
        if self._expire_task is not None:
            return

        async def create():                  # asyncio Task는 루프 안에서 만들어야 함
            return asyncio.create_task(self._active_expire_loop(interval))

        self._expire_task = self._run_in_loop(create())

    def stop_active_expire(self):
        if self._expire_task is None:
            return
        task, self._expire_task = self._expire_task, None

        async def cancel_and_wait():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        self._run_in_loop(cancel_and_wait())
