import os
import random
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from fastapi.testclient import TestClient  # noqa: E402

from main import create_app  # noqa: E402
from shortener import (  # noqa: E402
    URLShortener,
    cache_key,
    decode_code,
    encode_id,
    normalize_url,
)
from sqlcache import CachedSQL  # noqa: E402
from sqlparser import CSVDatabase  # noqa: E402
from store import RedisStore  # noqa: E402


class FakeClock:
    def __init__(self, now=1_700_000_000.0):
        self.now = now

    def __call__(self):
        return self.now


class TestBase62(unittest.TestCase):
    def test_round_trip(self):
        for n in [0, 1, 9, 10, 61, 62, 125, 3843, 3844, 10**12, 2**63 - 1]:
            self.assertEqual(decode_code(encode_id(n)), n)

    def test_known_values(self):
        self.assertEqual(encode_id(125), "21")
        self.assertEqual(encode_id(61), "Z")
        self.assertEqual(encode_id(62), "10")

    def test_rejects_bad_codes(self):
        for code in ["", "a-b", "가", "01", "0" * 2, "z" * 12, "a b"]:
            self.assertIsNone(decode_code(code), code)


class TestNormalizeUrl(unittest.TestCase):
    def test_accepts_http_and_https(self):
        self.assertEqual(normalize_url("  https://example.com/a?b=1  "), "https://example.com/a?b=1")
        self.assertEqual(normalize_url("HTTP://example.com"), "HTTP://example.com")

    def test_rejects_other_schemes_and_junk(self):
        for url in ["", "   ", "javascript:alert(1)", "ftp://example.com", "example.com",
                    "https://", "https://exa mple.com", "https://example.com/a\nb", "http://[::1",
                    "https://example.com/" + "a" * 3000]:
            with self.assertRaises(ValueError, msg=url):
                normalize_url(url)


class ShortenerTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.clock = FakeClock()
        self.store = RedisStore(clock=self.clock)
        self.sql = CachedSQL(self.store, db=CSVDatabase(self.tmp.name))
        self.short = URLShortener(self.store, self.sql, ttl=100, ttl_jitter=0,
                                  clock=self.clock, rng=random.Random(0))

    def tearDown(self):
        self.tmp.cleanup()


class TestShortener(ShortenerTestBase):
    def test_table_is_created_lazily(self):
        self.assertFalse(self.sql.db.exists("links"))
        self.assertEqual(self.short.resolve("1"), (None, "not_found"))
        self.assertFalse(self.sql.db.exists("links"))
        self.short.shorten("https://example.com")
        self.assertTrue(self.sql.db.exists("links"))

    def test_prewarm_makes_first_lookup_a_hit(self):
        link = self.short.shorten("https://example.com/a")
        self.assertEqual((link["id"], link["code"], link["prewarmed"]), (1, "1", True))
        self.assertEqual(self.store.get(cache_key("1")), "https://example.com/a")
        self.assertEqual(self.store.ttl(cache_key("1")), 100)
        self.assertEqual(self.short.resolve("1"), ("https://example.com/a", "hit"))

    def test_without_prewarm_first_lookup_misses_then_hits(self):
        self.short.set_prewarm(False)
        link = self.short.shorten("https://example.com/b")
        self.assertFalse(link["prewarmed"])
        self.assertIsNone(self.store.get(cache_key(link["code"])))
        self.assertEqual(self.short.resolve(link["code"]), ("https://example.com/b", "miss"))
        self.assertEqual(self.short.resolve(link["code"]), ("https://example.com/b", "hit"))

    def test_expired_key_is_refilled_from_db(self):
        code = self.short.shorten("https://example.com/c")["code"]
        self.clock.now += 101
        self.assertEqual(self.short.resolve(code), ("https://example.com/c", "miss"))
        self.assertEqual(self.store.ttl(cache_key(code)), 100)
        self.assertEqual(self.short.resolve(code)[1], "hit")

    def test_evict_and_flushall_only_drop_the_cache(self):
        code = self.short.shorten("https://example.com/d")["code"]
        self.assertEqual(self.short.evict(code), 1)
        self.assertEqual(self.short.resolve(code)[1], "miss")
        self.store.flushall()
        self.assertEqual(self.short.resolve(code), ("https://example.com/d", "miss"))

    def test_new_links_do_not_invalidate_existing_ones(self):
        # 테이블 버전 키 방식과 달리, 링크를 새로 만들어도 다른 링크의 캐시는 그대로다
        first = self.short.shorten("https://example.com/1")["code"]
        for i in range(5):
            self.short.shorten(f"https://example.com/more/{i}")
        self.assertEqual(self.short.resolve(first)[1], "hit")

    def test_insert_bumps_sql_table_version(self):
        # /sql 로 캐시해 둔 links 테이블 SELECT 결과는 새 링크가 생기면 낡은 것이 되어야 한다
        self.short.shorten("https://example.com/x")
        before = self.sql.run("SELECT * FROM links;")[0]
        self.short.shorten("https://example.com/y")
        after = self.sql.run("SELECT * FROM links;")[0]
        self.assertEqual((before["count"], after["count"], after["cache"]), (1, 2, "miss"))

    def test_unknown_and_malformed_codes(self):
        self.short.shorten("https://example.com")
        for code in ["2", "zz", "01", "a-b"]:
            self.assertEqual(self.short.resolve(code), (None, "not_found"))
        self.assertIsNone(self.store.get(cache_key("2")))   # 없는 링크는 캐시에 넣지 않는다

    def test_quotes_and_sql_like_text_survive(self):
        url = "https://example.com/it's?q=1;--x&r=/*y*/,\"z\""
        code = self.short.shorten(url)["code"]
        self.store.flushall()
        self.assertEqual(self.short.resolve(code), (url, "miss"))

    def test_links_persist_across_restart(self):
        code = self.short.shorten("https://example.com/keep")["code"]
        # 서버 재시작 = 새 store(빈 캐시) + 새 DB 객체(같은 폴더)
        store = RedisStore(clock=self.clock)
        restarted = URLShortener(store, CachedSQL(store, db=CSVDatabase(self.tmp.name)))
        self.assertEqual(restarted.resolve(code), ("https://example.com/keep", "miss"))
        self.assertEqual(restarted.shorten("https://example.com/next")["id"], 2)

    def test_recent_and_stats(self):
        self.short.set_prewarm(False)
        for i in range(3):
            self.short.shorten(f"https://example.com/{i}")
        self.short.resolve("3")
        self.short.resolve("3")
        self.short.resolve("nope")

        recent = self.short.recent(2)
        self.assertEqual([link["code"] for link in recent], ["3", "2"])
        self.assertEqual((recent[0]["cached"], recent[0]["ttl"]), (True, 100))
        self.assertEqual((recent[1]["cached"], recent[1]["ttl"]), (False, None))

        stats = self.short.stats()
        self.assertEqual(
            {k: stats[k] for k in ["created", "prewarmed", "hits", "misses", "not_found", "cached_links"]},
            {"created": 3, "prewarmed": 0, "hits": 1, "misses": 1, "not_found": 1, "cached_links": 1},
        )
        self.assertEqual(stats["hit_rate"], 0.5)
        self.assertFalse(stats["prewarm"])


class TestShortenerApi(ShortenerTestBase):
    def setUp(self):
        super().setUp()
        self.client = TestClient(create_app(self.store, sql=self.sql, warm_up=False, shortener=self.short))
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        super().tearDown()

    def test_shorten_then_redirect(self):
        res = self.client.post("/shorten", json={"url": "https://example.com/page"})
        self.assertEqual(res.status_code, 201)
        body = res.json()
        self.assertEqual(body["short_url"], "http://testserver/r/1")

        res = self.client.get("/r/1", follow_redirects=False)
        self.assertEqual(res.status_code, 302)
        self.assertEqual(res.headers["location"], "https://example.com/page")
        self.assertEqual(res.headers["x-cache"], "hit")
        self.assertEqual(res.headers["cache-control"], "no-store")

    def test_redirect_miss_after_evict(self):
        self.client.post("/shorten", json={"url": "https://example.com/page"})
        self.assertEqual(self.client.delete("/links/1/cache").json(), {"deleted": 1})
        res = self.client.get("/r/1", follow_redirects=False)
        self.assertEqual(res.headers["x-cache"], "miss")

    def test_unknown_code_is_404(self):
        self.assertEqual(self.client.get("/r/abc", follow_redirects=False).status_code, 404)
        self.assertEqual(self.client.get("/links/abc").status_code, 404)

    def test_bad_url_is_400(self):
        res = self.client.post("/shorten", json={"url": "javascript:alert(1)"})
        self.assertEqual(res.status_code, 400)

    def test_settings_and_lookup_json(self):
        res = self.client.put("/shortener/settings", json={"prewarm": False})
        self.assertEqual(res.json(), {"prewarm": False})
        self.client.post("/shorten", json={"url": "https://example.com/q"})

        first = self.client.get("/links/1").json()
        second = self.client.get("/links/1").json()
        self.assertEqual((first["cache"], second["cache"]), ("miss", "hit"))
        self.assertEqual(self.client.get("/shortener/stats").json()["hit_rate"], 0.5)

        links = self.client.get("/links").json()["links"]
        self.assertEqual([link["code"] for link in links], ["1"])
        self.assertTrue(links[0]["cached"])


if __name__ == "__main__":
    unittest.main()
