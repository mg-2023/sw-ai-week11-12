from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
import json
from threading import Barrier, Thread
import unittest
from urllib.parse import quote

from examples.report_api import CACHE_PATH, CACHE_TTL_SECONDS, REPORT_PATH, ReportServer
from mini_redis.server import MiniRedisServer
from mini_redis.store import Store


def request(port: int, method: str, path: str, body=None, headers=None) -> tuple[int, bytes]:
    connection = HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request(method, path, body=body, headers={} if headers is None else headers)
        with connection.getresponse() as response:
            return response.status, response.read()
    finally:
        connection.close()


class HttpTests(unittest.TestCase):
    def setUp(self) -> None:
        self.now = 100.0
        self.redis_port = self.serve(MiniRedisServer(("127.0.0.1", 0), Store(lambda: self.now)))

    def serve(self, server) -> int:
        thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.shutdown)
        return server.server_port

    def put(self, path: str, payload: dict) -> tuple[int, bytes]:
        return request(self.redis_port, "PUT", path, json.dumps(payload), {"Content-Type": "application/json"})

    def test_http_round_trip_with_unicode_and_reserved_characters(self) -> None:
        path = "/v1/keys/" + quote("정글 /?#%+", safe="")
        self.assertEqual(self.put(path, {"value": {"한글": [1, False]}}), (201, b""))
        status, body = request(self.redis_port, "GET", path)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"value": {"한글": [1, False]}})
        self.assertEqual(self.put(path, {"value": None}), (204, b""))
        status, body = request(self.redis_port, "GET", path)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"value": None})
        self.assertEqual(request(self.redis_port, "DELETE", path), (204, b""))
        self.assertEqual(request(self.redis_port, "GET", path)[0], 404)
        self.assertEqual(request(self.redis_port, "DELETE", path)[0], 404)

    def test_expiration_and_recreation_over_http(self) -> None:
        path = "/v1/keys/session"
        self.assertEqual(self.put(path, {"value": 1, "ttl_seconds": 2})[0], 201)
        self.now += 1.99
        self.assertEqual(request(self.redis_port, "GET", path)[0], 200)
        self.now = 102.0
        self.assertEqual(request(self.redis_port, "GET", path)[0], 404)
        self.assertEqual(self.put(path, {"value": 2, "ttl_seconds": None})[0], 201)
        self.now += 500
        self.assertEqual(json.loads(request(self.redis_port, "GET", path)[1]), {"value": 2})

    def test_rejects_bad_routes_and_key_encodings(self) -> None:
        self.assertEqual(request(self.redis_port, "GET", "/missing")[0], 404)
        for key in ("", "a/b", "a?b", "%XX", "%FF"):
            with self.subTest(key=key):
                self.assertEqual(request(self.redis_port, "GET", "/v1/keys/" + key)[0], 400)

    def test_rejects_invalid_payloads_without_overwriting(self) -> None:
        path = "/v1/keys/payload"
        self.assertEqual(self.put(path, {"value": "existing"})[0], 201)
        for body in (b"{", b"[]", b"{}", b'{"value":"\xff"}', b'{"value":[NaN]}', b'{"value":1e400}'):
            with self.subTest(body=body):
                result = request(self.redis_port, "PUT", path, body, {"Content-Type": "application/json"})
                self.assertEqual(result[0], 400)
        for ttl in (0, -1, True, "2", 10**500):
            with self.subTest(ttl=ttl):
                self.assertEqual(self.put(path, {"value": "replacement", "ttl_seconds": ttl})[0], 400)
        status, body = request(self.redis_port, "GET", path)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"value": "existing"})

    def test_rejects_unsupported_content_type_and_body_lengths(self) -> None:
        path = "/v1/keys/payload"
        self.assertEqual(request(self.redis_port, "PUT", path, b"{}")[0], 415)
        for length, expected in (("-1", 400), ("abc", 400), ("1048577", 413)):
            with self.subTest(length=length):
                headers = {"Content-Length": length, "Content-Type": "application/json"}
                self.assertEqual(request(self.redis_port, "PUT", path, b"", headers)[0], expected)

    def test_concurrent_clients_can_write_and_read_separate_keys(self) -> None:
        workers = 8
        start = Barrier(workers)

        def use_keys(worker: int) -> list[tuple[int, int, dict]]:
            start.wait(timeout=5)
            results = []
            for index in range(8):
                value = [worker, index]
                path = f"/v1/keys/{worker}-{index}"
                put_status, _ = self.put(path, {"value": value})
                get_status, body = request(self.redis_port, "GET", path)
                results.append((put_status, get_status, json.loads(body)))
            return results

        with ThreadPoolExecutor(max_workers=workers) as pool:
            results = list(pool.map(use_keys, range(workers)))
        for worker, responses in enumerate(results):
            for index, response in enumerate(responses):
                self.assertEqual(response, (201, 200, {"value": [worker, index]}))

    def test_external_api_uses_cached_response_and_refetches_after_expiry_or_delete(self) -> None:
        upstream_calls = []

        def load_report() -> dict[str, int]:
            upstream_calls.append(1)
            return {"orders": len(upstream_calls)}

        report_server = ReportServer(("127.0.0.1", 0), f"http://127.0.0.1:{self.redis_port}", load_report)
        report_port = self.serve(report_server)

        def get_report(path: str = REPORT_PATH) -> dict:
            status, body = request(report_port, "GET", path)
            self.assertEqual(status, 200)
            return json.loads(body)

        self.assertEqual(get_report(), {"report": {"orders": 1}, "cache": "miss"})
        status, body = request(self.redis_port, "GET", CACHE_PATH)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"value": {"orders": 1}})
        self.assertEqual(get_report(), {"report": {"orders": 1}, "cache": "hit"})
        self.assertEqual(len(upstream_calls), 1)
        self.assertEqual(get_report(REPORT_PATH + "?cache=off"), {"report": {"orders": 2}, "cache": "bypass"})
        self.assertEqual(get_report(), {"report": {"orders": 1}, "cache": "hit"})
        self.now += CACHE_TTL_SECONDS
        self.assertEqual(get_report(), {"report": {"orders": 3}, "cache": "miss"})
        self.assertEqual(request(self.redis_port, "DELETE", CACHE_PATH)[0], 204)
        self.assertEqual(get_report(), {"report": {"orders": 4}, "cache": "miss"})
