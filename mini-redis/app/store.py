from hashtable import HashTable

import re
import threading
import time

# Redis 정수는 64비트 부호 있는 정수(long long)
INT64_MIN = -2**63
INT64_MAX = 2**63 - 1

# Redis 에러 메시지와 동일하게 맞춤 (나중에 RESP "-ERR ..." 응답으로 그대로 쓰기 위함)
NOT_INTEGER_ERR = "value is not an integer or out of range"
OVERFLOW_ERR = "increment or decrement would overflow"
DECR_OVERFLOW_ERR = "decrement would overflow"

# 능동 만료 설정 (Redis의 ACTIVE_EXPIRE_CYCLE_* 값을 따라 함)
ACTIVE_EXPIRE_SAMPLE = 20            # 한 라운드에 검사할 TTL 키 수
ACTIVE_EXPIRE_REPEAT_RATIO = 0.25    # 검사한 키 중 이 비율 이상이 만료됐으면 한 라운드 더
ACTIVE_EXPIRE_TIME_LIMIT = 0.025     # 한 번의 정리에 쓸 최대 시간(초). 만료 키가 아주 많아도 여기서 멈춤

# 공백, '+', 앞자리 0, '_', 유니코드 숫자를 모두 거부 ("0"만 단독 허용)
_INT_RE = re.compile(r"-?(0|[1-9][0-9]*)")


def _parse_int(value):
    """저장된 값을 Redis 규칙대로 엄격하게 정수로 해석. 실패하면 ValueError"""
    if isinstance(value, bool):          # bool은 int의 하위 타입이라 먼저 걸러냄
        raise ValueError(NOT_INTEGER_ERR)
    if isinstance(value, int):           # set(key, 5)처럼 int로 넣은 값도 허용
        n = value
    elif isinstance(value, str) and _INT_RE.fullmatch(value) and value != "-0":
        n = int(value)
    else:
        raise ValueError(NOT_INTEGER_ERR)
    if not INT64_MIN <= n <= INT64_MAX:
        raise ValueError(NOT_INTEGER_ERR)
    return n


def _check_amount(amount):
    """증감량 자체도 64비트 정수여야 함"""
    if isinstance(amount, bool) or not isinstance(amount, int):
        raise ValueError(NOT_INTEGER_ERR)
    if not INT64_MIN <= amount <= INT64_MAX:
        raise ValueError(NOT_INTEGER_ERR)


class RedisStore:
    """
    규칙: 밑줄(_)로 시작하는 내부 헬퍼는 락을 잡지 않는다.
          반드시 public 메서드의 `with self._lock:` 안에서만 호출할 것.
          threading.Lock은 재진입이 안 되므로 public 메서드끼리 서로 호출하면 데드락이 난다.
    """

    def __init__(self, clock=time.time):
        self._data = HashTable()
        self._expires = HashTable()      # key → 만료 시각
        self._lock = threading.Lock()    # 동시 요청 보호
        self._clock = clock              # 테스트에서 가짜 시계를 넣을 수 있게 주입

        self._stop_event = threading.Event()
        self._expire_thread = None

    # ------------------------------------------------------------------
    # 내부 헬퍼 (락을 잡은 상태에서만 호출)
    # ------------------------------------------------------------------
    def _is_expired(self, key):
        exp_time = self._expires.get(key)
        if exp_time is None:
            return False
        cur_time = self._clock()
        return True if (exp_time < cur_time) else False

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

    # ------------------------------------------------------------------
    # 기본 명령: SET / GET / DEL / EXISTS
    # ------------------------------------------------------------------
    def set(self, key, value, ttl=None, nx=False, xx=False):
        """
        SET key value [EX ttl] [NX | XX]
          nx: 키가 없을 때만 씀 / xx: 키가 있을 때만 씀
          썼으면 True(Redis의 OK), 조건 때문에 안 썼으면 False(Redis의 nil)
        NX/XX 판단은 HashTable이 아니라 여기서 함.
        HashTable은 TTL을 모르므로, 만료됐지만 아직 안 지워진 키를 '있는 키'로 잘못 볼 수 있음.
        """
        if nx and xx:
            raise ValueError("syntax error")    # Redis도 NX와 XX를 같이 주면 에러
        if ttl is not None and ttl <= 0:
            raise ValueError("ttl must be positive")
        with self._lock:
            exists = self._exists(key)           # 만료된 키는 여기서 지워지고 False
            if (nx and exists) or (xx and not exists):
                return False                     # 조건 불만족 → 값과 TTL 모두 그대로
            self._data.put(key, value)
            if ttl is not None:
                self._expires.put(key, self._clock() + ttl)
            else:
                self._expires.delete(key)    # Redis SET은 기존 TTL을 지움
            return True

    def get(self, key):
        with self._lock:
            if self._is_expired(key):    # 지연 삭제(lazy expiration)
                self._delete(key)
                return None
            return self._data.get(key)

    def delete(self, *keys):
        """DEL key [key ...] → 실제로 지운 키 개수"""
        with self._lock:
            count = 0
            for key in keys:
                if self._exists(key):    # 이미 만료된 키는 지운 개수에 넣지 않음
                    self._delete(key)
                    count += 1
            return count

    def exists(self, key):
        with self._lock:
            return self._exists(key)

    # ------------------------------------------------------------------
    # TTL 관련: EXPIRE / TTL / PERSIST
    # ------------------------------------------------------------------
    def expire(self, key, seconds):
        """이미 있는 키에 TTL 설정. 키가 없으면 False"""
        with self._lock:
            if not self._exists(key):
                return False
            if seconds <= 0:             # Redis처럼 0 이하면 즉시 삭제
                self._delete(key)
            else:
                self._expires.put(key, self._clock() + seconds)
            return True

    def ttl(self, key):
        """남은 초. 키가 없으면 -2, TTL이 없으면 -1 (Redis 관례)"""
        with self._lock:
            if not self._exists(key):
                return -2
            exp_time = self._expires.get(key)
            if exp_time is None:
                return -1
            return max(0, round(exp_time - self._clock()))

    def persist(self, key):
        """TTL 제거. TTL이 있어서 지웠으면 True"""
        with self._lock:
            if not self._exists(key):
                return False
            return self._expires.delete(key)

    # ------------------------------------------------------------------
    # 원자적 증감: INCR / DECR
    #   get → +1 → set 을 락 하나 안에서 처리해야 동시 요청에서 값이 유실되지 않음
    #   저장은 문자열("11"), 반환은 정수(11) — Redis도 값은 문자열로 저장하고 INCR은 정수 응답을 보냄
    #   검증은 전부 put 전에 끝냄 → 에러가 나면 기존 값이 그대로 남음
    # ------------------------------------------------------------------
    def incr(self, key, amount=1):
        _check_amount(amount)
        with self._lock:
            current = _parse_int(self._data.get(key)) if self._exists(key) else 0
            new_value = current + amount
            if not INT64_MIN <= new_value <= INT64_MAX:
                raise ValueError(OVERFLOW_ERR)
            self._data.put(key, str(new_value))   # TTL은 건드리지 않음 (Redis와 동일)
            return new_value

    def decr(self, key, amount=1):
        _check_amount(amount)
        if amount == INT64_MIN:              # -INT64_MIN은 INT64_MAX보다 1 커서 표현 불가
            raise ValueError(DECR_OVERFLOW_ERR)
        return self.incr(key, -amount)       # incr이 락을 잡으므로 여기서는 잡지 않음

    # ------------------------------------------------------------------
    # 관리용: KEYS / DBSIZE / FLUSHALL
    # ------------------------------------------------------------------
    def keys(self):
        with self._lock:
            return [k for k in self._data.keys() if self._exists(k)]

    def dbsize(self):
        # 정확한 개수를 위해 전체를 훑음 (O(n)). 실제 Redis DBSIZE는 아직 안 지운 만료 키도 셈
        with self._lock:
            self._purge_all_expired()
            return len(self._data)

    def flushall(self):
        with self._lock:
            self._data.clear()
            self._expires.clear()

    # ------------------------------------------------------------------
    # 능동 만료(active expiration)
    #   지연 삭제만 있으면 다시 조회되지 않는 만료 키가 메모리에 계속 남는다.
    #   백그라운드 스레드가 주기적으로 만료 키를 정리한다.
    #
    #   Redis 방식 (전체를 훑지 않음):
    #     1) TTL 있는 키 20개를 무작위로 뽑아 만료된 것을 지운다.
    #     2) 뽑은 것 중 25% 이상이 만료돼 있었다면 → 아직 만료 키가 많다는 뜻이므로 1)을 반복.
    #        25% 미만이면 → 남은 만료 키가 적다고 보고 멈춤 (나머지는 다음 주기나 지연 삭제가 처리)
    #     3) 반복이 길어지면 시간 상한에서 멈춤.
    #   → 키가 백만 개여도 한 번에 하는 일은 "20개 × 몇 라운드"라 락을 오래 잡지 않는다.
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

    def purge_expired(self, sample_size=ACTIVE_EXPIRE_SAMPLE,
                      time_limit=ACTIVE_EXPIRE_TIME_LIMIT):
        """Redis 방식으로 만료 키를 정리하고 지운 개수를 반환. time_limit=None이면 시간 제한 없음"""
        # 시간 상한은 주입된 clock(가짜일 수 있음)이 아니라 실제 경과 시간으로 잼
        start = time.perf_counter()
        total = 0
        while True:
            # 라운드마다 락을 잡았다 풀어서, 정리 중에도 다른 요청이 사이사이 처리될 수 있게 함
            with self._lock:
                sampled, expired = self._expire_round(sample_size)
            total += expired

            if sampled == 0 or expired / sampled < ACTIVE_EXPIRE_REPEAT_RATIO:
                break
            if time_limit is not None and time.perf_counter() - start >= time_limit:
                break
        return total

    def start_active_expire(self, interval=0.1):
        if self._expire_thread is not None:
            return
        self._stop_event.clear()

        def loop():
            # wait()는 interval만큼 기다리다가 stop 신호가 오면 바로 깨어남
            while not self._stop_event.wait(interval):
                self.purge_expired()

        self._expire_thread = threading.Thread(target=loop, daemon=True)
        self._expire_thread.start()

    def stop_active_expire(self):
        if self._expire_thread is None:
            return
        self._stop_event.set()
        self._expire_thread.join()
        self._expire_thread = None
