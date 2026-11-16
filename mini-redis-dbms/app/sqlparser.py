"""
Mini DBMS - SQL 처리기

텍스트 파일(.txt)에 적힌 SQL 코드를 읽어서 CSV 파일로 된 테이블에 실행한다.

- 지원 명령어(DML): INSERT, SELECT
- 테이블 = <data_dir>/<테이블명>.csv (이미 만들어져 있다고 가정, DDL 미지원)
- CSV 파일의 첫 줄은 컬럼 이름(헤더)

처리 단계:
    SQL 텍스트 --(Tokenizer)--> 토큰 목록 --(Parser)--> 구문 트리(AST) --(Executor)--> CSV 읽기/쓰기

사용법:
    python app/sqlparser.py <SQL 파일.txt> [--data-dir <CSV 디렉토리>]
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator, Union

DEFAULT_DATA_DIR = Path(__file__).resolve().parent.parent / "data"


class SQLError(Exception):
    """SQL 문법 오류 또는 실행 오류"""

    def __init__(self, message: str, line: int | None = None):
        self.line = line
        super().__init__(f"{line}번째 줄: {message}" if line is not None else message)


# ============================================================
# 1. Tokenizer (어휘 분석기): SQL 문자열 -> 토큰 목록
# ============================================================

KEYWORDS = {"INSERT", "INTO", "VALUES", "SELECT", "FROM", "WHERE", "AND", "OR", "NOT"}


@dataclass
class Token:
    type: str  # KEYWORD, IDENT, NUMBER, STRING, OP, SYMBOL, EOF
    value: str
    line: int
    pos: int  # 원본 문자열에서의 시작 위치
    end: int  # 원본 문자열에서의 끝 위치


_TOKEN_SPEC = [
    ("SKIP", r"\s+"),
    ("LINE_COMMENT", r"--[^\n]*"),
    ("BLOCK_COMMENT", r"/\*.*?\*/"),
    ("STRING", r"'(?:[^']|'')*'"),  # 'it''s' 처럼 '' 는 작은따옴표 하나
    ("NUMBER", r"-?\d+(?:\.\d+)?"),
    ("WORD", r"[^\W\d]\w*"),  # 키워드 또는 식별자 (한글 컬럼명 허용)
    ("OP", r"<=|>=|<>|!=|=|<|>"),
    ("SYMBOL", r"[(),;*]"),
    ("MISMATCH", r"."),
]
_TOKEN_RE = re.compile("|".join(f"(?P<{name}>{pattern})" for name, pattern in _TOKEN_SPEC), re.DOTALL)


def tokenize(source: str) -> list[Token]:
    tokens: list[Token] = []
    line = 1
    for m in _TOKEN_RE.finditer(source):
        kind, text = m.lastgroup, m.group()
        if kind == "MISMATCH":
            if text == "'":
                raise SQLError("작은따옴표(')로 시작한 문자열이 닫히지 않았습니다", line)
            if text == "/" and source.startswith("/*", m.start()):
                raise SQLError("블록 주석(/* */)이 닫히지 않았습니다", line)
            raise SQLError(f"알 수 없는 문자 {text!r}", line)
        if kind == "STRING":
            tokens.append(Token("STRING", text[1:-1].replace("''", "'"), line, m.start(), m.end()))
        elif kind == "WORD":
            upper = text.upper()
            if upper in KEYWORDS:
                tokens.append(Token("KEYWORD", upper, line, m.start(), m.end()))
            else:
                tokens.append(Token("IDENT", text, line, m.start(), m.end()))
        elif kind in ("NUMBER", "OP", "SYMBOL"):
            tokens.append(Token(kind, text, line, m.start(), m.end()))
        line += text.count("\n")  # 공백, 주석, 문자열 안의 줄바꿈까지 반영
    tokens.append(Token("EOF", "", line, len(source), len(source)))
    return tokens


# ============================================================
# 2. Parser (구문 분석기): 토큰 목록 -> 구문 트리(AST)
# ============================================================

@dataclass
class Column:
    name: str


@dataclass
class Literal:
    value: str


@dataclass
class Comparison:
    left: Union[Column, Literal]
    op: str
    right: Union[Column, Literal]


@dataclass
class BoolOp:
    op: str  # AND, OR
    left: "Expr"
    right: "Expr"


@dataclass
class Not:
    operand: "Expr"


Expr = Union[Comparison, BoolOp, Not]


@dataclass
class InsertStatement:
    table: str
    columns: list[str] | None  # None 이면 테이블의 모든 컬럼 순서대로
    rows: list[list[str]]
    text: str
    line: int


@dataclass
class SelectStatement:
    columns: list[str] | None  # None 이면 SELECT *
    table: str
    where: Expr | None
    text: str
    line: int


Statement = Union[InsertStatement, SelectStatement]


class Parser:
    """
    문법 (대소문자 구분 없음):
        script     := statement (';' statement)* [';']
        statement  := insert | select
        insert     := INSERT INTO ident ['(' ident {',' ident} ')'] VALUES row {',' row}
        row        := '(' literal {',' literal} ')'
        select     := SELECT ('*' | ident {',' ident}) FROM ident [WHERE expr]
        expr       := and_expr {OR and_expr}
        and_expr   := not_expr {AND not_expr}
        not_expr   := NOT not_expr | '(' expr ')' | comparison
        comparison := operand ('=' | '!=' | '<>' | '<' | '<=' | '>' | '>=') operand
        operand    := ident | literal
        literal    := STRING | NUMBER
    """

    def __init__(self, source: str):
        self.source = source
        self.tokens = tokenize(source)
        self.pos = 0

    # ---- 토큰 다루기 ----
    def peek(self) -> Token:
        return self.tokens[self.pos]

    def advance(self) -> Token:
        tok = self.tokens[self.pos]
        if tok.type != "EOF":
            self.pos += 1
        return tok

    def check(self, type_: str, value: str | None = None) -> bool:
        tok = self.peek()
        return tok.type == type_ and (value is None or tok.value == value)

    def match(self, type_: str, value: str | None = None) -> Token | None:
        if self.check(type_, value):
            return self.advance()
        return None

    def expect(self, type_: str, value: str | None = None, what: str | None = None) -> Token:
        if self.check(type_, value):
            return self.advance()
        tok = self.peek()
        expected = what or value or type_
        found = "파일 끝" if tok.type == "EOF" else repr(tok.value)
        raise SQLError(f"{expected} 이(가) 와야 하는데 {found} 이(가) 나왔습니다", tok.line)

    # ---- 스크립트 전체 ----
    def iter_statements(self) -> Iterator[Statement | SQLError]:
        """문장을 하나씩 파싱해서 돌려준다. 문법 오류가 난 문장은 SQLError 로 돌려주고 다음 ';' 부터 계속한다."""
        while True:
            while self.match("SYMBOL", ";"):  # 빈 문장 무시
                pass
            if self.check("EOF"):
                return
            try:
                stmt = self.parse_statement()
                if not self.check("EOF"):
                    self.expect("SYMBOL", ";", what="';'")
                yield stmt
            except SQLError as e:
                yield e
                self._skip_to_next_statement()

    def _skip_to_next_statement(self) -> None:
        while not self.check("EOF") and not self.check("SYMBOL", ";"):
            self.advance()
        self.match("SYMBOL", ";")

    def parse_statement(self) -> Statement:
        tok = self.peek()
        if tok.type == "KEYWORD" and tok.value == "INSERT":
            stmt = self.parse_insert()
        elif tok.type == "KEYWORD" and tok.value == "SELECT":
            stmt = self.parse_select()
        else:
            found = "파일 끝" if tok.type == "EOF" else repr(tok.value)
            raise SQLError(f"지원하지 않는 명령어입니다: {found} (INSERT, SELECT 만 지원)", tok.line)
        last = self.tokens[self.pos - 1]
        stmt.text = " ".join(self.source[tok.pos:last.end].split())  # 출력용 원문 (공백 정리)
        stmt.line = tok.line
        return stmt

    # ---- INSERT ----
    def parse_insert(self) -> InsertStatement:
        self.expect("KEYWORD", "INSERT")
        self.expect("KEYWORD", "INTO")
        table = self.expect("IDENT", what="테이블 이름").value

        columns = None
        if self.match("SYMBOL", "("):
            columns = [self.expect("IDENT", what="컬럼 이름").value]
            while self.match("SYMBOL", ","):
                columns.append(self.expect("IDENT", what="컬럼 이름").value)
            self.expect("SYMBOL", ")", what="')'")

        self.expect("KEYWORD", "VALUES")
        rows = [self.parse_value_row()]
        while self.match("SYMBOL", ","):
            rows.append(self.parse_value_row())
        return InsertStatement(table, columns, rows, "", 0)

    def parse_value_row(self) -> list[str]:
        self.expect("SYMBOL", "(", what="'('")
        values = [self.parse_literal().value]
        while self.match("SYMBOL", ","):
            values.append(self.parse_literal().value)
        self.expect("SYMBOL", ")", what="')'")
        return values

    def parse_literal(self) -> Literal:
        tok = self.peek()
        if tok.type in ("STRING", "NUMBER"):
            self.advance()
            return Literal(tok.value)
        found = "파일 끝" if tok.type == "EOF" else repr(tok.value)
        raise SQLError(f"값(문자열 또는 숫자)이 와야 하는데 {found} 이(가) 나왔습니다", tok.line)

    # ---- SELECT ----
    def parse_select(self) -> SelectStatement:
        self.expect("KEYWORD", "SELECT")
        columns = None
        if not self.match("SYMBOL", "*"):
            columns = [self.expect("IDENT", what="컬럼 이름 또는 '*'").value]
            while self.match("SYMBOL", ","):
                columns.append(self.expect("IDENT", what="컬럼 이름").value)
        self.expect("KEYWORD", "FROM")
        table = self.expect("IDENT", what="테이블 이름").value
        where = self.parse_expr() if self.match("KEYWORD", "WHERE") else None
        return SelectStatement(columns, table, where, "", 0)

    # ---- WHERE 조건식 ----
    def parse_expr(self) -> Expr:
        node = self.parse_and()
        while self.match("KEYWORD", "OR"):
            node = BoolOp("OR", node, self.parse_and())
        return node

    def parse_and(self) -> Expr:
        node = self.parse_not()
        while self.match("KEYWORD", "AND"):
            node = BoolOp("AND", node, self.parse_not())
        return node

    def parse_not(self) -> Expr:
        if self.match("KEYWORD", "NOT"):
            return Not(self.parse_not())
        if self.match("SYMBOL", "("):
            node = self.parse_expr()
            self.expect("SYMBOL", ")", what="')'")
            return node
        return self.parse_comparison()

    def parse_comparison(self) -> Comparison:
        left = self.parse_operand()
        op = self.expect("OP", what="비교 연산자(=, !=, <>, <, <=, >, >=)").value
        right = self.parse_operand()
        return Comparison(left, op, right)

    def parse_operand(self) -> Union[Column, Literal]:
        tok = self.peek()
        if tok.type == "IDENT":
            self.advance()
            return Column(tok.value)
        return self.parse_literal()


# ============================================================
# 3. Executor (실행기): 구문 트리 -> CSV 파일 읽기/쓰기
# ============================================================

class CSVDatabase:
    """테이블 하나 = <data_dir>/<테이블명>.csv 파일 하나"""

    def __init__(self, data_dir: str | Path = DEFAULT_DATA_DIR):
        self.data_dir = Path(data_dir)

    def table_path(self, table: str) -> Path:
        path = self.data_dir / f"{table}.csv"
        if not path.is_file():
            raise SQLError(f"테이블 '{table}' 이(가) 없습니다 ({path})")
        return path

    def read_header(self, table: str) -> list[str]:
        with open(self.table_path(table), newline="", encoding="utf-8-sig") as f:
            header = next(csv.reader(f), None)
        if not header:
            raise SQLError(f"테이블 '{table}' 의 CSV 파일에 헤더(컬럼 이름 줄)가 없습니다")
        return header

    def scan(self, table: str) -> tuple[list[str], Iterator[list[str]]]:
        """(헤더, 데이터 행 이터레이터)를 돌려준다. 행은 헤더 길이에 맞춰 빈 문자열로 채운다."""
        header = self.read_header(table)
        path = self.table_path(table)

        def rows() -> Iterator[list[str]]:
            with open(path, newline="", encoding="utf-8-sig") as f:
                reader = csv.reader(f)
                next(reader, None)  # 헤더 건너뛰기
                for row in reader:
                    if not row:  # 빈 줄 무시
                        continue
                    yield row + [""] * (len(header) - len(row))

        return header, rows()

    def append(self, table: str, rows: list[list[str]]) -> None:
        path = self.table_path(table)
        # 파일이 줄바꿈 없이 끝나 있으면 새 행이 마지막 행에 붙어버리므로 먼저 줄바꿈을 넣는다
        needs_newline = False
        with open(path, "rb") as f:
            f.seek(0, 2)
            if f.tell() > 0:
                f.seek(-1, 2)
                needs_newline = f.read(1) not in (b"\n", b"\r")
        with open(path, "a", newline="", encoding="utf-8") as f:
            if needs_newline:
                f.write("\n")
            csv.writer(f, lineterminator="\n").writerows(rows)


def resolve_column(header: list[str], name: str, table: str) -> int:
    """컬럼 이름 -> 인덱스. 정확히 일치하는 이름을 먼저 찾고, 없으면 대소문자를 무시하고 찾는다."""
    if name in header:
        return header.index(name)
    lowered = [h.lower() for h in header]
    if name.lower() in lowered:
        return lowered.index(name.lower())
    raise SQLError(f"테이블 '{table}' 에 컬럼 '{name}' 이(가) 없습니다 (컬럼: {', '.join(header)})")


def _to_number(value: str) -> float | None:
    try:
        return float(value)
    except ValueError:
        return None


_OPS: dict[str, Callable[[object, object], bool]] = {
    "=": lambda a, b: a == b,
    "!=": lambda a, b: a != b,
    "<>": lambda a, b: a != b,
    "<": lambda a, b: a < b,
    "<=": lambda a, b: a <= b,
    ">": lambda a, b: a > b,
    ">=": lambda a, b: a >= b,
}


def compare(left: str, op: str, right: str) -> bool:
    """CSV 값은 전부 문자열이므로, 양쪽이 모두 숫자로 읽히면 숫자로 비교하고 아니면 문자열로 비교한다."""
    ln, rn = _to_number(left), _to_number(right)
    if ln is not None and rn is not None:
        return _OPS[op](ln, rn)
    return _OPS[op](left, right)


@dataclass
class InsertResult:
    table: str
    count: int


@dataclass
class SelectResult:
    columns: list[str]
    rows: list[list[str]]


class Executor:
    def __init__(self, db: CSVDatabase):
        self.db = db

    def execute(self, stmt: Statement) -> InsertResult | SelectResult:
        if isinstance(stmt, InsertStatement):
            return self.execute_insert(stmt)
        if isinstance(stmt, SelectStatement):
            return self.execute_select(stmt)
        raise SQLError(f"실행할 수 없는 문장입니다: {stmt!r}")

    def execute_insert(self, stmt: InsertStatement) -> InsertResult:
        header = self.db.read_header(stmt.table)

        if stmt.columns is None:
            indexes = list(range(len(header)))
        else:
            indexes = [resolve_column(header, c, stmt.table) for c in stmt.columns]
            if len(set(indexes)) != len(indexes):
                raise SQLError("INSERT 컬럼 목록에 같은 컬럼이 두 번 이상 나왔습니다", stmt.line)

        # 모든 행을 먼저 검사한 뒤에 한 번에 쓴다 (중간에 실패해서 일부만 들어가는 것을 막기 위함)
        new_rows = []
        for i, values in enumerate(stmt.rows, start=1):
            if len(values) != len(indexes):
                raise SQLError(
                    f"{i}번째 VALUES 의 값 개수({len(values)})가 컬럼 개수({len(indexes)})와 다릅니다",
                    stmt.line,
                )
            row = [""] * len(header)  # 지정하지 않은 컬럼은 빈 값
            for idx, value in zip(indexes, values):
                row[idx] = value
            new_rows.append(row)

        self.db.append(stmt.table, new_rows)
        return InsertResult(stmt.table, len(new_rows))

    def execute_select(self, stmt: SelectStatement) -> SelectResult:
        header, rows = self.db.scan(stmt.table)

        if stmt.columns is None:
            indexes = list(range(len(header)))
        else:
            indexes = [resolve_column(header, c, stmt.table) for c in stmt.columns]

        # WHERE 절을 행 -> bool 함수로 미리 바꿔 둔다 (컬럼 이름 검사도 이때 한 번만)
        predicate = self._compile(stmt.where, header, stmt.table) if stmt.where else (lambda row: True)

        result = [[row[i] for i in indexes] for row in rows if predicate(row)]
        return SelectResult([header[i] for i in indexes], result)

    def _compile(self, node, header: list[str], table: str) -> Callable[[list[str]], object]:
        if isinstance(node, Column):
            idx = resolve_column(header, node.name, table)
            return lambda row: row[idx]
        if isinstance(node, Literal):
            value = node.value
            return lambda row: value
        if isinstance(node, Comparison):
            left = self._compile(node.left, header, table)
            right = self._compile(node.right, header, table)
            op = node.op
            return lambda row: compare(left(row), op, right(row))
        if isinstance(node, Not):
            operand = self._compile(node.operand, header, table)
            return lambda row: not operand(row)
        if isinstance(node, BoolOp):
            left = self._compile(node.left, header, table)
            right = self._compile(node.right, header, table)
            if node.op == "AND":
                return lambda row: left(row) and right(row)
            return lambda row: left(row) or right(row)
        raise SQLError(f"알 수 없는 조건식입니다: {node!r}")


# ============================================================
# 4. 결과 출력 / 실행 진입점
# ============================================================

def _display_width(text: str) -> int:
    """터미널에서 한글 등 전각 문자는 2칸을 차지한다"""
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in text)


def _pad(text: str, width: int) -> str:
    return text + " " * (width - _display_width(text))


def format_table(columns: list[str], rows: list[list[str]]) -> str:
    widths = [_display_width(c) for c in columns]
    for row in rows:
        for i, value in enumerate(row):
            widths[i] = max(widths[i], _display_width(value))
    border = "+" + "+".join("-" * (w + 2) for w in widths) + "+"

    def line(values: list[str]) -> str:
        return "| " + " | ".join(_pad(v, w) for v, w in zip(values, widths)) + " |"

    out = [border, line(columns), border]
    out += [line(row) for row in rows]
    if rows:
        out.append(border)
    return "\n".join(out)


def run_script(source: str, db: CSVDatabase, out=sys.stdout) -> int:
    """SQL 스크립트를 실행하고 오류가 난 문장 수를 돌려준다. 오류가 나도 다음 문장은 계속 실행한다."""
    try:
        parser = Parser(source)
    except SQLError as e:  # 토큰화 단계 오류는 파일 전체를 읽을 수 없으므로 중단
        print(f"[오류] {e}", file=out)
        return 1

    executor = Executor(db)
    errors = 0
    for n, item in enumerate(parser.iter_statements(), start=1):
        if isinstance(item, SQLError):
            errors += 1
            print(f"[{n}] 문법 오류 - {item}\n", file=out)
            continue

        print(f"[{n}] {item.text}", file=out)
        try:
            result = executor.execute(item)
        except SQLError as e:
            errors += 1
            message = str(e) if e.line is not None else f"{item.line}번째 줄: {e}"
            print(f"실행 오류 - {message}\n", file=out)
            continue

        if isinstance(result, InsertResult):
            print(f"{result.count}개 행이 '{result.table}' 에 추가되었습니다.\n", file=out)
        else:
            print(format_table(result.columns, result.rows), file=out)
            print(f"{len(result.rows)}개 행 조회\n", file=out)
    return errors


def main(argv: list[str] | None = None) -> int:
    arg_parser = argparse.ArgumentParser(description="텍스트 파일에 적힌 SQL(INSERT, SELECT)을 CSV 테이블에 실행합니다.")
    arg_parser.add_argument("sql_file", help="실행할 SQL 코드가 적힌 텍스트 파일 (.txt)")
    arg_parser.add_argument(
        "-d", "--data-dir", default=str(DEFAULT_DATA_DIR),
        help=f"테이블 CSV 파일이 있는 디렉토리 (기본값: {DEFAULT_DATA_DIR})",
    )
    args = arg_parser.parse_args(argv)

    sql_path = Path(args.sql_file)
    if not sql_path.is_file():
        print(f"SQL 파일을 찾을 수 없습니다: {sql_path}", file=sys.stderr)
        return 2
    source = sql_path.read_text(encoding="utf-8-sig")

    errors = run_script(source, CSVDatabase(args.data_dir))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
