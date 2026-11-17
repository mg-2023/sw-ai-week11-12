import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from http.client import HTTPConnection
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
from threading import Barrier
import time
import unittest


ROOT = Path(__file__).resolve().parent.parent
EXE = ".exe" if os.name == "nt" else ""
SERVER = ROOT / ("mini-redis" + EXE)
REPORT = ROOT / ("report-api" + EXE)


@contextmanager
def run_server(executable, *args):
    with subprocess.Popen(
        [str(executable), "--port", "0", *args], stdout=subprocess.PIPE, text=True,
    ) as process:
        try:
            line = process.stdout.readline().strip()
            if " listening on " not in line:
                raise RuntimeError(f"{executable.name} failed to start: {line}")
            yield int(line.rsplit(":", 1)[1])
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def frame(*args):
    parts = [f"*{len(args)}\r\n".encode()]
    for arg in args:
        data = arg.encode() if isinstance(arg, str) else arg
        parts.extend([f"${len(data)}\r\n".encode(), data, b"\r\n"])
    return b"".join(parts)


def reply(stream):
    line = stream.readline()
    if not line.endswith(b"\r\n"):
        raise ValueError(f"Invalid or incomplete reply: {line!r}")
    prefix, text = line[:1], line[1:-2]
    if prefix in (b"+", b"-"):
        return prefix + text
    if prefix == b":":
        return int(text)
    if prefix == b"$":
        length = int(text)
        if length == -1:
            return None
        payload = stream.read(length + 2)
        if len(payload) != length + 2 or not payload.endswith(b"\r\n"):
            raise ValueError("Invalid bulk reply")
        return payload[:-2]
    raise ValueError(f"Unknown RESP reply: {line!r}")


def connect(port):
    return socket.create_connection(("127.0.0.1", port), timeout=5)


def command(port, *args):
    with connect(port) as client, client.makefile("rb") as stream:
        client.sendall(frame(*args))
        return reply(stream)


def report_request(port, suffix=""):
    connection = HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request("GET", "/v1/report" + suffix)
        with connection.getresponse() as response:
            return response.status, response.getheader("X-Cache"), json.load(response)
    finally:
        connection.close()


class IntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server = run_server(SERVER)
        cls.port = server.__enter__()
        cls.addClassCleanup(server.__exit__, None, None, None)

    def test_binary_crud_and_multiple_delete(self):
        key = b"\x00\r\n\xff"
        self.assertEqual(command(self.port, "sEt", key, b"\xff\x00\r\n"), b"+OK")
        self.assertEqual(command(self.port, "GET", key), b"\xff\x00\r\n")
        self.assertEqual(command(self.port, "SET", key, b""), b"+OK")
        self.assertEqual(command(self.port, "GET", key), b"")
        self.assertEqual(command(self.port, "SET", b"", "empty key"), b"+OK")
        self.assertEqual(command(self.port, "DEL", key, key, b"", "absent"), 2)
        self.assertIsNone(command(self.port, "GET", key))

    def test_ttl_and_invalid_ttl(self):
        self.assertEqual(command(self.port, "SET", "ttl", "old", "EX", "30"), b"+OK")
        self.assertGreater(command(self.port, "PTTL", "ttl"), 0)
        for ttl in ("0", "-1", "nan", "9223372036854775807", "9223372036854775808"):
            self.assertTrue(command(self.port, "SET", "ttl", "bad", "EX", ttl).startswith(b"-ERR"))
        self.assertEqual(command(self.port, "GET", "ttl"), b"old")
        self.assertEqual(command(self.port, "SET", "ttl", "new"), b"+OK")
        self.assertEqual(command(self.port, "PTTL", "ttl"), -1)
        self.assertEqual(command(self.port, "PEXPIRE", "ttl", "50"), 1)
        time.sleep(0.15)
        self.assertIsNone(command(self.port, "GET", "ttl"))
        self.assertEqual(command(self.port, "PTTL", "ttl"), -2)
        self.assertEqual(command(self.port, "EXPIRE", "ttl", "10"), 0)
        self.assertEqual(command(self.port, "SET", "ttl", "new"), b"+OK")
        self.assertEqual(command(self.port, "EXPIRE", "ttl", "0"), 1)
        self.assertIsNone(command(self.port, "GET", "ttl"))

    def test_partial_frames_do_not_block_other_clients_and_pipeline_is_ordered(self):
        with connect(self.port) as slow, slow.makefile("rb") as stream:
            request = frame("SET", "partial", "complete")
            slow.sendall(request[:-3])
            self.assertEqual(command(self.port, "PING"), b"+PONG")
            self.assertIsNone(command(self.port, "GET", "partial"))
            slow.sendall(request[-3:] + frame("GET", "partial") + frame("DEL", "partial"))
            self.assertEqual([reply(stream), reply(stream), reply(stream)], [b"+OK", b"complete", 1])

    def test_bad_command_keeps_connection_and_bad_frame_closes_it(self):
        with connect(self.port) as client, client.makefile("rb") as stream:
            client.sendall(frame("GET") + frame("PING") + b"*1\r\n$1048577\r\n")
            self.assertTrue(reply(stream).startswith(b"-ERR wrong number"))
            self.assertEqual(reply(stream), b"+PONG")
            self.assertEqual(reply(stream), b"-ERR invalid RESP2 frame")
            self.assertEqual(stream.read(), b"")
        self.assertEqual(command(self.port, "PING"), b"+PONG")

    def test_large_binary_response_and_backpressure(self):
        key = b"k" * (1024 * 1024)
        value = bytes(range(256)) * 4096
        self.assertEqual(command(self.port, "SET", key, value), b"+OK")
        self.assertEqual(command(self.port, "GET", key), value)
        self.assertEqual(command(self.port, "DEL", key), 1)

        self.assertEqual(command(self.port, "SET", "large-reply", value), b"+OK")
        with connect(self.port) as slow, slow.makefile("rb") as stream:
            slow.sendall(frame("GET", "large-reply") * 8)
            self.assertEqual(command(self.port, "PING"), b"+PONG")
            for _ in range(8):
                self.assertEqual(reply(stream), value)
        self.assertEqual(command(self.port, "DEL", "large-reply"), 1)

    def test_concurrent_clients_and_same_key_deletion(self):
        workers = 12
        barrier = Barrier(workers)
        self.assertEqual(command(self.port, "SET", "shared", "value"), b"+OK")

        def workload(worker):
            with connect(self.port) as client, client.makefile("rb") as stream:
                barrier.wait(timeout=5)
                client.sendall(frame("DEL", "shared"))
                deleted = reply(stream)
                for i in range(30):
                    key = f"worker:{worker}:{i}"
                    value = f"{worker}:{i}"
                    client.sendall(frame("SET", key, value) + frame("GET", key))
                    self.assertEqual((reply(stream), reply(stream)), (b"+OK", value.encode()))
                return deleted

        with ThreadPoolExecutor(max_workers=workers) as executor:
            results = list(executor.map(workload, range(workers)))
        self.assertEqual(sorted(results), [0] * (workers - 1) + [1])

    def test_incr_creates_and_increments(self):
        self.assertEqual(command(self.port, "INCR", "incr:new"), 1)
        self.assertEqual(command(self.port, "INCR", "incr:new"), 2)
        self.assertEqual(command(self.port, "GET", "incr:new"), b"2")
        self.assertEqual(command(self.port, "SET", "incr:n", "10"), b"+OK")
        self.assertEqual(command(self.port, "INCR", "incr:n"), 11)
        self.assertEqual(command(self.port, "SET", "incr:n", "-1"), b"+OK")
        self.assertEqual(command(self.port, "INCR", "incr:n"), 0)
        self.assertEqual(command(self.port, "GET", "incr:n"), b"0")
        self.assertTrue(command(self.port, "INCR").startswith(b"-ERR wrong number"))
        self.assertTrue(command(self.port, "INCR", "a", "b").startswith(b"-ERR wrong number"))

    def test_incr_rejects_non_integer_and_overflow_without_changing_value(self):
        error = b"-ERR value is not an integer or out of range"
        for value in (b"abc", b"", b"1.5", b" 1", b"+1", b"007", b"9223372036854775808"):
            self.assertEqual(command(self.port, "SET", "incr:s", value), b"+OK")
            self.assertEqual(command(self.port, "INCR", "incr:s"), error, value)
            self.assertEqual(command(self.port, "GET", "incr:s"), value)
        self.assertEqual(command(self.port, "SET", "incr:big", "9223372036854775807"), b"+OK")
        self.assertEqual(command(self.port, "INCR", "incr:big"), b"-ERR increment or decrement would overflow")
        self.assertEqual(command(self.port, "GET", "incr:big"), b"9223372036854775807")
        self.assertEqual(command(self.port, "SET", "incr:min", "-9223372036854775808"), b"+OK")
        self.assertEqual(command(self.port, "INCR", "incr:min"), -9223372036854775807)

    def test_incr_keeps_ttl(self):
        self.assertEqual(command(self.port, "SET", "incr:t", "5", "EX", "100"), b"+OK")
        self.assertEqual(command(self.port, "INCR", "incr:t"), 6)
        self.assertTrue(0 < command(self.port, "PTTL", "incr:t") <= 100000)

    def test_incr_on_expired_key_starts_from_zero_without_ttl(self):
        self.assertEqual(command(self.port, "SET", "incr:gone", "41", "PX", "30"), b"+OK")
        time.sleep(0.1)
        self.assertEqual(command(self.port, "INCR", "incr:gone"), 1)
        self.assertEqual(command(self.port, "PTTL", "incr:gone"), -1)

    def test_concurrent_incr_gives_each_client_a_distinct_number(self):
        workers = 12
        barrier = Barrier(workers)

        def enter(_):
            with connect(self.port) as client, client.makefile("rb") as stream:
                barrier.wait(timeout=5)
                client.sendall(frame("INCR", "incr:room"))
                return reply(stream)

        with ThreadPoolExecutor(max_workers=workers) as executor:
            results = list(executor.map(enter, range(workers)))
        self.assertEqual(sorted(results), list(range(1, workers + 1)))
        self.assertEqual(command(self.port, "GET", "incr:room"), b"12")

    def test_external_http_api_fills_reads_and_refreshes_the_cache(self):
        with run_server(REPORT, "--redis-port", str(self.port)) as http_port:
            expected = {"orders": 12, "total_cents": 4200}
            self.assertEqual(report_request(http_port), (200, "miss", expected))
            self.assertEqual(json.loads(command(self.port, "GET", "sample-report")), expected)
            self.assertGreater(command(self.port, "PTTL", "sample-report"), 0)
            replacement = b'{"orders":99}'
            self.assertEqual(command(self.port, "SET", "sample-report", replacement), b"+OK")
            self.assertEqual(report_request(http_port), (200, "hit", {"orders": 99}))
            self.assertEqual(report_request(http_port, "?cache=off"), (200, "bypass", expected))
            self.assertEqual(command(self.port, "DEL", "sample-report"), 1)
            self.assertEqual(report_request(http_port), (200, "miss", expected))
            self.assertEqual(command(self.port, "PEXPIRE", "sample-report", "40"), 1)
            time.sleep(0.15)
            self.assertEqual(report_request(http_port), (200, "miss", expected))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", type=Path, default=SERVER)
    parser.add_argument("--report", type=Path, default=REPORT)
    paths, unittest_args = parser.parse_known_args()
    SERVER = paths.server.resolve()
    REPORT = paths.report.resolve()
    unittest.main(argv=[sys.argv[0], *unittest_args])
