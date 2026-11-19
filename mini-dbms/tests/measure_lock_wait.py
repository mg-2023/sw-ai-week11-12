"""Measure INSERT write-lock wait on a large table while full scans run (design 2.10).

Run: python tests/measure_lock_wait.py [--rows 150000] [--seconds 8] [--readers 6]
                                       [--writers 2] [--sync always|none] [--threads 4]
Starts its own server on a unique data folder under build/, loads the rows, then
runs readers (full scans, WHERE name = 'nobody') and writers (one-row INSERT) at the
same time and prints the server's own /stats lock-wait numbers (p99 / max, in ms)
next to client-side latencies (median / p99 / max and the number finished, for scans and INSERTs).
The design limit for the INSERT lock-wait p99 is 100 ms.
"""

import argparse
import statistics
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_server import Server, fill_users, http, ok_query, stats  # noqa: E402


def percentile(values, q):
    values = sorted(values)
    return values[max(0, int(len(values) * q + 0.999999) - 1)] if values else 0.0


def summary(values):
    """median / p99 / max of client-side latencies in ms; says so when nothing finished."""
    if not values:
        return "none finished"
    return f"median={statistics.median(values):.1f} ms  p99={percentile(values, .99):.1f} ms  max={max(values):.1f} ms"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=int, default=150000)
    ap.add_argument("--seconds", type=float, default=8.0)
    ap.add_argument("--readers", type=int, default=6)
    ap.add_argument("--writers", type=int, default=2)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--sync", choices=("always", "none"), default="always")
    a = ap.parse_args()

    s = Server("--threads", str(a.threads), "--sync", a.sync)
    try:
        fill_users(s.port, a.rows)
        first = ok_query(s.port, "SELECT * FROM users WHERE name = 'nobody';")
        one_scan_ms = first["elapsed_us"] / 1000
        print(f"rows={a.rows} sync={a.sync} workers={a.threads} readers={a.readers} writers={a.writers}")
        print(f"one idle full scan: {one_scan_ms:.1f} ms")
        scans, writes, errors = [], [], []
        go = threading.Event()
        deadline = [0.0]

        def work(i):
            go.wait()  # every thread is started before the clock starts (starting 100+ threads takes seconds)
            while time.monotonic() < deadline[0]:
                t = time.monotonic()
                if i < a.readers:
                    ok_query(s.port, "SELECT * FROM users WHERE name = 'nobody';")
                    scans.append((time.monotonic() - t) * 1000)
                else:
                    ok_query(s.port, f"INSERT INTO users VALUES ('w{i}', 1);")
                    writes.append((time.monotonic() - t) * 1000)

        def guarded(i):
            try:
                work(i)
            except BaseException as exc:
                errors.append(exc)

        threads = [threading.Thread(target=guarded, args=(i,)) for i in range(a.readers + a.writers)]
        for t in threads:
            t.start()
        deadline[0] = time.monotonic() + a.seconds
        go.set()
        for t in threads:
            t.join()
        if errors:
            raise errors[0]
        st = stats(s.port)
        lw = st["insert_lock_wait_us"]
        print(f"scans done={len(scans)}  client latency {summary(scans)}")
        print(f"inserts done={len(writes)}  client latency {summary(writes)}  (end to end: queue wait + lock wait + run)")
        print(f"INSERT lock wait (server /stats): p99={lw['p99'] / 1000:.1f} ms  max={lw['max'] / 1000:.1f} ms  "
              f"samples={lw['samples']}  limit=100 ms -> {'OK' if lw['p99'] < 100000 else 'OVER'}")
        print(f"rejected={st['rejected']} processed={st['processed']}")
    finally:
        s.stop()
        s.cleanup()


if __name__ == "__main__":
    main()
