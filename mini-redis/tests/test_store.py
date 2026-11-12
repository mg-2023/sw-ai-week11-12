import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from hashtable import HashTable  # noqa: E402
from store import INT64_MAX, INT64_MIN, RedisStore  # noqa: E402


class FakeClock:
    """sleep 없이 시간을 앞으로 돌릴 수 있는 가짜 시계"""

    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class HashTableTest(unittest.TestCase):
    def test_delete_updates_size(self):
        t = HashTable()
        t.put("a", 1)
        t.put("b", 2)
        self.assertTrue(t.delete("a"))
        self.assertFalse(t.delete("a"))
        self.assertEqual(len(t), 1)
        self.assertNotIn("a", t)
        self.assertIn("b", t)

    def test_items_after_resize(self):
        t = HashTable()
        for i in range(100):
            t.put(f"k{i}", i)
        self.assertEqual(len(t), 100)
        self.assertEqual(sorted(t.keys()), sorted(f"k{i}" for i in range(100)))


class BasicCommandTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.store = RedisStore(clock=self.clock)

    def test_get_without_ttl(self):
        self.store.set("a", "1")
        self.assertEqual(self.store.get("a"), "1")

    def test_get_missing(self):
        self.assertIsNone(self.store.get("nope"))

    def test_set_without_ttl_clears_old_ttl(self):
        self.store.set("a", "1", ttl=5)
        self.store.set("a", "2")
        self.clock.advance(10)
        self.assertEqual(self.store.get("a"), "2")

    def test_set_rejects_non_positive_ttl(self):
        with self.assertRaises(ValueError):
            self.store.set("a", "1", ttl=0)

    def test_delete_counts_only_existing(self):
        self.store.set("a", "1")
        self.store.set("b", "2")
        self.assertEqual(self.store.delete("a", "b", "c"), 2)
        self.assertFalse(self.store.exists("a"))

    def test_delete_does_not_count_expired(self):
        self.store.set("a", "1", ttl=1)
        self.clock.advance(2)
        self.assertEqual(self.store.delete("a"), 0)

    def test_exists(self):
        self.store.set("a", "1", ttl=1)
        self.assertTrue(self.store.exists("a"))
        self.clock.advance(2)
        self.assertFalse(self.store.exists("a"))


class TtlCommandTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.store = RedisStore(clock=self.clock)

    def test_lazy_expiration(self):
        self.store.set("a", "1", ttl=5)
        self.clock.advance(4)
        self.assertEqual(self.store.get("a"), "1")
        self.clock.advance(2)
        self.assertIsNone(self.store.get("a"))

    def test_ttl_values(self):
        self.assertEqual(self.store.ttl("nope"), -2)
        self.store.set("a", "1")
        self.assertEqual(self.store.ttl("a"), -1)
        self.store.set("b", "1", ttl=10)
        self.clock.advance(3)
        self.assertEqual(self.store.ttl("b"), 7)

    def test_expire_and_persist(self):
        self.assertFalse(self.store.expire("nope", 10))
        self.store.set("a", "1")
        self.assertTrue(self.store.expire("a", 10))
        self.assertEqual(self.store.ttl("a"), 10)
        self.assertTrue(self.store.persist("a"))
        self.assertFalse(self.store.persist("a"))   # 이미 TTL 없음
        self.clock.advance(100)
        self.assertEqual(self.store.get("a"), "1")

    def test_expire_non_positive_deletes(self):
        self.store.set("a", "1")
        self.assertTrue(self.store.expire("a", 0))
        self.assertFalse(self.store.exists("a"))


class IncrTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.store = RedisStore(clock=self.clock)

    def test_incr_decr(self):
        self.assertEqual(self.store.incr("n"), 1)
        self.assertEqual(self.store.incr("n", 5), 6)
        self.assertEqual(self.store.decr("n"), 5)
        self.store.set("s", "10")
        self.assertEqual(self.store.incr("s"), 11)

    def test_stored_as_string_returned_as_int(self):
        result = self.store.incr("n")
        self.assertEqual(result, 1)
        self.assertIsInstance(result, int)
        self.assertEqual(self.store.get("n"), "1")
        self.store.set("m", "10")
        self.store.incr("m")
        self.assertEqual(self.store.get("m"), "11")   # set 값과 incr 결과의 타입이 같음

    def test_incr_accepts_int_set_value(self):
        self.store.set("n", 5)
        self.assertEqual(self.store.incr("n"), 6)

    def test_incr_non_integer(self):
        self.store.set("s", "abc")
        with self.assertRaises(ValueError):
            self.store.incr("s")

    def test_incr_rejects_loose_formats(self):
        # 파이썬 int()는 받아주지만 Redis는 거부하는 형식들
        for bad in [" 10", "10 ", "10\n", "+10", "1_000", "010", "-0", "",
                    "1.5", "٣", True, None, 1.0]:
            with self.subTest(value=bad):
                self.store.set("s", bad)
                with self.assertRaises(ValueError):
                    self.store.incr("s")
                self.assertEqual(self.store.get("s"), bad)   # 실패해도 값은 그대로

    def test_incr_accepts_valid_formats(self):
        for good, expected in [("0", 1), ("-1", 0), ("-10", -9), ("123", 124)]:
            with self.subTest(value=good):
                self.store.set("s", good)
                self.assertEqual(self.store.incr("s"), expected)

    def test_stored_value_out_of_int64_range(self):
        self.store.set("s", str(INT64_MAX + 1))
        with self.assertRaisesRegex(ValueError, "not an integer or out of range"):
            self.store.incr("s")

    def test_int64_boundaries_are_allowed(self):
        self.store.set("max", str(INT64_MAX - 1))
        self.assertEqual(self.store.incr("max"), INT64_MAX)
        self.store.set("min", str(INT64_MIN + 1))
        self.assertEqual(self.store.decr("min"), INT64_MIN)

    def test_incr_overflow_keeps_value(self):
        self.store.set("n", str(INT64_MAX))
        with self.assertRaisesRegex(ValueError, "would overflow"):
            self.store.incr("n")
        self.assertEqual(self.store.get("n"), str(INT64_MAX))

    def test_decr_underflow_keeps_value(self):
        self.store.set("n", str(INT64_MIN))
        with self.assertRaisesRegex(ValueError, "would overflow"):
            self.store.decr("n")
        self.assertEqual(self.store.get("n"), str(INT64_MIN))

    def test_incr_by_large_amount_overflow_keeps_value(self):
        self.store.set("n", "1")
        with self.assertRaises(ValueError):
            self.store.incr("n", INT64_MAX)
        self.assertEqual(self.store.get("n"), "1")

    def test_invalid_amount(self):
        for bad in [1.5, "1", True, INT64_MAX + 1, INT64_MIN - 1]:
            with self.subTest(amount=bad):
                with self.assertRaises(ValueError):
                    self.store.incr("n", bad)
        self.assertFalse(self.store.exists("n"))   # 잘못된 amount로 키가 생기지 않음

    def test_decr_by_int64_min(self):
        with self.assertRaisesRegex(ValueError, "^decrement would overflow$"):
            self.store.decr("n", INT64_MIN)
        self.assertFalse(self.store.exists("n"))

    def test_incr_keeps_ttl(self):
        self.store.set("n", "1", ttl=10)
        self.store.incr("n")
        self.assertEqual(self.store.ttl("n"), 10)

    def test_incr_is_atomic(self):
        store = RedisStore()
        n_threads, n_iter = 8, 2000

        def work():
            for _ in range(n_iter):
                store.incr("counter")

        threads = [threading.Thread(target=work) for _ in range(n_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(store.get("counter"), str(n_threads * n_iter))


class AdminAndActiveExpireTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.store = RedisStore(clock=self.clock)

    def test_keys_and_dbsize_skip_expired(self):
        self.store.set("a", "1")
        self.store.set("b", "2", ttl=1)
        self.clock.advance(2)
        self.assertEqual(self.store.keys(), ["a"])
        self.assertEqual(self.store.dbsize(), 1)

    def test_flushall(self):
        self.store.set("a", "1", ttl=5)
        self.store.flushall()
        self.assertEqual(self.store.dbsize(), 0)
        self.assertEqual(self.store.ttl("a"), -2)

    def test_purge_expired_removes_untouched_keys(self):
        for i in range(10):
            self.store.set(f"k{i}", i, ttl=1)
        self.store.set("live", "x")
        self.clock.advance(2)
        self.assertEqual(self.store.purge_expired(), 10)
        # 조회하지 않았는데도 내부 테이블에서 실제로 사라졌는지 확인
        self.assertEqual(len(self.store._data), 1)
        self.assertEqual(len(self.store._expires), 0)

    def test_background_thread(self):
        store = RedisStore()   # 실제 시계 사용
        store.set("a", "1", ttl=0.05)
        store.start_active_expire(interval=0.02)
        try:
            deadline = time.time() + 2
            while len(store._data) and time.time() < deadline:
                time.sleep(0.01)
            self.assertEqual(len(store._data), 0)
        finally:
            store.stop_active_expire()
        self.assertIsNone(store._expire_thread)


if __name__ == "__main__":
    unittest.main()
