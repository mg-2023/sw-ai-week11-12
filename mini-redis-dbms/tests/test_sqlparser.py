import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from sqlparser import (  # noqa: E402
    CSVDatabase,
    Executor,
    InsertStatement,
    Parser,
    SelectStatement,
    SQLError,
    run_script,
    tokenize,
)


class TokenizerTest(unittest.TestCase):
    def test_keywords_are_case_insensitive(self):
        types = [(t.type, t.value) for t in tokenize("select * FrOm users")][:4]
        self.assertEqual(types, [("KEYWORD", "SELECT"), ("SYMBOL", "*"), ("KEYWORD", "FROM"), ("IDENT", "users")])

    def test_string_escape_and_comments(self):
        tokens = tokenize("-- 주석\n'O''Brien' /* 블록\n주석 */ 42")
        self.assertEqual([(t.type, t.value, t.line) for t in tokens[:2]], [("STRING", "O'Brien", 2), ("NUMBER", "42", 3)])

    def test_unterminated_string(self):
        with self.assertRaises(SQLError):
            tokenize("SELECT * FROM users WHERE name = 'abc")


class ParserTest(unittest.TestCase):
    def parse(self, sql):
        return list(Parser(sql).iter_statements())

    def test_insert_with_columns_and_multiple_rows(self):
        (stmt,) = self.parse("INSERT INTO users (id, name) VALUES (1, 'a'), (2, 'b');")
        self.assertIsInstance(stmt, InsertStatement)
        self.assertEqual(stmt.table, "users")
        self.assertEqual(stmt.columns, ["id", "name"])
        self.assertEqual(stmt.rows, [["1", "a"], ["2", "b"]])

    def test_select_where(self):
        (stmt,) = self.parse("SELECT name FROM users WHERE age > 20 AND (name = 'a' OR NOT id = 3)")
        self.assertIsInstance(stmt, SelectStatement)
        self.assertEqual(stmt.columns, ["name"])
        self.assertIsNotNone(stmt.where)

    def test_syntax_error_does_not_stop_next_statement(self):
        items = self.parse("SELECT FROM users; DELETE FROM users; SELECT * FROM users")
        self.assertIsInstance(items[0], SQLError)
        self.assertIsInstance(items[1], SQLError)
        self.assertIsInstance(items[2], SelectStatement)

    def test_missing_semicolon_between_statements(self):
        items = self.parse("SELECT * FROM users SELECT * FROM users")
        self.assertIsInstance(items[0], SQLError)


class ExecutorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name)
        (self.data_dir / "users.csv").write_text("id,name,age\n1,김철수,25\n2,이영희,31\n", encoding="utf-8")
        self.db = CSVDatabase(self.data_dir)
        self.executor = Executor(self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def run_sql(self, sql):
        (stmt,) = list(Parser(sql).iter_statements())
        return self.executor.execute(stmt)

    def test_insert_then_select(self):
        self.run_sql("INSERT INTO users VALUES (3, '박민수', 28)")
        result = self.run_sql("SELECT * FROM users WHERE id = 3")
        self.assertEqual(result.columns, ["id", "name", "age"])
        self.assertEqual(result.rows, [["3", "박민수", "28"]])

    def test_insert_partial_columns_fills_empty(self):
        self.run_sql("INSERT INTO users (name, id) VALUES ('홍길동', 9)")
        result = self.run_sql("SELECT id, name, age FROM users WHERE id = 9")
        self.assertEqual(result.rows, [["9", "홍길동", ""]])

    def test_insert_value_with_comma_is_quoted_in_csv(self):
        self.run_sql("INSERT INTO users VALUES (3, 'a, b', 1)")
        self.assertIn('"a, b"', (self.data_dir / "users.csv").read_text(encoding="utf-8"))
        self.assertEqual(self.run_sql("SELECT name FROM users WHERE id = 3").rows, [["a, b"]])

    def test_numeric_comparison(self):
        self.run_sql("INSERT INTO users VALUES (3, 'x', 100)")
        # 문자열 비교였다면 '100' < '25' 가 되어버린다
        result = self.run_sql("SELECT name FROM users WHERE age > 30")
        self.assertEqual(result.rows, [["이영희"], ["x"]])

    def test_and_or_not(self):
        result = self.run_sql("SELECT id FROM users WHERE NOT (age < 30 OR name = 'zzz') AND id >= 1")
        self.assertEqual(result.rows, [["2"]])

    def test_append_to_file_without_trailing_newline(self):
        (self.data_dir / "t.csv").write_text("a,b\n1,2", encoding="utf-8")
        self.run_sql("INSERT INTO t VALUES (3, 4)")
        self.assertEqual(self.run_sql("SELECT * FROM t").rows, [["1", "2"], ["3", "4"]])

    def test_errors(self):
        with self.assertRaises(SQLError):
            self.run_sql("SELECT * FROM nothing")
        with self.assertRaises(SQLError):
            self.run_sql("SELECT nope FROM users")
        with self.assertRaises(SQLError):
            self.run_sql("INSERT INTO users VALUES (1, 'a')")  # 값 개수 부족
        # 실패한 INSERT 는 파일을 건드리지 않는다
        self.assertEqual(len(self.run_sql("SELECT * FROM users").rows), 2)

    def test_run_script_continues_after_error(self):
        out = io.StringIO()
        errors = run_script(
            "INSERT INTO users VALUES (3, 'a', 1);\nSELECT * FROM missing;\nSELECT name FROM users WHERE id = 3;",
            self.db,
            out=out,
        )
        self.assertEqual(errors, 1)
        self.assertIn("1개 행 조회", out.getvalue())


if __name__ == "__main__":
    unittest.main()
