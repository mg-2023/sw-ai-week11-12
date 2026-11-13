from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
import unittest

from mini_redis.store import Store


class CollidingKey(str):
    def __hash__(self) -> int:
        return 0


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


class StoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = Clock()
        self.store = Store(self.clock)

    def test_set_get_overwrite_and_delete(self) -> None:
        self.assertTrue(self.store.set("key", {"count": 1}))
        self.assertEqual(self.store.get("key"), {"count": 1})
        self.assertFalse(self.store.set("key", {"count": 2}))
        self.assertEqual(self.store.get("key"), {"count": 2})
        self.assertTrue(self.store.delete("key"))
        self.assertFalse(self.store.delete("key"))
        with self.assertRaises(KeyError):
            self.store.get("key")

    def test_falsy_values_are_present(self) -> None:
        for value in (None, False, 0, "", [], {}):
            with self.subTest(value=value):
                self.assertTrue(self.store.set("key", value))
                self.assertIs(self.store.get("key"), value)
                self.assertTrue(self.store.delete("key"))

    def test_collisions_and_resize_preserve_entries(self) -> None:
        keys = [CollidingKey(str(i)) for i in range(40)]
        for index, key in enumerate(keys):
            self.assertTrue(self.store.set(key, index))
        self.assertGreater(len(self.store._table._buckets), 8)
        self.assertTrue(self.store.delete(keys[13]))
        with self.assertRaises(KeyError):
            self.store.get(keys[13])
        self.assertFalse(self.store.set(keys[14], "updated"))
        for index, key in enumerate(keys):
            if index != 13:
                self.assertEqual(self.store.get(key), "updated" if index == 14 else index)

    def test_expiration_at_deadline_removes_entry_on_read(self) -> None:
        self.store.set("key", "value", ttl_seconds=1.5)
        self.clock.now = 101.49
        self.assertEqual(self.store.get("key"), "value")
        self.clock.now = 101.5
        with self.assertRaises(KeyError):
            self.store.get("key")
        self.assertIsNone(self.store._table.get("key"))

    def test_expired_entry_can_be_deleted_or_recreated(self) -> None:
        self.store.set("delete", 1, ttl_seconds=1)
        self.store.set("recreate", 1, ttl_seconds=1)
        self.clock.now += 1
        self.assertFalse(self.store.delete("delete"))
        self.assertIsNone(self.store._table.get("delete"))
        self.assertTrue(self.store.set("recreate", 2))
        self.assertEqual(self.store.get("recreate"), 2)

    def test_overwrite_replaces_deadline(self) -> None:
        self.store.set("key", "initial", ttl_seconds=1)
        self.clock.now += 0.5
        self.assertFalse(self.store.set("key", "renewed", ttl_seconds=2))
        self.clock.now += 0.5
        self.assertEqual(self.store.get("key"), "renewed")
        self.assertFalse(self.store.set("key", "permanent"))
        self.clock.now += 100
        self.assertEqual(self.store.get("key"), "permanent")

    def test_invalid_ttl_preserves_existing_value(self) -> None:
        self.store.set("key", "existing")
        invalid_ttls = (0, -1, True, False, "1", [], float("inf"), float("nan"), 10**500)
        for ttl in invalid_ttls:
            with self.subTest(ttl=ttl):
                with self.assertRaises(ValueError):
                    self.store.set("key", "replacement", ttl_seconds=ttl)
                self.assertEqual(self.store.get("key"), "existing")

    def test_concurrent_creation_and_deletion_of_same_key(self) -> None:
        workers = 12
        start = Barrier(workers)
        after_set = Barrier(workers)

        def modify(value: int) -> tuple[bool, bool]:
            start.wait(timeout=5)
            created = self.store.set("key", value)
            after_set.wait(timeout=5)
            deleted = self.store.delete("key")
            return created, deleted

        with ThreadPoolExecutor(max_workers=workers) as pool:
            results = list(pool.map(modify, range(workers)))
        self.assertEqual(sum(created for created, _ in results), 1)
        self.assertEqual(sum(deleted for _, deleted in results), 1)
        with self.assertRaises(KeyError):
            self.store.get("key")
