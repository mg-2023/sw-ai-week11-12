"""Mini Redis 발표용 재현 스크립트.

실행 : python examples/demo.py <장면>   (먼저 mingw32-make 로 mini-redis.exe 를 빌드한다)
장면 : lost-update | incr | expire | invalidate | recovery-snapshot | recovery-aof | all

각 장면은 새 Mini Redis 프로세스를 --port 0 --log 파일 로 띄우고, 클라이언트가 보낸 명령 · 받은 응답과
서버 시연 로그(EXEC = 실행 후 응답을 출력 버퍼에 넣음, SENT = 소켓으로 다 보냄)를 그대로 출력한다.
결과를 미리 적어 두지 않는다. 화면의 값은 모두 실행 중에 받은 응답이다.
"""
import argparse
from contextlib import contextmanager
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
EXE = ".exe" if os.name == "nt" else ""
SERVER = ROOT / ("mini-redis" + EXE)
OUT = ROOT / "demo-output"


def frame(*args):
    """명령 인자를 RESP2 배열 바이트로 만든다"""
    parts = [f"*{len(args)}\r\n".encode()]
    for arg in args:
        data = arg.encode() if isinstance(arg, str) else arg
        parts.extend([f"${len(data)}\r\n".encode(), data, b"\r\n"])
    return b"".join(parts)


def read_reply(stream):
    """RESP2 응답 하나를 읽어 파이썬 값으로 바꾼다 (nil 은 None)"""
    line = stream.readline()
    if not line.endswith(b"\r\n"):
        raise ConnectionError(f"connection closed or incomplete reply: {line!r}")
    prefix, text = line[:1], line[1:-2]
    if prefix in (b"+", b"-"):
        return (prefix + text).decode()
    if prefix == b":":
        return int(text)
    length = int(text)
    if length == -1:
        return None
    return stream.read(length + 2)[:-2].decode(errors="replace")


def show(value):
    """응답 값을 redis-cli 처럼 보이게 바꾼다"""
    if value is None:
        return "(nil)"
    if isinstance(value, int):
        return f"(integer) {value}"
    if value.startswith("+"):
        return value[1:]
    if value.startswith("-"):
        return "(error) " + value[1:]
    return f'"{value}"'


class Client:
    """Mini Redis 에 TCP 연결 하나를 맺고 명령을 한 개씩 보내는 클라이언트"""

    def __init__(self, port, name):
        self.name = name
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=5)
        self.stream = self.sock.makefile("rb")

    def call(self, *args, quiet=False):
        self.sock.sendall(frame(*args))
        value = read_reply(self.stream)
        if not quiet:
            print(f"  [{self.name}] {' '.join(args):<40} -> {show(value)}")
        return value

    def close(self):
        self.stream.close()
        self.sock.close()


@contextmanager
def server(log_name, *args):
    """Mini Redis 를 임의 포트로 띄우고 (포트, 로그 경로, 프로세스) 를 넘긴다. 끝나면 정상 종료한다"""
    OUT.mkdir(exist_ok=True)
    log = OUT / log_name
    process = start(log, *args)
    try:
        yield process.port, log, process
    finally:
        stop(process)


def start(log, *args):
    """서버 프로세스를 띄우고 첫 줄에서 포트를 읽는다 (복원 결과 LOAD 줄은 표준 오류로 나온다)"""
    process = subprocess.Popen([str(SERVER), "--port", "0", "--log", str(log.relative_to(ROOT)), *args],
                               cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    line = process.stdout.readline().strip()
    if " listening on " not in line:
        raise RuntimeError(f"server failed to start: {line} {process.stderr.read()}")
    process.port = int(line.rsplit(":", 1)[1])
    return process


def stop(process):
    """서버를 정상 종료한다 (이미 끝났으면 그대로)"""
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def kill(process):
    """프로세스를 강제 종료한다 (Windows TerminateProcess / POSIX SIGKILL) — 정리 코드가 돌지 않는다"""
    process.kill()
    process.wait(timeout=5)


def print_log(log, *needles):
    """시연 로그 중 needles 중 하나를 포함한 줄만 출력한다 (needles 가 없으면 전부)"""
    time.sleep(0.05)
    print(f"  --- server log ({log.relative_to(ROOT)}) ---")
    for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
        if not needles or any(n in line for n in needles):
            print("  " + line)


def lost_update():
    print("\n## 카운터 갱신 유실 : 연결 두 개가 GET 뒤 SET 을 나눠 보낸다")
    with server("lost-update.log") as (port, log, _):
        a, b = Client(port, "A"), Client(port, "B")
        a.call("SET", "counter", "0")
        read_a = a.call("GET", "counter")
        read_b = b.call("GET", "counter")
        a.call("SET", "counter", str(int(read_a) + 1))
        b.call("SET", "counter", str(int(read_b) + 1))
        final = a.call("GET", "counter")
        print(f"  => 두 클라이언트가 각각 +1 했지만 최종값 {show(final)} (기대값 \"2\")")
        a.close()
        b.close()
        print_log(log, "EXEC", "SENT", "CONN")


def incr():
    print("\n## INCR : 연결 두 개가 같은 키에 INCR 을 보내면 서버가 읽고 더하고 쓰기를 한 명령으로 처리한다")
    with server("incr.log") as (port, log, _):
        a, b = Client(port, "A"), Client(port, "B")
        got_a = a.call("INCR", "room:1:seats")
        got_b = b.call("INCR", "room:1:seats")
        print(f"  => 두 클라이언트가 서로 다른 번호 {got_a}, {got_b} 를 받았다 (기대값 1, 2)")
        a.close()
        b.close()
        print_log(log, "EXEC", "SENT", "CONN")


def expire():
    print("\n## 만료 1 : 조회 시 만료 (주기 정리를 끈 서버 --expire-cycle-ms 0)")
    with server("expire-on-access.log", "--expire-cycle-ms", "0") as (port, log, _):
        c = Client(port, "C")
        c.call("SET", "session:lazy", "v", "PX", "100")
        time.sleep(0.3)
        c.call("GET", "session:lazy")
        c.close()
        print_log(log, "EXEC", "EXPIRE")
    print("\n## 만료 2 : 주기 정리 (기본 100ms 주기, 키를 아무도 조회하지 않음)")
    with server("expire-by-cycle.log") as (port, log, _):
        c = Client(port, "C")
        c.call("SET", "cache:ghost", "v", "PX", "100")
        c.call("SET", "cache:alive", "v", "EX", "60")
        print("  (0.5초 동안 아무 명령도 보내지 않는다)")
        time.sleep(0.5)
        c.close()
        print_log(log, "EXEC", "EXPIRE", "CYCLE")


def invalidate():
    print("\n## 무효화 : TTL 이 남은 키를 DEL")
    with server("invalidate.log") as (port, log, _):
        c = Client(port, "C")
        c.call("SET", "cache:report", "v1", "EX", "30")
        c.call("PTTL", "cache:report")
        c.call("DEL", "cache:report")
        c.call("GET", "cache:report")
        c.close()
        print_log(log, "EXEC")


def recovery(mode):
    title = "RDB 방식 스냅샷" if mode == "snapshot" else "AOF (appendfsync always)"
    print(f"\n## 장애 복구 : {title}")
    OUT.mkdir(exist_ok=True)
    data = OUT / ("dump.mrdb" if mode == "snapshot" else "appendonly.aof")
    for leftover in (data, Path(str(data) + ".tmp")):
        leftover.unlink(missing_ok=True)
    relative = str(data.relative_to(ROOT))
    options = ["--snapshot", relative] if mode == "snapshot" else ["--aof", relative, "--appendfsync", "always"]
    log1 = OUT / f"recovery-{mode}-before.log"
    process = start(log1, *options)
    c = Client(process.port, "C")
    c.call("SET", "user:1", "v1")
    c.call("SET", "temp", "x")
    c.call("DEL", "temp")
    c.call("SET", "short", "s", "PX", "1500")
    c.call("SET", "long", "l", "PX", "10000")
    if mode == "snapshot":
        c.call("SAVE")
        print("  ^ 스냅샷 기준 시점")
    c.call("SET", "user:1", "v2")
    print("  강제 종료 : process.kill() (Windows TerminateProcess) — 정상 종료 처리 없이 끝남")
    kill(process)
    c.close()
    print("  2초 대기 (서버가 꺼져 있는 동안 short 의 TTL 1.5초가 지남)")
    time.sleep(2)
    log2 = OUT / f"recovery-{mode}-after.log"
    process = start(log2, *options)
    c = Client(process.port, "C")
    for key in ("user:1", "temp", "short"):
        c.call("GET", key)
    pttl = c.call("PTTL", "long")
    print(f"  => long 의 남은 TTL {pttl}ms : 10000ms 로 다시 시작하지 않고 꺼져 있던 시간만큼 줄었다")
    c.close()
    stop(process)
    print_log(log1, "AOF", "SNAP", "EXEC")
    print_log(log2, "LOAD", "EXEC")
    if mode == "aof":
        print(f"  --- AOF 파일 ({relative}) : 레코드 하나를 한 줄로, CRLF 대신 공백 ---")
        for record in data.read_bytes().split(b"\r\n*"):
            text = record.replace(b"\r\n", b" ").decode(errors="replace").strip()
            print("  " + (text if text.startswith("*") else "*" + text))


SCENES = {
    "lost-update": lost_update,
    "incr": incr,
    "expire": expire,
    "invalidate": invalidate,
    "recovery-snapshot": lambda: recovery("snapshot"),
    "recovery-aof": lambda: recovery("aof"),
}

if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("scene", choices=[*SCENES, "all"])
    parser.add_argument("--server", type=Path, default=SERVER)
    options = parser.parse_args()
    SERVER = options.server.resolve()
    for name, scene in SCENES.items():
        if options.scene in (name, "all"):
            scene()
