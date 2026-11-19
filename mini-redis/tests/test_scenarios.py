"""발표 장면 통합 시험 : 실제 mini-redis 프로세스와 TCP 연결, 시연 로그 파일로 확인한다.

실행 : python tests/test_scenarios.py -v   (mingw32-make 로 빌드한 뒤)
- 카운터 갱신 유실 (연결 두 개, 실행 순번)
- 만료 : 조회 시 만료 / 조회 없는 주기 정리
- TTL 이 남은 키의 DEL 무효화
- 장애 복구 : 스냅샷 · AOF 강제 종료 뒤 재시작, 삭제 · 만료 반영, 불완전한 AOF 끝, AOF 쓰기 실패, 스냅샷 쓰기 중 종료
"""
import argparse
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parent.parent
EXE = ".exe" if os.name == "nt" else ""
SERVER = ROOT / ("mini-redis" + EXE)
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_integration import frame, reply  # noqa: E402  (같은 RESP 도우미를 쓴다)

EXEC = re.compile(r"EXEC #(\d+) conn=(\d+) (\S+)")


class Server:
    """mini-redis 를 --port 0 --log 로 띄우고 연결 · 로그 읽기를 돕는 도우미"""

    def __init__(self, workdir, *args):
        self.log = Path(workdir) / f"server-{time.monotonic_ns()}.log"
        self.process = subprocess.Popen([str(SERVER), "--port", "0", "--log", str(self.log), *args],
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        line = self.process.stdout.readline().strip()
        if " listening on " not in line:
            self.process.wait(timeout=5)
            raise RuntimeError(f"failed to start: {line!r} {self.process.stderr.read()}")
        self.port = int(line.rsplit(":", 1)[1])

    def connect(self):
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        return sock, sock.makefile("rb")

    def call(self, *args):
        sock, stream = self.connect()
        with sock, stream:
            sock.sendall(frame(*args))
            return reply(stream)

    def lines(self):
        return self.log.read_text(encoding="utf-8").splitlines()

    def kill(self):
        """정리 코드 없이 강제 종료한다 (Windows TerminateProcess / POSIX SIGKILL)"""
        self.process.kill()
        self.process.wait(timeout=5)
        self.close_pipes()

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)
        self.close_pipes()

    def close_pipes(self):
        self.process.stdout.close()
        self.process.stderr.close()


class ScenarioTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="mini-redis-")
        self.servers = []

    def tearDown(self):
        for server in self.servers:
            server.stop()
        shutil.rmtree(self.dir, ignore_errors=True)

    def start(self, *args):
        server = Server(self.dir, *args)
        self.servers.append(server)
        return server

    def path(self, name):
        return str(Path(self.dir) / name)

    # ───────── 동시성 ─────────

    def test_lost_update_with_two_connections(self):
        server = self.start()
        self.assertEqual(server.call("SET", "counter", "0"), b"+OK")
        a, a_stream = server.connect()
        b, b_stream = server.connect()
        with a, a_stream, b, b_stream:
            def call(sock, stream, *args):
                sock.sendall(frame(*args))
                return reply(stream)
            read_a = call(a, a_stream, "GET", "counter")
            read_b = call(b, b_stream, "GET", "counter")
            self.assertEqual((read_a, read_b), (b"0", b"0"))
            self.assertEqual(call(a, a_stream, "SET", "counter", str(int(read_a) + 1)), b"+OK")
            self.assertEqual(call(b, b_stream, "SET", "counter", str(int(read_b) + 1)), b"+OK")
        self.assertEqual(server.call("GET", "counter"), b"1")
        time.sleep(0.05)
        executed = [m.groups() for m in map(EXEC.search, server.lines()) if m]
        # 실행 순번 2~5 가 A GET, B GET, A SET, B SET 순서이고 연결 ID 가 번갈아 나온다
        steps = [(int(seq), int(conn), name) for seq, conn, name in executed[1:5]]
        self.assertEqual([s[0] for s in steps], [2, 3, 4, 5])
        self.assertEqual([s[2] for s in steps], ["GET", "GET", "SET", "SET"])
        self.assertEqual(steps[0][1], steps[2][1])
        self.assertEqual(steps[1][1], steps[3][1])
        self.assertNotEqual(steps[0][1], steps[1][1])

    def test_exec_and_sent_are_logged_separately(self):
        server = self.start()
        self.assertEqual(server.call("PING"), b"+PONG")
        time.sleep(0.05)
        lines = server.lines()
        exec_at = next(i for i, l in enumerate(lines) if "EXEC #1" in l)
        sent_at = next(i for i, l in enumerate(lines) if "SENT #1" in l)
        self.assertLess(exec_at, sent_at)
        self.assertIn("reply queued in output buffer (7 bytes)", lines[exec_at])
        self.assertIn("7 bytes written to socket", lines[sent_at])

    # ───────── 만료 ─────────

    def test_expired_key_is_removed_on_access(self):
        server = self.start("--expire-cycle-ms", "0")  # 주기 정리를 꺼 조회 시 만료만 남긴다
        self.assertEqual(server.call("SET", "session:lazy", "v", "PX", "100"), b"+OK")
        time.sleep(0.3)
        self.assertIsNone(server.call("GET", "session:lazy"))
        time.sleep(0.05)
        log = "\n".join(server.lines())
        self.assertIn('EXPIRE on-access key="session:lazy" (found expired inside #2', log)
        self.assertNotIn("by-cycle", log)

    def test_unread_key_is_removed_by_cycle(self):
        server = self.start()  # 기본 100ms 주기
        self.assertEqual(server.call("SET", "cache:ghost", "v", "PX", "100"), b"+OK")
        self.assertEqual(server.call("SET", "cache:alive", "v", "EX", "60"), b"+OK")
        time.sleep(0.5)  # 그동안 cache:ghost 를 아무도 조회하지 않는다
        log = "\n".join(server.lines())
        self.assertIn('EXPIRE by-cycle  key="cache:ghost"', log)
        self.assertRegex(log, r"CYCLE checked 2 of 2 TTL keys from cursor \(limit 32\), removed 1")
        self.assertNotIn("on-access", log)
        self.assertEqual(server.call("GET", "cache:alive"), b"v")

    # ───────── 무효화 ─────────

    def test_delete_invalidates_key_with_remaining_ttl(self):
        server = self.start()
        self.assertEqual(server.call("SET", "cache:report", "v1", "EX", "30"), b"+OK")
        self.assertGreater(server.call("PTTL", "cache:report"), 29000)
        self.assertEqual(server.call("DEL", "cache:report"), 1)
        self.assertIsNone(server.call("GET", "cache:report"))
        self.assertEqual(server.call("DEL", "cache:report"), 0)
        time.sleep(0.05)
        log = "\n".join(server.lines())
        self.assertIn('DEL "cache:report" -> (integer) 1', log)
        self.assertIn('GET "cache:report" -> (nil)', log)

    # ───────── 장애 복구 ─────────

    def crash_cycle(self, options, checkpoint):
        """v1 저장 → (기준 시점) → v2 갱신 → 강제 종료 → 2초 뒤 재시작, 재시작한 서버를 돌려준다"""
        server = self.start(*options)
        self.assertEqual(server.call("SET", "user:1", "v1"), b"+OK")
        self.assertEqual(server.call("SET", "temp", "x"), b"+OK")
        self.assertEqual(server.call("DEL", "temp"), 1)
        self.assertEqual(server.call("SET", "short", "s", "PX", "1500"), b"+OK")
        self.assertEqual(server.call("SET", "long", "l", "PX", "10000"), b"+OK")
        if checkpoint:
            self.assertEqual(server.call("SAVE"), b"+OK")
        self.assertEqual(server.call("SET", "user:1", "v2"), b"+OK")
        server.kill()
        time.sleep(2)
        return self.start(*options)

    def test_snapshot_restores_last_saved_point(self):
        restarted = self.crash_cycle(["--snapshot", self.path("dump.mrdb")], checkpoint=True)
        self.assertEqual(restarted.call("GET", "user:1"), b"v1")  # SAVE 뒤의 v2 는 잃는다
        self.assertIsNone(restarted.call("GET", "temp"))           # SAVE 전에 지운 키는 되살아나지 않는다
        self.assertIsNone(restarted.call("GET", "short"))          # 꺼져 있는 동안 만료
        self.assertTrue(0 < restarted.call("PTTL", "long") < 8500)      # TTL 이 10000 으로 다시 시작하지 않는다
        self.assertIn("1 skipped as expired during downtime", "\n".join(restarted.lines()))

    def test_snapshot_loses_delete_after_last_save(self):
        """스냅샷의 한계 : 마지막 SAVE 뒤의 DEL 은 기록되지 않아 그 키가 다시 나타난다"""
        options = ["--snapshot", self.path("dump.mrdb")]
        server = self.start(*options)
        self.assertEqual(server.call("SET", "k", "v"), b"+OK")
        self.assertEqual(server.call("SAVE"), b"+OK")
        self.assertEqual(server.call("DEL", "k"), 1)
        server.kill()
        self.assertEqual(self.start(*options).call("GET", "k"), b"v")

    def test_aof_always_restores_v2_and_deletes(self):
        restarted = self.crash_cycle(["--aof", self.path("appendonly.aof"), "--appendfsync", "always"],
                                     checkpoint=False)
        self.assertEqual(restarted.call("GET", "user:1"), b"v2")
        self.assertIsNone(restarted.call("GET", "temp"))
        self.assertIsNone(restarted.call("GET", "short"))
        self.assertTrue(0 < restarted.call("PTTL", "long") < 8500)
        log = "\n".join(restarted.lines())
        self.assertIn("6 records applied, 1 skipped as expired during downtime", log)

    def test_aof_records_expire_change_and_delete_after_ttl_change(self):
        options = ["--aof", self.path("appendonly.aof"), "--appendfsync", "always"]
        server = self.start(*options)
        self.assertEqual(server.call("SET", "a", "1"), b"+OK")
        self.assertEqual(server.call("PEXPIRE", "a", "60000"), 1)
        self.assertEqual(server.call("SET", "b", "2"), b"+OK")
        self.assertEqual(server.call("EXPIRE", "b", "0"), 1)  # 즉시 삭제는 DEL 로 기록된다
        server.kill()
        restarted = self.start(*options)
        self.assertGreater(restarted.call("PTTL", "a"), 50000)
        self.assertIsNone(restarted.call("GET", "b"))
        record = Path(self.path("appendonly.aof")).read_bytes()
        self.assertIn(b"PEXPIREAT", record)
        self.assertIn(b"*2\r\n$3\r\nDEL\r\n$1\r\nb\r\n", record)

    def test_everysec_fsync_is_not_delayed_by_a_long_expire_cycle(self):
        # 주기 정리를 5초로 늘려도, 쓰기 뒤 요청이 더 없을 때 everysec fsync 는 약 1초 안에 일어나야 한다
        server = self.start("--aof", self.path("appendonly.aof"), "--appendfsync", "everysec",
                            "--expire-cycle-ms", "5000")
        self.assertEqual(server.call("SET", "k", "v"), b"+OK")
        deadline = time.monotonic() + 2.5
        while time.monotonic() < deadline:
            if any("AOF  everysec fsync done" in line for line in server.lines()):
                break
            time.sleep(0.05)
        else:
            self.fail("everysec fsync did not happen within 2.5s after the write")

    def test_aof_incomplete_last_record_is_truncated(self):
        options = ["--aof", self.path("appendonly.aof")]
        server = self.start(*options)
        self.assertEqual(server.call("SET", "a", "1"), b"+OK")
        server.kill()
        with open(self.path("appendonly.aof"), "ab") as file:
            file.write(b"*3\r\n$3\r\nSET\r\n$1\r\nb\r\n$5\r\n12")  # 쓰다 만 마지막 레코드
        restarted = self.start(*options)
        self.assertEqual(restarted.call("GET", "a"), b"1")
        self.assertIsNone(restarted.call("GET", "b"))
        self.assertIn("1 records applied", "\n".join(restarted.lines()))
        self.assertIn("26 bytes of incomplete tail truncated", "\n".join(restarted.lines()))

    def test_aof_write_failure_sends_no_reply_and_stops(self):
        options = ["--aof", self.path("appendonly.aof"), "--appendfsync", "always"]
        server = self.start(*options, "--debug-aof-fail-at", "2")
        self.assertEqual(server.call("SET", "a", "1"), b"+OK")
        with self.assertRaises((ValueError, ConnectionError)):  # 응답 없이 연결이 끊긴다
            server.call("SET", "b", "2")
        self.assertNotEqual(server.process.wait(timeout=5), 0)
        self.assertIn("FAILED: injected write failure", "\n".join(server.lines()))
        restarted = self.start(*options)
        self.assertEqual(restarted.call("GET", "a"), b"1")
        self.assertIsNone(restarted.call("GET", "b"))

    def test_snapshot_crash_during_save_keeps_previous_file(self):
        path = self.path("dump.mrdb")
        server = self.start("--snapshot", path)
        self.assertEqual(server.call("SET", "k", "v1"), b"+OK")
        self.assertEqual(server.call("SAVE"), b"+OK")
        server.stop()
        crashing = self.start("--snapshot", path, "--debug-snapshot-crash-after", "1")
        self.assertEqual(crashing.call("SET", "k", "v2"), b"+OK")
        self.assertEqual(crashing.call("SET", "other", "x"), b"+OK")
        with self.assertRaises((ValueError, ConnectionError)):  # SAVE 도중 프로세스가 끝난다
            crashing.call("SAVE")
        self.assertEqual(crashing.process.wait(timeout=5), 3)
        self.assertTrue(Path(path + ".tmp").exists())  # 쓰다 만 임시 파일이 남는다
        self.assertEqual(self.start("--snapshot", path).call("GET", "k"), b"v1")

    def test_aof_restores_incr_counter(self):
        options = ["--aof", self.path("appendonly.aof"), "--appendfsync", "always"]
        server = self.start(*options)
        for expected in (1, 2, 3):
            self.assertEqual(server.call("INCR", "room:seats"), expected)
        server.kill()
        self.assertEqual(self.start(*options).call("GET", "room:seats"), b"3")

    def test_snapshot_restores_incr_counter_at_last_save(self):
        options = ["--snapshot", self.path("dump.mrdb")]
        server = self.start(*options)
        self.assertEqual(server.call("INCR", "room:seats"), 1)
        self.assertEqual(server.call("INCR", "room:seats"), 2)
        self.assertEqual(server.call("SAVE"), b"+OK")
        self.assertEqual(server.call("INCR", "room:seats"), 3)  # SAVE 뒤의 변경은 잃는다
        server.kill()
        self.assertEqual(self.start(*options).call("GET", "room:seats"), b"2")

    def test_save_without_snapshot_option_is_an_error(self):
        self.assertTrue(self.start().call("SAVE").startswith(b"-ERR snapshot is disabled"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", type=Path, default=SERVER)
    paths, unittest_args = parser.parse_known_args()
    SERVER = paths.server.resolve()
    unittest.main(argv=[sys.argv[0], *unittest_args])
