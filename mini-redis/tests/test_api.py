import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from fastapi.testclient import TestClient  # noqa: E402

from main import create_app  # noqa: E402
from store import NOT_INTEGER_ERR, RedisStore  # noqa: E402


class FakeClock:
    """TTL 테스트용 가짜 시계: 실제로 기다리지 않고 now를 바꿔서 시간을 흘려보냄"""

    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now


class ApiTestBase(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.store = RedisStore(clock=self.clock)
        # with 문으로 열어야 lifespan(능동 만료 스레드 시작/종료)이 실행됨
        self.client = TestClient(create_app(self.store))
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)

    def set(self, key, value, **opts):
        return self.client.put(f"/keys/{key}", json={"value": value, **opts})


class TestBasicCommands(ApiTestBase):
    def test_set_then_get(self):
        res = self.set("foo", "bar")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {"ok": True})

        res = self.client.get("/keys/foo")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {"key": "foo", "value": "bar"})

    def test_get_missing_key_is_404(self):
        res = self.client.get("/keys/nope")
        self.assertEqual(res.status_code, 404)

    def test_set_nx_does_not_overwrite(self):
        self.set("foo", "old")
        self.assertEqual(self.set("foo", "new", nx=True).json(), {"ok": False})
        self.assertEqual(self.client.get("/keys/foo").json()["value"], "old")

    def test_set_xx_on_missing_key(self):
        self.assertEqual(self.set("foo", "v", xx=True).json(), {"ok": False})
        self.assertEqual(self.client.get("/keys/foo").status_code, 404)

    def test_set_nx_and_xx_together_is_400(self):
        res = self.set("foo", "v", nx=True, xx=True)
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json(), {"detail": "syntax error"})

    def test_set_non_positive_ttl_is_400(self):
        self.assertEqual(self.set("foo", "v", ttl=0).status_code, 400)

    def test_set_rejects_non_string_value(self):
        self.assertEqual(self.client.put("/keys/foo", json={"value": 5}).status_code, 422)
        self.assertEqual(self.client.put("/keys/foo", json={}).status_code, 422)

    def test_delete(self):
        self.set("foo", "bar")
        self.assertEqual(self.client.delete("/keys/foo").json(), {"deleted": 1})
        self.assertEqual(self.client.delete("/keys/foo").json(), {"deleted": 0})

    def test_exists(self):
        self.assertEqual(self.client.get("/keys/foo/exists").json(), {"exists": False})
        self.set("foo", "bar")
        self.assertEqual(self.client.get("/keys/foo/exists").json(), {"exists": True})


class TestTtlCommands(ApiTestBase):
    def ttl(self, key):
        return self.client.get(f"/keys/{key}/ttl").json()["ttl"]

    def test_ttl_values(self):
        self.assertEqual(self.ttl("foo"), -2)      # 키 없음
        self.set("foo", "bar")
        self.assertEqual(self.ttl("foo"), -1)      # TTL 없음
        self.set("foo", "bar", ttl=10)
        self.assertEqual(self.ttl("foo"), 10)

    def test_key_expires(self):
        self.set("foo", "bar", ttl=10)
        self.clock.now += 11
        self.assertEqual(self.client.get("/keys/foo").status_code, 404)
        self.assertEqual(self.ttl("foo"), -2)

    def test_expire_and_persist(self):
        self.assertEqual(
            self.client.post("/keys/foo/expire", json={"seconds": 5}).json(), {"ok": False}
        )
        self.set("foo", "bar")
        self.assertEqual(
            self.client.post("/keys/foo/expire", json={"seconds": 5}).json(), {"ok": True}
        )
        self.assertEqual(self.ttl("foo"), 5)
        self.assertEqual(self.client.post("/keys/foo/persist").json(), {"ok": True})
        self.assertEqual(self.ttl("foo"), -1)
        self.assertEqual(self.client.post("/keys/foo/persist").json(), {"ok": False})

    def test_expire_zero_deletes_key(self):
        self.set("foo", "bar")
        self.client.post("/keys/foo/expire", json={"seconds": 0})
        self.assertEqual(self.client.get("/keys/foo").status_code, 404)


class TestCounterCommands(ApiTestBase):
    def test_incr_without_body(self):
        self.assertEqual(self.client.post("/keys/n/incr").json(), {"value": 1})
        self.assertEqual(self.client.post("/keys/n/incr").json(), {"value": 2})
        self.assertEqual(self.client.get("/keys/n").json()["value"], "2")

    def test_incr_and_decr_with_amount(self):
        self.assertEqual(self.client.post("/keys/n/incr", json={"amount": 10}).json(), {"value": 10})
        self.assertEqual(self.client.post("/keys/n/decr", json={"amount": 3}).json(), {"value": 7})
        self.assertEqual(self.client.post("/keys/n/decr").json(), {"value": 6})

    def test_incr_non_integer_value_is_400(self):
        self.set("n", "abc")
        res = self.client.post("/keys/n/incr")
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json(), {"detail": NOT_INTEGER_ERR})

    def test_incr_rejects_non_integer_amount(self):
        for bad in (True, "5", 1.5):
            with self.subTest(amount=bad):
                res = self.client.post("/keys/n/incr", json={"amount": bad})
                self.assertEqual(res.status_code, 422)

    def test_incr_out_of_range_amount_is_400(self):
        res = self.client.post("/keys/n/incr", json={"amount": 2**63})
        self.assertEqual(res.status_code, 400)


class TestAdminCommands(ApiTestBase):
    def test_keys_dbsize_flushall(self):
        self.set("a", "1")
        self.set("b", "2", ttl=5)
        self.assertEqual(sorted(self.client.get("/keys").json()["keys"]), ["a", "b"])
        self.assertEqual(self.client.get("/dbsize").json(), {"size": 2})

        self.clock.now += 6     # b 만료
        self.assertEqual(self.client.get("/keys").json(), {"keys": ["a"]})
        self.assertEqual(self.client.get("/dbsize").json(), {"size": 1})

        self.assertEqual(self.client.post("/flushall").json(), {"ok": True})
        self.assertEqual(self.client.get("/dbsize").json(), {"size": 0})


class TestLifespan(unittest.TestCase):
    def test_active_expire_thread_follows_server_lifecycle(self):
        store = RedisStore()
        with TestClient(create_app(store)):
            self.assertIsNotNone(store._expire_thread)
        self.assertIsNone(store._expire_thread)


if __name__ == "__main__":
    unittest.main()
