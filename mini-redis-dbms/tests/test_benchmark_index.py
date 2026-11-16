import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from benchmark_index import TABLE, make_table, run  # noqa: E402


class BenchmarkTest(unittest.TestCase):
    """50만 행은 오래 걸리므로 작은 데이터로 스크립트가 제대로 도는지만 확인한다"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_make_table(self):
        path = make_table(self.data_dir, 3)
        self.assertEqual(path.name, f"{TABLE}.csv")
        self.assertEqual(
            path.read_text(encoding="utf-8").splitlines(),
            ["id,name,age,email", "1,user1,21,user1@example.com", "2,user2,22,user2@example.com",
             "3,user3,23,user3@example.com"],
        )

    def test_run_compares_both_ways(self):
        out = io.StringIO()
        stats = run(2000, 2000, 2, self.data_dir, out=out)
        self.assertEqual(stats["rows"], [["2000", "user2000", "20", "user2000@example.com"]])
        self.assertEqual(len(stats["scan_times"]), 2)
        self.assertEqual(len(stats["index_times"]), 2)
        text = out.getvalue()
        self.assertIn("인덱스 없음 (CSV 전체 스캔)", text)
        self.assertIn("B+ 트리 인덱스", text)

    def test_missing_id(self):
        stats = run(100, 101, 1, self.data_dir, out=io.StringIO())
        self.assertEqual(stats["rows"], [])


if __name__ == "__main__":
    unittest.main()
