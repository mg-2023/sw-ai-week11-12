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

    def test_every_result_has_elapsed_ms(self):
        results = self.sql.run("SELECT * FROM users; SELEC 1; INSERT INTO posts (title) VALUES ('t');")
        self.assertEqual([r["type"] for r in results], ["select", "error", "insert"])
        for r in results:
            self.assertIsInstance(r["elapsed_ms"], float)
            self.assertGreaterEqual(r["elapsed_ms"], 0)

    def test_tokenize_error_raises(self):
        with self.assertRaises(SQLError):
            self.sql.run("SELECT * FROM users WHERE name = 'kim;")


class CacheEntriesTest(CacheTestBase):
    def test_lists_versions_and_entries_with_staleness(self):
        self.one("SELECT name FROM users WHERE age > 26;")
        self.clock.now += 10
        self.one("INSERT INTO users (name, age) VALUES ('choi', 40);")
        self.one("select name from users where age > 26")  # 새 버전으로 다시 캐시

        info = self.sql.cache_entries()
        self.assertEqual(set(info["versions"]), {"users", "posts"})
        entries = info["entries"]
        self.assertEqual([e["current"] for e in entries], [True, False])  # 현재 버전이 먼저
        new, old = entries
        self.assertEqual(new["version"], info["versions"]["users"])
        self.assertEqual(int(new["version"]), int(old["version"]) + 1)
        self.assertEqual((new["ttl"], old["ttl"]), (self.TTL, self.TTL - 10))
        self.assertEqual(old["sql"], "SELECT name FROM users WHERE age > 26")
        self.assertEqual(new["sql"], "select name from users where age > 26")

    def test_expired_entries_are_not_listed(self):
        self.one("SELECT * FROM users;")
        self.clock.now += self.TTL + 1
        self.assertEqual(self.sql.cache_entries()["entries"], [])

    def test_ignores_non_cache_keys(self):
        self.store.set("plain", "v")
        self.store.set("dbcache:something", "v")
        self.one("SELECT * FROM users;")
        self.assertEqual(len(self.sql.cache_entries()["entries"]), 1)


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

        self.assertGreaterEqual(self.post("SELECT v FROM t;").json()["elapsed_ms"], 0)
        stats = self.client.get("/sql/stats").json()
        self.assertEqual((stats["hits"], stats["misses"]), (2, 1))

    def test_cache_endpoint(self):
        self.post("CREATE TABLE t (id, v); SELECT * FROM t;")
        body = self.client.get("/sql/cache").json()
        self.assertIn("t", body["versions"])
        self.assertEqual(len(body["entries"]), 1)
        self.assertEqual(body["entries"][0]["sql"], "SELECT * FROM t")
        self.assertTrue(body["entries"][0]["current"])

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


class WarmUpTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name)
        (self.data_dir / "users.csv").write_text("id,name\n1,kim\n2,lee\n3,park\n", encoding="utf-8")
        (self.data_dir / "logs.csv").write_text("msg\nhello\n", encoding="utf-8")         # id 컬럼 없음
        (self.data_dir / "broken.csv").write_text("id,name\nabc,x\n", encoding="utf-8")   # id 가 정수가 아님
        (self.data_dir / "notes.txt").write_text("not a table", encoding="utf-8")        # 테이블 아님
        self.db = CSVDatabase(self.data_dir)
        self.sql = CachedSQL(RedisStore(clock=FakeClock()), self.db, ttl_jitter=0)

    def tearDown(self):
        self.tmp.cleanup()

    def count_builds(self):
        """db._build_index 호출 횟수를 세도록 바꿔 두고, 횟수가 담긴 리스트를 돌려준다"""
        builds = []
        original = self.db._build_index

        def counting(table):
            builds.append(table)
            return original(table)

        self.db._build_index = counting
        return builds

    def test_tables_lists_csv_files(self):
        self.assertEqual(self.db.tables(), ["broken", "logs", "users"])
        self.assertEqual(CSVDatabase(self.data_dir / "missing").tables(), [])

    def test_report_per_table(self):
        report = {item["table"]: item for item in self.sql.warm_up()}
        self.assertEqual(set(report), {"broken", "logs", "users"})
        self.assertEqual(report["users"]["rows"], 3)
        self.assertIsNone(report["logs"]["rows"])
        self.assertIn("정수가 아니어서", report["broken"]["error"])  # 오류가 나도 다른 테이블은 계속
        for item in report.values():
            self.assertGreaterEqual(item["elapsed_ms"], 0)

    def test_first_id_query_after_warm_up_does_not_build_index(self):
        builds = self.count_builds()
        self.sql.warm_up()
        self.assertIn("users", builds)
        builds.clear()

        res = self.sql.run("SELECT * FROM users WHERE id = 2;")[0]
        self.assertEqual((res["rows"], res["used_index"]), ([["2", "lee"]], True))
        self.assertEqual(builds, [])  # 워밍업 때 만든 인덱스를 그대로 씀

    def test_without_warm_up_first_id_query_builds_index(self):
        builds = self.count_builds()
        self.sql.run("SELECT * FROM users WHERE id = 2;")
        self.assertEqual(builds, ["users"])

    def test_server_startup_runs_warm_up(self):
        builds = self.count_builds()
        with self.assertLogs("uvicorn.error", level="INFO") as logs:
            with TestClient(create_app(RedisStore(clock=FakeClock()), self.sql)):
                pass
        self.assertEqual(sorted(builds), ["broken", "logs", "users"])  # 세 테이블 모두 확인 (logs 는 결과가 None)
        text = "\n".join(logs.output)
        self.assertIn("워밍업: users - id 인덱스 3행", text)
        self.assertIn("워밍업: logs - id 컬럼 없음", text)
        self.assertIn("워밍업 실패: broken", text)
        self.assertIn("워밍업 완료: 테이블 3개", text)

    def test_server_startup_without_warm_up(self):
        builds = self.count_builds()
        with TestClient(create_app(RedisStore(clock=FakeClock()), self.sql, warm_up=False)):
            pass
        self.assertEqual(builds, [])


if __name__ == "__main__":
    unittest.main()
