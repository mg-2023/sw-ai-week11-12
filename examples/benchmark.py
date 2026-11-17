"""
benchmark.py

정의 : Mini Redis 의 처리량 · 지연 시간 분포와, 캐시 사용 전후의 API 응답 시간 · 적중률을 재는 스크립트.
설명 : 서버는 임의 포트로 직접 띄우고 끝나면 종료한다. 파이썬 표준 라이브러리만 쓴다.
"""
import argparse
import platform
import socket
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXE = ".exe" if sys.platform == "win32" else ""
SERVER = ROOT / f"mini-redis{EXE}"
REPORT_API = ROOT / f"report-api{EXE}"


def start(cmd):
    """서버를 띄우고 첫 줄 "listening on host:port" 에서 포트를 읽어 (프로세스, 포트)를 돌려준다."""
    process = subprocess.Popen([str(c) for c in cmd], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    line = process.stdout.readline().strip()
    if " listening on " not in line:
        process.kill()
        raise RuntimeError(f"failed to start {cmd[0]}: {line!r}")
    return process, int(line.rsplit(":", 1)[1])


def stop(process):
    """띄운 서버를 종료하고 파이프를 닫는다."""
    process.kill()
    process.wait(timeout=5)
    process.stdout.close()
    process.stderr.close()


def frame(*args):
    """명령을 RESP2 배열로 인코딩한다."""
    out = b"*%d\r\n" % len(args)
    for arg in args:
        data = arg if isinstance(arg, bytes) else str(arg).encode()
        out += b"$%d\r\n%s\r\n" % (len(data), data)
    return out


def read_reply(stream):
    """응답 하나를 끝까지 읽는다 (단순 문자열 · 오류 · 정수 · bulk string 만 다룬다)."""
    line = stream.readline()
    if not line:
        raise ConnectionError("connection closed")
    if line[:1] == b"$" and line[:3] != b"$-1":
        stream.read(int(line[1:]) + 2)
    return line


def percentile(sorted_ms, pct):
    """정렬된 지연 목록에서 pct 번째 백분위(가장 가까운 순위 방식)를 고른다."""
    rank = -(-len(sorted_ms) * pct // 100)
    return sorted_ms[max(0, min(len(sorted_ms) - 1, rank - 1))]


def summarize(latencies, elapsed):
    """지연 목록(ms)과 전체 걸린 시간(초)으로 처리량 · 분포를 계산한다."""
    ordered = sorted(latencies)
    return {
        "rps": len(ordered) / elapsed,
        "avg": statistics.fmean(ordered),
        "p50": percentile(ordered, 50),
        "p95": percentile(ordered, 95),
        "p99": percentile(ordered, 99),
        "max": ordered[-1],
    }


def run_command_bench(port, make_request, total, clients, setup=None):
    """연결 clients 개(스레드)로 요청 total 개를 나눠 보내고 요청마다 지연을 잰다."""
    if setup:
        setup(port)
    per_client = [total // clients + (1 if i < total % clients else 0) for i in range(clients)]
    results = [[] for _ in range(clients)]
    errors = []
    ready = threading.Barrier(clients + 1)

    def worker(index):
        try:
            sock = socket.create_connection(("127.0.0.1", port), timeout=10)
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            stream = sock.makefile("rb")
            ready.wait()
            for n in range(per_client[index]):
                payload = make_request(index, n)
                start_time = time.perf_counter()
                sock.sendall(payload)
                read_reply(stream)
                results[index].append((time.perf_counter() - start_time) * 1000)
            sock.close()
        except Exception as error:  # noqa: BLE001
            errors.append(error)
            ready.abort()

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(clients)]
    for thread in threads:
        thread.start()
    ready.wait()
    begin = time.perf_counter()
    for thread in threads:
        thread.join()
    elapsed = time.perf_counter() - begin
    if errors:
        raise RuntimeError(f"client error: {errors[0]!r}")
    return summarize([ms for part in results for ms in part], elapsed)


def prefill(port, keys, value):
    """GET 측정에 쓸 키를 미리 채운다."""
    sock = socket.create_connection(("127.0.0.1", port), timeout=10)
    stream = sock.makefile("rb")
    for key in keys:
        sock.sendall(frame("SET", key, value))
        read_reply(stream)
    sock.close()


def benchmark_commands(requests, clients_list, value_size):
    """명령별(SET, GET 적중, GET 없는 키, INCR, DEL) 측정을 돌려 행 목록을 돌려준다."""
    value = b"x" * value_size
    rows = []
    process, port = start([SERVER, "--port", "0"])
    try:
        for clients in clients_list:
            keys = [f"hit:{c}:{n}" for c in range(clients) for n in range(requests // clients + 1)]
            cases = [
                ("SET", lambda c, n: frame("SET", f"key:{c}:{n}", value), None),
                ("GET (hit)", lambda c, n: frame("GET", f"hit:{c}:{n}"), lambda p: prefill(p, keys, value)),
                ("GET (miss)", lambda c, n: frame("GET", f"none:{c}:{n}"), None),
                ("INCR", lambda c, n: frame("INCR", f"counter:{c}"), None),
                ("DEL", lambda c, n: frame("DEL", f"key:{c}:{n}"), None),
            ]
            for name, make_request, setup in cases:
                result = run_command_bench(port, make_request, requests, clients, setup)
                rows.append({"command": name, "clients": clients, **result})
    finally:
        stop(process)
    return rows


def http_get(port, path):
    """report-api 에 GET 을 보내고 (X-Cache, 본문, 지연 ms)를 돌려준다. 연결은 요청마다 새로 맺는다."""
    start_time = time.perf_counter()
    sock = socket.create_connection(("127.0.0.1", port), timeout=10)
    sock.sendall(f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n".encode())
    data = b""
    while chunk := sock.recv(4096):
        data += chunk
    sock.close()
    elapsed = (time.perf_counter() - start_time) * 1000
    head, _, body = data.partition(b"\r\n\r\n")
    cache = ""
    for line in head.decode().split("\r\n"):
        if line.lower().startswith("x-cache:"):
            cache = line.split(":", 1)[1].strip()
    return cache, body, elapsed


def benchmark_cache(http_requests):
    """캐시 사용(빈 캐시에서 시작)과 미사용 경로를 각각 http_requests 번 요청해 결과를 돌려준다."""
    redis, redis_port = start([SERVER, "--port", "0"])
    api = None
    try:
        api, api_port = start([REPORT_API, "--port", "0", "--redis-port", str(redis_port)])
        outcome = {}
        bodies = {}
        for label, path in (("cache on", "/v1/report"), ("cache off", "/v1/report?cache=off")):
            latencies, counts = [], {"hit": 0, "miss": 0, "bypass": 0}
            begin = time.perf_counter()
            for _ in range(http_requests):
                cache, body, ms = http_get(api_port, path)
                latencies.append(ms)
                counts[cache] = counts.get(cache, 0) + 1
                bodies[label] = body
            elapsed = time.perf_counter() - begin
            hits, misses = counts["hit"], counts["miss"]
            outcome[label] = {**summarize(latencies, elapsed), "hit": hits, "miss": misses,
                              "ratio": hits / (hits + misses) if hits + misses else None}
        outcome["same_body"] = bodies["cache on"] == bodies["cache off"]
        return outcome
    finally:
        if api:
            stop(api)
        stop(redis)


def render(args, command_rows, cache):
    """결과를 마크다운 표 문자열로 만든다. 같은 문자열을 표준 출력에도 쓴다."""
    lines = [
        f"측정 시각 : {time.strftime('%Y-%m-%d %H:%M:%S')}, {platform.platform()}, CPU {platform.processor() or 'unknown'}",
        "", "## 측정 1 : Mini Redis 명령별 처리량과 지연 (ms)", "",
        f"요청 수 {args.requests}, 값 크기 {args.value_size}바이트, 파이프라인 없음, 파이썬 소켓 클라이언트(스레드)",
        "", "| 명령 | 연결 수 | 처리량 (req/s) | avg | p50 | p95 | p99 | max |", "|---|---|---|---|---|---|---|---|",
    ]
    for r in command_rows:
        lines.append(f"| {r['command']} | {r['clients']} | {r['rps']:.0f} | {r['avg']:.3f} | {r['p50']:.3f} | "
                     f"{r['p95']:.3f} | {r['p99']:.3f} | {r['max']:.3f} |")
    lines += ["", "## 측정 2 : 캐시 사용 전후 (GET /v1/report) (ms)", "",
              f"요청 수 {args.http_requests} (모드마다), 연결 1개씩 순서대로, 요청마다 새 HTTP 연결", "",
              "| 모드 | 처리량 (req/s) | avg | p50 | p95 | p99 | max | hit | miss | 적중률 |",
              "|---|---|---|---|---|---|---|---|---|---|"]
    for label in ("cache on", "cache off"):
        r = cache[label]
        ratio = "-" if r["ratio"] is None else f"{r['ratio'] * 100:.1f}%"
        lines.append(f"| {label} | {r['rps']:.1f} | {r['avg']:.3f} | {r['p50']:.3f} | {r['p95']:.3f} | "
                     f"{r['p99']:.3f} | {r['max']:.3f} | {r['hit']} | {r['miss']} | {ratio} |")
    lines += ["", f"두 모드의 응답 본문 동일 여부 : {'같음' if cache['same_body'] else '다름'}"]
    return "\n".join(lines) + "\n"


def main():
    """옵션을 읽어 두 측정을 돌리고 표를 출력(및 저장)한다."""
    parser = argparse.ArgumentParser(description="Mini Redis benchmark")
    parser.add_argument("--requests", type=int, default=10000)
    parser.add_argument("--http-requests", type=int, default=200)
    parser.add_argument("--clients", type=int, nargs="+", default=[1, 8])
    parser.add_argument("--value-size", type=int, default=64)
    parser.add_argument("--markdown", metavar="FILE")
    args = parser.parse_args()
    for exe in (SERVER, REPORT_API):
        if not exe.exists():
            sys.exit(f"missing executable: {exe}")
    text = render(args, benchmark_commands(args.requests, args.clients, args.value_size),
                  benchmark_cache(args.http_requests))
    print(text)
    if args.markdown:
        Path(args.markdown).write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
