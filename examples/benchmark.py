import argparse
import json
from statistics import median
from time import perf_counter
from urllib.request import urlopen

from .report_api import REPORT_PATH


def fetch(url: str) -> tuple[dict, float]:
    started = perf_counter()
    with urlopen(url, timeout=5) as response:
        payload = json.load(response)
    return payload, (perf_counter() - started) * 1000


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare report API latency with and without Mini Redis.")
    parser.add_argument("--url", default="http://127.0.0.1:8001")
    parser.add_argument("--requests", type=int, default=30, help="Sample count per mode")
    args = parser.parse_args()
    if args.requests < 1:
        parser.error("--requests must be positive")

    cached_url = args.url.rstrip("/") + REPORT_PATH
    bypass_url = cached_url + "?cache=off"
    fetch(cached_url)  # Warm the cache.
    bypass_times = []
    hit_times = []
    for _ in range(args.requests):
        direct, bypass_ms = fetch(bypass_url)
        cached, hit_ms = fetch(cached_url)
        if direct["cache"] != "bypass" or cached["cache"] != "hit":
            parser.exit(1, "Expected a cache hit in every measured pair. The cached report may have expired.\n")
        if direct["report"] != cached["report"]:
            parser.exit(1, "Report responses differ.\n")
        bypass_times.append(bypass_ms)
        hit_times.append(hit_ms)

    bypass_median = median(bypass_times)
    hit_median = median(hit_times)
    print(f"Requests per mode: {args.requests}")
    print(f"Without cache median: {bypass_median:.2f} ms")
    print(f"Mini Redis cache hit median: {hit_median:.2f} ms")
    print(f"Median speedup: {bypass_median / hit_median:.2f}x")


if __name__ == "__main__":
    main()
