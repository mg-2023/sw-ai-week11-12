import contextlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from sqlparser import (  # noqa: E402
    CreateTableStatement,
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

    def test_create_table(self):
        (stmt,) = self.parse("create table IF NOT EXISTS users (id, name, age, email);")
        self.assertIsInstance(stmt, CreateTableStatement)
        self.assertEqual(stmt.table, "users")
        self.assertEqual(stmt.columns, ["id", "name", "age", "email"])
        self.assertTrue(stmt.if_not_exists)

    def test_create_table_rejects_column_types(self):
        (item,) = self.parse("CREATE TABLE users (id INT, name)")
        self.assertIsInstance(item, SQLError)

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

    def test_create_then_insert_and_select(self):
        result = self.run_sql("CREATE TABLE 상품 (코드, 이름, 가격)")
        self.assertTrue(result.created)
        self.assertEqual((self.data_dir / "상품.csv").read_text(encoding="utf-8"), "코드,이름,가격\n")
        self.run_sql("INSERT INTO 상품 VALUES ('A1', '연필', 500)")
        self.assertEqual(self.run_sql("SELECT 이름 FROM 상품 WHERE 가격 < 1000").rows, [["연필"]])

    def test_create_existing_table(self):
        with self.assertRaises(SQLError):
            self.run_sql("CREATE TABLE users (a, b)")
        result = self.run_sql("CREATE TABLE IF NOT EXISTS users (a, b)")
        self.assertFalse(result.created)
        # 기존 테이블은 그대로
        self.assertEqual(self.run_sql("SELECT * FROM users").columns, ["id", "name", "age"])

    def test_create_duplicate_columns(self):
        with self.assertRaises(SQLError):
            self.run_sql("CREATE TABLE t (id, ID)")
        self.assertFalse((self.data_dir / "t.csv").exists())

    def test_create_makes_missing_data_dir(self):
        db = CSVDatabase(self.data_dir / "new" / "dir")
        (stmt,) = list(Parser("CREATE TABLE t (a)").iter_statements())
        Executor(db).execute(stmt)
        self.assertTrue((self.data_dir / "new" / "dir" / "t.csv").is_file())

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


class IdIndexTest(unittest.TestCase):
    """id 컬럼이 있는 테이블의 자동 id 부여와 B+ 트리 인덱스 조회"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name)
        self.csv = self.data_dir / "users.csv"
        self.csv.write_text("id,name,age\n1,김철수,25\n2,이영희,31\n", encoding="utf-8")
        self.db = CSVDatabase(self.data_dir, index_order=4)  # 작은 order 로 분할이 자주 일어나게
        self.executor = Executor(self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def run_sql(self, sql, executor=None):
        (stmt,) = list(Parser(sql).iter_statements())
        return (executor or self.executor).execute(stmt)

    # ---- INSERT: id 자동 부여 ----
    def test_auto_id_when_id_column_omitted(self):
        result = self.run_sql("INSERT INTO users (name, age) VALUES ('박민수', 28), ('최지우', 22)")
        self.assertEqual(result.ids, [3, 4])
        self.assertTrue(self.csv.read_text(encoding="utf-8").endswith("3,박민수,28\n4,최지우,22\n"))
        self.assertEqual(self.run_sql("SELECT name FROM users WHERE id = 4").rows, [["최지우"]])

    def test_empty_id_is_auto_assigned(self):
        result = self.run_sql("INSERT INTO users VALUES ('', '박민수', 28)")
        self.assertEqual(result.ids, [3])

    def test_explicit_id_moves_next_id(self):
        self.assertEqual(self.run_sql("INSERT INTO users VALUES (10, 'a', 1)").ids, [10])
        self.assertEqual(self.run_sql("INSERT INTO users (name) VALUES ('b')").ids, [11])
        # 비어 있는 작은 id 를 직접 지정하는 것도 가능 (next_id 는 그대로)
        self.assertEqual(self.run_sql("INSERT INTO users VALUES (5, 'c', 1)").ids, [5])
        self.assertEqual(self.run_sql("INSERT INTO users (name) VALUES ('d')").ids, [12])

    def test_mixed_explicit_and_auto_in_one_statement(self):
        result = self.run_sql("INSERT INTO users VALUES (7, 'a', 1), ('', 'b', 2)")
        self.assertEqual(result.ids, [7, 8])

    def test_id_is_normalized(self):
        self.run_sql("INSERT INTO users VALUES ('007', 'a', 1)")
        self.assertIn("\n7,a,1\n", self.csv.read_text(encoding="utf-8"))
        self.assertEqual(self.run_sql("SELECT name FROM users WHERE id = 7").rows, [["a"]])

    def test_next_id_continues_from_csv_in_new_database(self):
        self.run_sql("INSERT INTO users (name) VALUES ('a')")
        fresh = Executor(CSVDatabase(self.data_dir))  # 프로그램을 다시 실행한 것과 같음: CSV 에서 트리를 다시 만든다
        self.assertEqual(self.run_sql("INSERT INTO users (name) VALUES ('b')", fresh).ids, [4])

    def test_duplicate_id_is_rejected_without_writing(self):
        before = self.csv.read_text(encoding="utf-8")
        with self.assertRaises(SQLError):
            self.run_sql("INSERT INTO users VALUES (2, '중복', 1)")
        with self.assertRaises(SQLError):
            self.run_sql("INSERT INTO users VALUES (3, 'a', 1), (3, 'b', 2)")  # 같은 문장 안의 중복
        self.assertEqual(self.csv.read_text(encoding="utf-8"), before)
        self.assertEqual(self.run_sql("INSERT INTO users (name) VALUES ('ok')").ids, [3])

    def test_non_integer_id_is_rejected(self):
        for value in ("'abc'", "1.5", "'1e3'"):
            with self.subTest(value=value), self.assertRaises(SQLError):
                self.run_sql(f"INSERT INTO users VALUES ({value}, 'a', 1)")
        self.assertEqual(len(self.run_sql("SELECT * FROM users").rows), 2)

    def test_table_without_id_column_has_no_index(self):
        self.run_sql("CREATE TABLE t (a, b)")
        self.assertEqual(self.run_sql("INSERT INTO t VALUES (1, 2), (1, 2)").ids, [])  # 중복 검사도 없음
        result = self.run_sql("SELECT * FROM t WHERE a = 1")
        self.assertEqual(len(result.rows), 2)
        self.assertFalse(result.used_index)

    # ---- SELECT: 인덱스 사용 ----
    def fill(self, n):
        rows = ", ".join(f"('user{i}', {20 + i % 30})" for i in range(3, n + 1))
        self.run_sql(f"INSERT INTO users (name, age) VALUES {rows}")

    def test_equality_uses_index(self):
        self.fill(100)
        result = self.run_sql("SELECT id, name FROM users WHERE id = 57")
        self.assertTrue(result.used_index)
        self.assertEqual(result.rows, [["57", "user57"]])
        self.assertEqual(self.run_sql("SELECT * FROM users WHERE id = 1000").rows, [])

    def test_index_results_match_full_scan(self):
        self.fill(100)
        cases = {
            # WHERE 절: 인덱스를 써야 하는지
            "id = 2": True,
            "id > 95": True,
            "id >= 95": True,
            "id < 4": True,
            "id <= 4": True,
            "40 < id": True,  # 숫자가 왼쪽에 와도 id > 40 으로 바꿔서 인덱스 사용
            "id >= 10 AND id < 20": True,
            "id > 10 AND id > 50 AND id <= 52": True,
            "id >= 10 AND id <= 30 AND age > 40": True,  # id 범위로 좁힌 뒤 age 조건 검사
            "age > 40 AND id = 22": True,
            "id >= 20 AND id < 10": True,  # 빈 범위
            "id = 2.0": True,
            "id = 2.5": True,
            "id = 5 OR id = 7": False,
            "NOT id = 3": False,
            "id != 3": False,
            "id = '3'": True,  # 숫자처럼 읽히는 문자열은 숫자로 비교되므로 인덱스 사용
            "id = 'abc'": False,  # 문자열 비교
            "id = age": False,
            "age > 40": False,
        }
        all_rows = self.run_sql("SELECT * FROM users").rows
        for where, expect_index in cases.items():
            with self.subTest(where=where):
                result = self.run_sql(f"SELECT * FROM users WHERE {where}")
                self.assertEqual(result.used_index, expect_index)
                # 같은 조건을 전체 스캔으로 걸렀을 때와 결과가 같아야 한다
                expected = [r for r in all_rows if self._matches(where, r)]
                self.assertEqual(result.rows, expected)

    def _matches(self, where, row):
        db = CSVDatabase(self.data_dir)
        (stmt,) = list(Parser(f"SELECT * FROM users WHERE {where}").iter_statements())
        header = db.read_header("users")
        return Executor(db)._compile(stmt.where, header, "users")(row)

    def test_index_range_is_in_id_order(self):
        self.run_sql("INSERT INTO users VALUES (10, 'a', 1), (5, 'b', 1), (7, 'c', 1)")
        result = self.run_sql("SELECT id FROM users WHERE id >= 5")
        self.assertEqual(result.rows, [["5"], ["7"], ["10"]])

    def test_index_is_rebuilt_when_csv_changes_outside(self):
        self.assertEqual(self.run_sql("SELECT name FROM users WHERE id = 1").rows, [["김철수"]])
        with open(self.csv, "a", encoding="utf-8") as f:  # 다른 프로그램이 CSV 를 고친 상황
            f.write("50,외부,40\n")
        self.assertEqual(self.run_sql("SELECT name FROM users WHERE id = 50").rows, [["외부"]])
        self.assertEqual(self.run_sql("INSERT INTO users (name) VALUES ('x')").ids, [51])

    def test_broken_ids_in_csv(self):
        self.csv.write_text("id,name\n1,a\nabc,b\n", encoding="utf-8")
        with self.assertRaises(SQLError):
            self.run_sql("INSERT INTO users (name) VALUES ('c')")
        with self.assertRaises(SQLError):
            self.run_sql("SELECT * FROM users WHERE id = 1")
        # id 조건이 없는 SELECT 는 인덱스 없이 그대로 동작
        self.assertEqual(self.run_sql("SELECT name FROM users WHERE name = 'b'").rows, [["b"]])

    def test_run_script_reports_ids_and_index_use(self):
        out = io.StringIO()
        errors = run_script(
            "INSERT INTO users (name, age) VALUES ('a', 1), ('b', 2);\nSELECT name FROM users WHERE id = 4;",
            self.db,
            out=out,
        )
        self.assertEqual(errors, 0)
        self.assertIn("(id: 3, 4)", out.getvalue())
        self.assertIn("1개 행 조회 (id 인덱스 사용)", out.getvalue())


class NoIndexTest(unittest.TestCase):
    """CSVDatabase(use_index=False): B+ 트리를 쓰지 않는 인덱스 도입 전 동작"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name)
        self.csv = self.data_dir / "users.csv"
        self.csv.write_text("id,name,age\n1,김철수,25\n2,이영희,31\n", encoding="utf-8")
        self.db = CSVDatabase(self.data_dir, use_index=False)
        self.executor = Executor(self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def run_sql(self, sql):
        (stmt,) = list(Parser(sql).iter_statements())
        return self.executor.execute(stmt)

    def test_no_tree_is_built(self):
        self.assertIsNone(self.db.index("users"))
        self.run_sql("SELECT * FROM users WHERE id = 1")
        self.assertEqual(self.db._indexes, {})

    def test_select_by_id_uses_full_scan(self):
        result = self.run_sql("SELECT name FROM users WHERE id = 2")
        self.assertFalse(result.used_index)
        self.assertEqual(result.rows, [["이영희"]])

    def test_insert_stores_values_as_written(self):
        result = self.run_sql("INSERT INTO users (name) VALUES ('a')")
        self.assertEqual(result.ids, [])
        self.run_sql("INSERT INTO users VALUES (1, '중복', 1)")  # 중복 검사 없음
        self.assertTrue(self.csv.read_text(encoding="utf-8").endswith(",a,\n1,중복,1\n"))
        self.assertEqual(len(self.run_sql("SELECT * FROM users WHERE id = 1").rows), 2)

    def test_same_results_as_index(self):
        indexed = Executor(CSVDatabase(self.data_dir))
        for where in ("id = 1", "id >= 2", "id < 5 AND age > 30", "id = 99"):
            with self.subTest(where=where):
                (stmt,) = list(Parser(f"SELECT * FROM users WHERE {where}").iter_statements())
                self.assertEqual(self.executor.execute(stmt).rows, indexed.execute(stmt).rows)

    def test_cli_no_index_flag(self):
        from sqlparser import main

        sql_file = self.data_dir / "q.txt"
        sql_file.write_text("INSERT INTO users (name) VALUES ('a');", encoding="utf-8")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main([str(sql_file), "--data-dir", str(self.data_dir), "--no-index"]), 0)
        self.assertTrue(self.csv.read_text(encoding="utf-8").endswith("\n,a,\n"))  # id 자동 부여 안 됨


if __name__ == "__main__":
    unittest.main()
