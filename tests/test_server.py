"""Black-box tests for `mini-dbms serve` (Phase 3, Task 13).

Run: python tests/test_server.py   (needs build/mini-dbms.exe, `mingw32-make all`)
Every test starts its own server on a free port (--port 0) with a unique data
folder under build/, and stops it at the end.
"""

from contextlib import contextmanager
import json
from pathlib import Path
import random
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
EXE = ROOT / "build" / "mini-dbms.exe"
IS_WINDOWS = sys.platform == "win32"


class Server:
    """One server process plus its data folder."""

    def __init__(self, *args, data=None):
        (ROOT / "build").mkdir(exist_ok=True)
        self.owns_data = data is None
        self.data = data or ROOT / "build" / f"server-test-{uuid.uuid4().hex}"
        if self.owns_data:
            self.data.mkdir()
            shutil.copyfile(ROOT / "data" / "catalog.txt", self.data / "catalog.txt")
        flags = subprocess.CREATE_NEW_PROCESS_GROUP if IS_WINDOWS else 0
        self.proc = subprocess.Popen(
            [str(EXE), "serve", "--port", "0", "--data", str(self.data), *args],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=flags)
        line = self.proc.stdout.readline().decode()      # "listening 127.0.0.1:PORT"
        if not line.startswith("listening 127.0.0.1:"):
            self.proc.kill()
            raise AssertionError("server did not start: " + line + self.proc.stderr.read().decode())
        self.port = int(line.rsplit(":", 1)[1])

    def stop(self):
        """Send the console interrupt and wait; returns the exit code."""
        if self.proc.poll() is None:
            self.proc.send_signal(signal.CTRL_BREAK_EVENT if IS_WINDOWS else signal.SIGINT)
        try:
            return self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            raise AssertionError("server did not stop within 5 seconds")

    def cleanup(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        for pipe in (self.proc.stdout, self.proc.stderr):
            pipe.close()
        if self.owns_data:
            assert self.data.resolve().is_relative_to((ROOT / "build").resolve())
            shutil.rmtree(self.data, ignore_errors=True)


@contextmanager
def server(*args, data=None):
    s = Server(*args, data=data)
    try:
        yield s
    finally:
        if s.proc.poll() is None:
            s.stop()
        s.cleanup()


def raw_request(port, payload, timeout=10):
    """Send raw bytes, read until close; returns (status, parsed JSON or None)."""
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as c:
        c.sendall(payload)
        chunks = []
        while True:
            try:
                data = c.recv(65536)
            except ConnectionResetError:
                break
            if not data:
                break
            chunks.append(data)
    reply = b"".join(chunks)
    head, _, body = reply.partition(b"\r\n\r\n")
    status = int(head.split(b" ", 2)[1])
    return status, json.loads(body) if body else None


def http(port, method, path, body=None, timeout=10):
    data = b"" if body is None else body.encode() if isinstance(body, str) else body
    head = f"{method} {path} HTTP/1.1\r\nHost: x\r\n"
    if method == "POST":
        head += f"Content-Length: {len(data)}\r\n"
    return raw_request(port, head.encode() + b"\r\n" + data, timeout)


def query(port, sql, timeout=10):
    return http(port, "POST", "/query", sql, timeout)


def ok_query(port, sql):
    status, body = query(port, sql)
    assert status == 200 and body["ok"], (status, body)
    return body


def fill_users(port, rows):
    """Insert rows named user_<id> (ids start at 1 on an empty table), 1000 per statement."""
    for first in range(0, rows, 1000):
        count = min(1000, rows - first)
        values = ",".join(f"('user_{first + i + 1}',{(first + i) % 100})" for i in range(count))
        ok_query(port, f"INSERT INTO users VALUES {values};")


def stats(port):
    status, body = http(port, "GET", "/stats")
    assert status == 200, (status, body)
    return body


def run_threads(count, work):
    """Run work(i) on count threads; re-raise the first failure."""
    errors = []

    def wrap(i):
        try:
            work(i)
        except BaseException as exc:      # report every thread's failure
            errors.append(exc)

    threads = [threading.Thread(target=wrap, args=(i,)) for i in range(count)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    if errors:
        raise errors[0]


def stalled_connection(port):
    """Connect and send only part of a header: the worker waits until its read deadline."""
    c = socket.create_connection(("127.0.0.1", port))
    c.sendall(b"POST /query HTTP/1.1\r\nHost: x\r\n")
    return c


# ---- tests -----------------------------------------------------------------

def test_query_roundtrip():
    with server() as s:
        body = ok_query(s.port, "INSERT INTO users VALUES ('ann', 30), ('bob', 41);")
        assert body["results"][0]["inserted_ids"] == [1, 2]
        assert body["results"][0]["plan"] == "none"
        body = ok_query(s.port, "SELECT * FROM users WHERE id = 2;")
        r = body["results"][0]
        assert r["columns"] == ["id", "name", "age"]
        assert r["rows"] == [[2, "bob", 41]]
        assert r["plan"] == "index" and r["rows_examined"] == 1
        assert body["elapsed_us"] >= 0 and 0 <= body["worker"] < 4
        body = ok_query(s.port, "SELECT name FROM users WHERE name = 'ann'; SELECT * FROM users LIMIT 1;")
        assert body["results"][0]["plan"] == "scan" and body["results"][0]["rows"] == [["ann"]]
        assert len(body["results"]) == 2


def test_health_stats():
    with server("--threads", "3", "--queue", "7") as s:
        assert http(s.port, "GET", "/health") == (200, {"ok": True})
        ok_query(s.port, "INSERT INTO users VALUES ('ann', 30);")
        st = stats(s.port)
        assert st["workers"] == 3 and st["queue_capacity"] == 7
        assert st["tables"]["users"]["rows"] == 1 and st["tables"]["games"]["rows"] == 0
        assert st["processed"] >= 2 and st["rejected"] == 0
        assert st["busy"] >= 1 and st["queued"] == 0       # the /stats request itself is running
        lw = st["insert_lock_wait_us"]
        assert lw["samples"] == 1 and lw["p99"] >= 0 and lw["max"] >= lw["p99"]
        assert http(s.port, "GET", "/nope")[0] == 404
        assert http(s.port, "GET", "/query")[0] == 405
        assert http(s.port, "POST", "/health", "x")[0] == 405


def test_concurrent_inserts():
    with server("--sync", "none") as s:
        ids = [[] for _ in range(8)]

        def work(i):
            for k in range(1000):
                body = ok_query(s.port, f"INSERT INTO users VALUES ('t{i}_{k}', {k});")
                ids[i] += body["results"][0]["inserted_ids"]

        run_threads(8, work)
        flat = [x for part in ids for x in part]
        assert len(flat) == 8000 and len(set(flat)) == 8000
        body = ok_query(s.port, "SELECT id FROM users;")
        assert len(body["results"][0]["rows"]) == 8000
        assert stats(s.port)["tables"]["users"]["rows"] == 8000


def test_concurrent_index_reads():
    with server("--sync", "none") as s:
        fill_users(s.port, 10000)

        def work(i):
            rng = random.Random(i)
            for _ in range(2000):
                want = rng.randint(1, 10000)
                body = ok_query(s.port, f"SELECT * FROM users WHERE id = {want};")
                r = body["results"][0]
                assert r["plan"] == "index" and r["rows"] == [[want, f"user_{want}", (want - 1) % 100]], (want, r)

        run_threads(8, work)


def test_mixed_read_write_lock_wait():
    with server("--sync", "none") as s:
        fill_users(s.port, 20000)
        deadline = time.monotonic() + 5.0
        counts = {"read": 0, "write": 0}

        def work(i):
            while time.monotonic() < deadline:
                if i < 6:
                    ok_query(s.port, "SELECT * FROM users WHERE name = 'nobody';")
                    counts["read"] += 1
                else:
                    ok_query(s.port, f"INSERT INTO users VALUES ('w{i}', 1);")
                    counts["write"] += 1

        run_threads(8, work)
        lw = stats(s.port)["insert_lock_wait_us"]
        print(f"    reads={counts['read']} writes={counts['write']} insert lock wait p99={lw['p99']}us max={lw['max']}us")
        assert counts["read"] > 0 and counts["write"] > 0
        assert lw["samples"] >= counts["write"] > 0 and lw["p99"] < 100_000, lw


def test_queue_full_503():
    with server("--threads", "1", "--queue", "1") as s:
        busy = stalled_connection(s.port)          # the only worker waits for its header
        time.sleep(0.3)
        queued = stalled_connection(s.port)        # fills the queue
        time.sleep(0.3)
        started = time.monotonic()
        status, body = http(s.port, "GET", "/health")
        assert status == 503 and body["ok"] is False, (status, body)
        assert time.monotonic() - started < 1.0, "503 must be immediate"
        busy.close(); queued.close()
        time.sleep(0.5)
        assert stats(s.port)["rejected"] >= 1


def test_slow_clients():
    with server("--threads", "4") as s:
        slow = [stalled_connection(s.port) for _ in range(4)]
        time.sleep(0.3)
        started = time.monotonic()
        status, body = query(s.port, "INSERT INTO users VALUES ('ann', 1);", timeout=8)
        took = time.monotonic() - started
        assert status in (200, 503), (status, body)
        assert took < 5.0, took
        print(f"    normal request during 4 slow clients: {status} in {took:.2f}s")
        for c in slow:
            c.close()
        status, _ = query(s.port, "SELECT * FROM users;")
        assert status == 200


def test_bad_http_400():
    with server() as s:
        for payload in (b"GARBAGE\r\n\r\n",
                        b"POST /query HTTP/1.1\r\nHost: x\r\n\r\nSELECT 1;",          # no Content-Length
                        b"POST /query HTTP/1.1\r\nContent-Length: abc\r\n\r\n",
                        b"POST /query HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
                        b"get /health HTTP/1.1\r\n\r\n"):
            status, body = raw_request(s.port, payload)
            assert status == 400 and body["ok"] is False, (payload, status, body)
        assert http(s.port, "GET", "/health")[0] == 200
        # a client that sends half a header and stays silent gets 408 after the 2 s read deadline
        c = stalled_connection(s.port)
        c.settimeout(6)
        reply = c.recv(4096)
        c.close()
        assert reply.startswith(b"HTTP/1.1 408"), reply


def test_bare_lf_gets_400_at_once():
    with server() as s:
        started = time.monotonic()
        status, body = raw_request(s.port, b"POST /query HTTP/1.1\nHost: x\nContent-Length: 5\n\nxxxxx")
        took = time.monotonic() - started
        assert status == 400 and body["ok"] is False, (status, body)
        assert took < 1.0, took      # not the 2 s read deadline (408)


def test_body_longer_than_content_length_still_gets_its_answer():
    with server() as s:
        for extra in (10, 300 * 1024, 2 * 1024 * 1024):
            sql = b"INSERT INTO users VALUES ('ann', 1);"
            payload = (b"POST /query HTTP/1.1\r\nContent-Length: %d\r\n\r\n" % len(sql)) + sql + b"x" * extra
            status, body = raw_request(s.port, payload)
            assert status == 200 and body["ok"] is True, (extra, status, body)
        assert http(s.port, "GET", "/health")[0] == 200


def test_body_413():
    with server() as s:
        too_big = "SELECT * FROM users; --" + "x" * (1024 * 1024)
        status, body = query(s.port, too_big)
        assert status == 413 and body["ok"] is False, (status, body)
        # also rejected from the header alone, before the body is sent
        status, _ = raw_request(s.port, b"POST /query HTTP/1.1\r\nContent-Length: 2000000\r\n\r\n")
        assert status == 413
        assert http(s.port, "GET", "/health")[0] == 200


def test_sql_error_400_committed():
    with server() as s:
        status, body = query(s.port, "INSERT INTO users VALUES ('ann', 1);\nINSERT INTO users VALUES ('bob');\nSELECT * FROM users;")
        assert status == 400 and body["ok"] is False, (status, body)
        err = body["error"]
        assert err["statement"] == 1 and err["line"] == 2 and err["col"] >= 1 and "VALUES" in err["message"], err
        assert body["committed"] == 1
        status, body = query(s.port, "SELECT * FROM nope;")
        assert status == 400 and body["committed"] == 0
        assert ok_query(s.port, "SELECT * FROM users;")["results"][0]["rows"] == [[1, "ann", 1]]


def test_result_too_large_400():
    with server("--sync", "none") as s:
        text = "y" * 60000
        for _ in range(300):                        # 300 x 60000 bytes > 16 MiB result limit
            ok_query(s.port, f"INSERT INTO users VALUES ('{text}', 1);")
        status, body = query(s.port, "SELECT * FROM users;", timeout=30)
        assert status == 400 and "16 MiB" in body["error"]["message"], (status, body)
        assert ok_query(s.port, "SELECT * FROM users LIMIT 10;")["results"][0]["rows"][0][0] == 1


def test_largest_insert_body_bounded():
    """The 1 MiB body limit bounds one statement, hence how long one write lock is held."""
    with server("--sync", "none") as s:
        row = "('" + "z" * 20 + "',1),"
        sql = "INSERT INTO users VALUES " + row * 20000
        sql = sql[:-1] + ";"
        assert len(sql) < 1024 * 1024
        started = time.monotonic()
        body = ok_query(s.port, sql)
        took = time.monotonic() - started
        print(f"    one ~{len(sql) // 1024} KiB INSERT of {len(body['results'][0]['inserted_ids'])} rows took {took * 1000:.0f} ms")
        lw = stats(s.port)["insert_lock_wait_us"]
        assert lw["samples"] == 1


def test_graceful_shutdown():
    data = ROOT / "build" / f"server-test-{uuid.uuid4().hex}"
    data.mkdir()
    shutil.copyfile(ROOT / "data" / "catalog.txt", data / "catalog.txt")
    try:
        s = Server(data=data)
        try:
            for i in range(20):
                ok_query(s.port, f"INSERT INTO users VALUES ('n{i}', {i});")
            idle = stalled_connection(s.port)       # a connection still open when the signal arrives
            started = time.monotonic()
            code = s.stop()
            took = time.monotonic() - started
            idle.close()
            assert code == 0, code
            assert took < 5.0, took
        finally:
            s.cleanup()
        with server(data=data) as again:
            rows = ok_query(again.port, "SELECT * FROM users;")["results"][0]["rows"]
            assert len(rows) == 20 and rows[19] == [20, "n19", 19], rows[-1]
    finally:
        shutil.rmtree(data, ignore_errors=True)


def main():
    if not EXE.exists():
        print(f"missing {EXE}; run mingw32-make all first")
        return 1
    only = sys.argv[1:]
    tests = [(n, f) for n, f in globals().items() if n.startswith("test_") and callable(f)
             and (not only or n in only)]
    passed = failed = 0
    for name, fn in tests:
        started = time.monotonic()
        try:
            fn()
            passed += 1
            print(f"ok   {name} ({time.monotonic() - started:.1f}s)", flush=True)
        except BaseException as exc:
            failed += 1
            print(f"FAIL {name}: {type(exc).__name__}: {exc}", flush=True)
    print(f"SERVER: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
