from collections.abc import Callable
from dataclasses import dataclass
import math
from threading import Lock
from time import monotonic


@dataclass(frozen=True, slots=True)
class _Entry:
    value: object
    expires_at: float | None

    def expired(self, now: float) -> bool:
        return self.expires_at is not None and now >= self.expires_at


class _HashTable:
    def __init__(self) -> None:
        self._buckets: list[list[tuple[str, _Entry]]] = [[] for _ in range(8)]
        self._size = 0

    def _bucket(self, key: str) -> list[tuple[str, _Entry]]:
        return self._buckets[hash(key) % len(self._buckets)]

    def get(self, key: str) -> _Entry | None:
        for stored_key, entry in self._bucket(key):
            if stored_key == key:
                return entry
        return None

    def set(self, key: str, entry: _Entry) -> _Entry | None:
        bucket = self._bucket(key)
        for index, (stored_key, previous) in enumerate(bucket):
            if stored_key == key:
                bucket[index] = (key, entry)
                return previous

        bucket.append((key, entry))
        self._size += 1
        if self._size * 4 > len(self._buckets) * 3:
            self._grow()
        return None

    def delete(self, key: str) -> _Entry | None:
        bucket = self._bucket(key)
        for index, (stored_key, entry) in enumerate(bucket):
            if stored_key == key:
                del bucket[index]
                self._size -= 1
                return entry
        return None

    def _grow(self) -> None:
        previous_buckets = self._buckets
        self._buckets = [[] for _ in range(2 * len(previous_buckets))]
        for bucket in previous_buckets:
            for key, entry in bucket:
                self._bucket(key).append((key, entry))


class Store:
    """Serialize table operations and expiration checks with one lock."""

    def __init__(self, clock: Callable[[], float] = monotonic) -> None:
        self._table = _HashTable()
        self._clock = clock
        self._lock = Lock()

    def set(self, key: str, value: object, ttl_seconds: float | None = None) -> bool:
        """Set a value and return whether this created a live key."""
        ttl = None
        if ttl_seconds is not None:
            if isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, (int, float)):
                raise ValueError("ttl_seconds must be a positive finite number")
            try:
                ttl = float(ttl_seconds)
            except OverflowError as exc:
                raise ValueError("ttl_seconds must be a positive finite number") from exc
            if not math.isfinite(ttl) or ttl <= 0:
                raise ValueError("ttl_seconds must be a positive finite number")

        with self._lock:
            now = self._clock()
            expires_at = None if ttl is None else now + ttl
            previous = self._table.set(key, _Entry(value, expires_at))
            return previous is None or previous.expired(now)

    def get(self, key: str) -> object:
        with self._lock:
            entry = self._table.get(key)
            if entry is not None:
                if not entry.expired(self._clock()):
                    return entry.value
                self._table.delete(key)
            raise KeyError(key)

    def delete(self, key: str) -> bool:
        with self._lock:
            entry = self._table.delete(key)
            return entry is not None and not entry.expired(self._clock())
