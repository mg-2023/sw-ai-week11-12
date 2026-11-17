import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from fastapi.testclient import TestClient  # noqa: E402

from main import create_app  # noqa: E402
from sqlcache import CachedSQL, version_key  # noqa: E402
from sqlparser import CSVDatabase, SQLError  # noqa: E402
from store import RedisStore  # noqa: E402

SETUP_SQL = """
CREATE TABLE users (id, name, age);
INSERT INTO users (name, age) VALUES ('kim', 25), ('lee', 31), ('park', 28);
CREATE TABLE posts (id, title);
"""


class FakeClock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now


class CacheTestBase(unittest.TestCase):
    TTL = 60

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name)
        self.clock = FakeClock()
        self.store = RedisStore(clock=self.clock)
        self.sql = CachedSQL(self.store, CSVDatabase(self.data_dir), ttl=self.TTL, ttl_jitter=0)
        self.assertFalse(any(r["type"] == "error" for r in self.sql.run(SETUP_SQL)))

    def tearDown(self):
        self.tmp.cleanup()

    def one(self, source, **kwargs):
        results = self.sql.run(source, **kwargs)
        self.assertEqual(len(results), 1)
        return results[0]

    def query_keys(self):
        return [k for k in self.store.keys() if k.startswith("dbcache:q:")]


class HitMissTest(CacheTestBase):
    def test_second_select_is_hit_with_same_result(self):
        first = self.one("SELECT name FROM users WHERE age > 26;")
        second = self.one("SELECT name FROM users WHERE age > 26;")
        self.assertEqual(first["cache"], "miss")
        self.assertEqual(second["cache"], "hit")
        self.assertEqual(second["rows"], [["lee"], ["park"]])
        self.assertEqual(first["rows"], second["rows"])
        self.assertEqual(self.sql.stats()["hits"], 1)
        self.assertEqual(self.sql.stats()["misses"], 1)

    def test_formatting_differences_share_one_entry(self):
        self.one("SELECT name FROM users WHERE age > 26;")
        res = self.one("select   name\n  from users -- 주석\n where AGE > 26")
        self.assertEqual(res["cache"], "miss")  # 컬럼 이름 대소문자가 다르면 다른 쿼리로 본다
        res = self.one("select   name\n  from users -- 주석\n where age   >   26")
        self.assertEqual(res["cache"], "hit")   # 공백/주석/키워드 대소문자만 다르면 같은 쿼리

    def test_different_queries_have_different_entries(self):
        self.one("SELECT * FROM users WHERE age > 26;")
        self.assertEqual(self.one("SELECT * FROM users WHERE age > 27;")["cache"], "miss")
        self.assertEqual(len(self.query_keys()), 2)

    def test_index_lookup_result_is_cached_too(self):
        first = self.one("SELECT * FROM users WHERE id = 2;")
        second = self.one("SELECT * FROM users WHERE id = 2;")
        self.assertTrue(first["used_index"])
        self.assertEqual((second["cache"], second["used_index"]), ("hit", True))

    def test_empty_result_is_cached(self):
        self.one("SELECT * FROM users WHERE age > 100;")
        res = self.one("SELECT * FROM users WHERE age > 100;")
        self.assertEqual((res["cache"], res["rows"]), ("hit", []))


class InvalidationTest(CacheTestBase):
    def test_insert_invalidates_table(self):
        self.one("SELECT name FROM users WHERE age > 26;")
        self.one("INSERT INTO users (name, age) VALUES ('choi', 40);")
        res = self.one("SELECT name FROM users WHERE age > 26;")
        self.assertEqual(res["cache"], "miss")
        self.assertEqual(res["rows"], [["lee"], ["park"], ["choi"]])
        # SETUP_SQL 의 CREATE 2번 + INSERT 1번, 여기 INSERT 1번
        self.assertEqual(self.sql.stats()["invalidations"], 4)

    def test_insert_into_other_table_keeps_cache(self):
        self.one("SELECT * FROM users;")
        self.one("INSERT INTO posts (title) VALUES ('hello');")
        self.assertEqual(self.one("SELECT * FROM users;")["cache"], "hit")

    def test_failed_insert_does_not_invalidate(self):
        self.one("SELECT * FROM users;")
        res = self.one("INSERT INTO users (id, name) VALUES (1, 'dup');")  # id 중복
        self.assertEqual(res["type"], "error")
        self.assertEqual(self.one("SELECT * FROM users;")["cache"], "hit")

    def test_version_key_ignores_table_name_case(self):
        self.assertEqual(version_key("Users"), version_key("users"))

    def test_version_key_reset_starts_new_generation(self):
        # 버전 키만 지워졌는데 옛 결과는 아직 TTL 안에 남아 있는 상황.
        # 버전을 1부터 다시 셌다면 우연히 같은 번호의 옛 결과를 읽을 수 있다.
        self.one("SELECT * FROM users;")
        self.store.delete(version_key("users"))
        with open(self.data_dir / "users.csv", "a", encoding="utf-8") as f:  # 서버 밖에서 직접 추가
            f.write("99,outside,50\n")
        res = self.one("SELECT * FROM users;")
        self.assertEqual(res["cache"], "miss")
        self.assertIn(["99", "outside", "50"], res["rows"])

    def test_flushall_clears_cache(self):
        self.one("SELECT * FROM users;")
        self.store.flushall()
        self.assertEqual(self.one("SELECT * FROM users;")["cache"], "miss")


class TtlTest(CacheTestBase):
    def test_entry_expires_after_ttl(self):
        self.one("SELECT * FROM users;")
        self.clock.now += self.TTL - 1
        self.assertEqual(self.one("SELECT * FROM users;")["cache"], "hit")
        self.clock.now += 2
        self.assertEqual(self.one("SELECT * FROM users;")["cache"], "miss")

    def test_jitter_stays_in_range(self):
        sql = CachedSQL(self.store, CSVDatabase(self.data_dir), ttl=60, ttl_jitter=10)
        ttls = {sql._next_ttl() for _ in range(500)}
        self.assertTrue(ttls <= set(range(60, 71)))
        self.assertGreater(len(ttls), 1)

    def test_invalid_ttl_options(self):
        with self.assertRaises(ValueError):
            CachedSQL(self.store, CSVDatabase(self.data_dir), ttl=0)
        with self.assertRaises(ValueError):
            CachedSQL(self.store, CSVDatabase(self.data_dir), ttl_jitter=-1)


class BypassAndErrorTest(CacheTestBase):
    def test_use_cache_false_neither_reads_nor_writes(self):
        self.one("SELECT * FROM users;")
        res = self.one("SELECT * FROM users;", use_cache=False)
        self.assertEqual(res["cache"], "bypass")
        self.one("SELECT * FROM users WHERE age > 1;", use_cache=False)
        self.assertEqual(len(self.query_keys()), 1)
        self.assertEqual(self.sql.stats()["bypassed"], 2)

    def test_errors_are_not_cached_and_script_continues(self):
        results = self.sql.run("SELECT * FROM nope; SELEC 1; SELECT name FROM users WHERE id = 1;")
        self.assertEqual([r["type"] for r in results], ["error", "error", "select"])
        self.assertEqual(results[2]["rows"], [["kim"]])
        self.assertEqual(len(self.query_keys()), 1)

    def test_tokenize_error_raises(self):
        with self.assertRaises(SQLError):
            self.sql.run("SELECT * FROM users WHERE name = 'kim;")


class SingleFlightTest(CacheTestBase):
    def test_concurrent_misses_hit_db_once(self):
        calls = []
        original = self.sql.executor.execute_select

        def slow_select(stmt):
            calls.append(stmt)
            time.sleep(0.05)
            return original(stmt)

        self.sql.executor.execute_select = slow_select
        results = []
        threads = [
            threading.Thread(target=lambda: results.append(self.one("SELECT * FROM users;")))
            for _ in range(8)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(len(calls), 1)
        self.assertEqual(sorted(r["cache"] for r in results), ["hit"] * 7 + ["miss"])


class SqlApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = RedisStore(clock=FakeClock())
        sql = CachedSQL(self.store, CSVDatabase(self.tmp.name), ttl_jitter=0)
        self.client = TestClient(create_app(self.store, sql))
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.tmp.cleanup()

    def post(self, sql, **opts):
        return self.client.post("/sql", json={"sql": sql, **opts})

    def test_create_insert_select_flow(self):
        res = self.post("CREATE TABLE t (id, v); INSERT INTO t (v) VALUES ('a'), ('b');")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["errors"], 0)
        self.assertEqual(body["results"][0]["created"], True)
        self.assertEqual(body["results"][1]["ids"], [1, 2])

        first = self.post("SELECT v FROM t;").json()["results"][0]
        second = self.post("SELECT v FROM t;").json()["results"][0]
        self.assertEqual((first["cache"], second["cache"]), ("miss", "hit"))
        self.assertEqual(second["rows"], [["a"], ["b"]])

        stats = self.client.get("/sql/stats").json()
        self.assertEqual((stats["hits"], stats["misses"], stats["hit_rate"]), (1, 1, 0.5))

    def test_cache_keys_visible_through_redis_api(self):
        self.post("CREATE TABLE t (id, v); SELECT * FROM t;")
        keys = self.client.get("/keys").json()["keys"]
        self.assertIn("dbcache:ver:t", keys)
        self.assertTrue(any(k.startswith("dbcache:q:t:") for k in keys))

    def test_statement_error_is_reported_with_200(self):
        body = self.post("SELECT * FROM missing;").json()
        self.assertEqual(body["errors"], 1)
        self.assertEqual(body["results"][0]["type"], "error")

    def test_tokenize_error_is_400(self):
        self.assertEqual(self.post("SELECT 'unterminated").status_code, 400)

    def test_use_cache_false(self):
        self.post("CREATE TABLE t (id, v);")
        res = self.post("SELECT * FROM t;", use_cache=False).json()["results"][0]
        self.assertEqual(res["cache"], "bypass")


if __name__ == "__main__":
    unittest.main()
