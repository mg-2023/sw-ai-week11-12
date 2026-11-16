"""
B+ 트리 인덱스 성능 비교

id = 1 ~ N 인 행을 CSV 테이블에 넣어 두고, 같은 SELECT 문을
  - B+ 트리 인덱스를 쓰지 않는 CSVDatabase(use_index=False): CSV 를 처음부터 끝까지 읽음
  - B+ 트리 인덱스를 쓰는 CSVDatabase(use_index=True): 트리에서 id 로 바로 찾음
로 실행해서 걸린 시간을 비교한다.

사용법:
    python app/benchmark_index.py                        # 50만 행, id = 500000 조회
    python app/benchmark_index.py -n 100000 --id 1 -r 10
    python app/benchmark_index.py --data-dir bench_data  # 만든 CSV 를 지우지 않고 남김
"""

from __future__ import annotations

import argparse
import csv
import statistics
import sys
import tempfile
import time
from pathlib import Path

from sqlparser import CSVDatabase, Executor, Parser, SelectResult, _display_width, _pad

TABLE = "bench_users"  # data/users.csv 와 겹치지 않도록 별도 테이블 이름 사용


def make_table(data_dir: Path, n: int) -> Path:
    """id 1 ~ n 인 행을 가진 CSV 테이블을 새로 만든다 (이미 있으면 덮어씀)"""
    data_dir.mkdir(parents=True, exist_ok=True)
    path = data_dir / f"{TABLE}.csv"
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow(["id", "name", "age", "email"])
        writer.writerows([i, f"user{i}", 20 + i % 50, f"user{i}@example.com"] for i in range(1, n + 1))
    return path


def time_query(db: CSVDatabase, sql: str, repeat: int) -> tuple[list[float], SelectResult]:
    """SQL 을 repeat 번 실행해 각 실행 시간(초)과 마지막 결과를 돌려준다. 파싱 시간은 빼고 실행만 잰다"""
    (stmt,) = list(Parser(sql).iter_statements())
    executor = Executor(db)
    times = []
    result = None
    for _ in range(repeat):
        start = time.perf_counter()
        result = executor.execute(stmt)
        times.append(time.perf_counter() - start)
    return times, result


def _ms(seconds: float) -> str:
    return f"{seconds * 1000:,.3f} ms"


def run(n: int, target_id: int, repeat: int, data_dir: Path, out=sys.stdout) -> dict:
    # 1. 데이터 준비
    start = time.perf_counter()
    path = make_table(data_dir, n)
    prepare = time.perf_counter() - start
    size_mb = path.stat().st_size / 1024 / 1024
    print(f"데이터 준비: {path.name} 에 {n:,}개 행 ({size_mb:.1f} MB) 작성 - {prepare:.2f} s", file=out)

    sql = f"SELECT * FROM {TABLE} WHERE id = {target_id}"
    print(f"쿼리: {sql}  (각각 {repeat}회 실행)\n", file=out)

    # 2. 인덱스 없이: 실행할 때마다 CSV 전체 스캔
    scan_times, scan_result = time_query(CSVDatabase(data_dir, use_index=False), sql, repeat)

    # 3. 인덱스 사용: 트리는 처음 접근할 때 한 번 만들어지므로 생성 시간은 따로 잰다
    db = CSVDatabase(data_dir)
    start = time.perf_counter()
    index = db.index(TABLE)
    build = time.perf_counter() - start
    index_times, index_result = time_query(db, sql, repeat)

    # 참고: SELECT 처리(헤더 읽기, 결과 만들기 등)를 뺀 트리 탐색 자체의 시간
    lookups = 10_000
    start = time.perf_counter()
    for _ in range(lookups):
        index.tree.get(target_id)
    tree_get = (time.perf_counter() - start) / lookups

    if scan_result.rows != index_result.rows:
        raise RuntimeError(f"두 방식의 결과가 다릅니다: {scan_result.rows} != {index_result.rows}")
    if scan_result.used_index or not index_result.used_index:
        raise RuntimeError("인덱스 사용 여부가 예상과 다릅니다")

    scan_avg, index_avg = statistics.mean(scan_times), statistics.mean(index_times)
    rows = [
        ("인덱스 없음 (CSV 전체 스캔)", scan_avg, min(scan_times)),
        ("B+ 트리 인덱스", index_avg, min(index_times)),
    ]
    # 한글은 터미널에서 2칸을 차지하므로 sqlparser 의 표시 너비 함수로 맞춘다
    print(_pad("", 30) + " " * (14 - _display_width("평균")) + "평균" + " " * (14 - _display_width("최소")) + "최소", file=out)
    for label, avg, best in rows:
        print(f"{_pad(label, 30)}{_ms(avg):>14}{_ms(best):>14}", file=out)
    speedup = scan_avg / index_avg if index_avg > 0 else float("inf")
    print(f"\n→ 인덱스를 쓰면 평균 약 {speedup:,.0f}배 빠름", file=out)

    print(f"\n참고", file=out)
    print(f"- B+ 트리 생성 (처음 1회, CSV 전체 읽기 + {n:,}번 삽입): {build:.2f} s", file=out)
    print(f"- 트리 정보: order {index.tree.order}, 높이 {index.tree.height}, 키 {len(index.tree):,}개", file=out)
    print(f"- 트리 탐색만 (tree.get, {lookups:,}회 평균): {tree_get * 1_000_000:,.2f} µs", file=out)
    print(f"- 조회 결과: {index_result.rows}", file=out)

    return {
        "scan_times": scan_times,
        "index_times": index_times,
        "build": build,
        "tree_get": tree_get,
        "rows": index_result.rows,
        "speedup": speedup,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="B+ 트리 인덱스 사용/미사용 시 id 조회 시간을 비교합니다.")
    parser.add_argument("-n", "--rows", type=int, default=500_000, help="넣을 행 수 (id 1 ~ N, 기본값 500000)")
    parser.add_argument("--id", type=int, default=None, help="조회할 id (기본값: N, 즉 마지막 행)")
    parser.add_argument("-r", "--repeat", type=int, default=5, help="각 방식으로 쿼리를 실행할 횟수 (기본값 5)")
    parser.add_argument(
        "-d", "--data-dir", default=None,
        help=f"{TABLE}.csv 를 만들 디렉토리 (기본값: 임시 디렉토리, 끝나면 삭제)",
    )
    args = parser.parse_args(argv)
    if args.rows < 1 or args.repeat < 1:
        parser.error("행 수와 반복 횟수는 1 이상이어야 합니다")
    target_id = args.rows if args.id is None else args.id

    if args.data_dir:
        run(args.rows, target_id, args.repeat, Path(args.data_dir))
    else:
        with tempfile.TemporaryDirectory() as tmp:
            run(args.rows, target_id, args.repeat, Path(tmp))
    return 0


if __name__ == "__main__":
    sys.exit(main())
