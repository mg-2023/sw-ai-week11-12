import argparse
import json
from collections.abc import Callable
from http.server import ThreadingHTTPServer
from time import sleep
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from mini_redis.http import JsonHandler


CACHE_PATH = "/v1/keys/sample-report"
REPORT_PATH = "/v1/report"
CACHE_TTL_SECONDS = 30


def load_report() -> dict[str, int]:
    sleep(0.05)  # Simulate a slow upstream read.
    return {"orders": 12, "total_cents": 4200}


class ReportHandler(JsonHandler):
    def do_GET(self) -> None:
        if self.path == REPORT_PATH + "?cache=off":
            self.send_json(200, {"report": self.server.load_report(), "cache": "bypass"})
            return
        if self.path != REPORT_PATH:
            self.send_json(404, {"error": "route not found"})
            return

        try:
            try:
                with urlopen(self.server.cache_url, timeout=2) as response:
                    report = json.load(response)["value"]
            except HTTPError as exc:
                exc.close()
                if exc.code != 404:
                    raise
                report = self.server.load_report()
                body = json.dumps({"value": report, "ttl_seconds": CACHE_TTL_SECONDS}).encode("utf-8")
                request = Request(self.server.cache_url, data=body, method="PUT")
                request.add_header("Content-Type", "application/json")
                with urlopen(request, timeout=2):
                    pass
                cache = "miss"
            else:
                cache = "hit"
        except (OSError, ValueError, KeyError, TypeError):
            self.send_json(502, {"error": "Mini Redis request failed"})
            return

        self.send_json(200, {"report": report, "cache": cache})


class ReportServer(ThreadingHTTPServer):
    def __init__(
        self,
        address: tuple[str, int],
        redis_url: str,
        loader: Callable[[], dict[str, int]] = load_report,
    ) -> None:
        self.cache_url = redis_url.rstrip("/") + CACHE_PATH
        self.load_report = loader
        super().__init__(address, ReportHandler)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the cache-backed sample report API.")
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--redis-url", default="http://127.0.0.1:8000")
    args = parser.parse_args()

    with ReportServer(("127.0.0.1", args.port), args.redis_url) as server:
        print(f"Report API listening at http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
