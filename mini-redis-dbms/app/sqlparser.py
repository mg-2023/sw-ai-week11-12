"""
Mini DBMS - SQL 처리기

텍스트 파일(.txt)에 적힌 SQL 코드를 읽어서 CSV 파일로 된 테이블에 실행한다.

- 지원 명령어: CREATE TABLE (DDL), INSERT, SELECT (DML)
- 테이블 = <data_dir>/<테이블명>.csv
- CSV 파일의 첫 줄은 컬럼 이름(헤더). CREATE TABLE 에서 지정한 컬럼 이름이 헤더가 된다.
- id 컬럼이 있는 테이블은 메모리 B+ 트리 인덱스(id -> 행)를 가진다.
  INSERT 에서 id 를 빼면 자동으로 부여하고, SELECT 의 WHERE 에 id 조건이 있으면 인덱스로 찾는다.

처리 단계:
    SQL 텍스트 --(Tokenizer)--> 토큰 목록 --(Parser)--> 구문 트리(AST) --(Executor)--> CSV 읽기/쓰기 + 인덱스

사용법:
    python app/sqlparser.py <SQL 파일.txt> [--data-dir <CSV 디렉토리>] [--no-index]
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterator, Union

from bptree import BPlusTree

DEFAULT_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
ID_COLUMN = "id"  # 이 이름(대소문자 무시)의 컬럼이 있으면 B+ 트리 인덱스를 만든다


class SQLError(Exception):
    """SQL 문법 오류 또는 실행 오류"""

    def __init__(self, message: str, line: int | None = None):
        self.line = line
        super().__init__(f"{line}번째 줄: {message}" if line is not None else message)


# ============================================================
# 1. Tokenizer (어휘 분석기): SQL 문자열 -> 토큰 목록
# ============================================================

KEYWORDS = {
    "CREATE", "TABLE", "IF", "EXISTS",
    "INSERT", "INTO", "VALUES",
    "SELECT", "FROM", "WHERE", "AND", "OR", "NOT",
}


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
class CreateTableStatement:
    table: str
    columns: list[str]
    if_not_exists: bool
    text: str
    line: int


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


Statement = Union[CreateTableStatement, InsertStatement, SelectStatement]


class Parser:
    """
    문법 (대소문자 구분 없음):
        script     := statement (';' statement)* [';']
        statement  := create | insert | select
        create     := CREATE TABLE [IF NOT EXISTS] ident '(' ident {',' ident} ')'
        insert    := INSERT INTO ident ['(' ident {',' ident} ')'] VALUES row {',' row}
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
        if tok.type == "KEYWORD" and tok.value == "CREATE":
            stmt = self.parse_create()
        elif tok.type == "KEYWORD" and tok.value == "INSERT":
            stmt = self.parse_insert()
        elif tok.type == "KEYWORD" and tok.value == "SELECT":
            stmt = self.parse_select()
        else:
            found = "파일 끝" if tok.type == "EOF" else repr(tok.value)
            raise SQLError(f"지원하지 않는 명령어입니다: {found} (CREATE TABLE, INSERT, SELECT 만 지원)", tok.line)
        last = self.tokens[self.pos - 1]
        stmt.text = " ".join(self.source[tok.pos:last.end].split())  # 출력용 원문 (공백 정리)
        stmt.line = tok.line
        return stmt

    # ---- CREATE TABLE ----
    def parse_create(self) -> CreateTableStatement:
        self.expect("KEYWORD", "CREATE")
        self.expect("KEYWORD", "TABLE")
        if_not_exists = False
        if self.match("KEYWORD", "IF"):
            self.expect("KEYWORD", "NOT")
            self.expect("KEYWORD", "EXISTS")
            if_not_exists = True
        table = self.expect("IDENT", what="테이블 이름").value

        self.expect("SYMBOL", "(", what="'('")
        columns = [self.expect("IDENT", what="컬럼 이름").value]
        while self.match("SYMBOL", ","):
            columns.append(self.expect("IDENT", what="컬럼 이름").value)
        # CSV 는 모든 값을 문자열로 저장하므로 컬럼 타입(INT 등)은 받지 않는다
        self.expect("SYMBOL", ")", what="',' 또는 ')' (컬럼 타입은 지정하지 않습니다)")
        return CreateTableStatement(table, columns, if_not_exists, "", 0)

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

_INT_RE = re.compile(r"-?\d+")


def parse_id(value: str) -> int | None:
    """id 값(문자열) -> 정수. 정수가 아니면 None"""
    value = value.strip()
    return int(value) if _INT_RE.fullmatch(value) else None


def find_id_column(header: list[str]) -> int | None:
    lowered = [h.lower() for h in header]
    return lowered.index(ID_COLUMN) if ID_COLUMN in lowered else None


@dataclass
class TableIndex:
    """테이블 하나의 메모리 인덱스. 트리에는 (id 정수, 행 전체)가 들어간다"""
    id_col: int  # 헤더에서 id 컬럼의 위치
    tree: BPlusTree
    next_id: int  # 다음에 자동으로 부여할 id (= 지금까지의 최대 id + 1)


class CSVDatabase:
    """테이블 하나 = <data_dir>/<테이블명>.csv 파일 하나

    CSV 파일은 영구 저장용이고, id 인덱스는 메모리에만 있다.
    인덱스는 테이블에 처음 접근할 때 CSV 를 한 번 읽어서 만들고, 이후 INSERT 때마다 함께 갱신한다.

    use_index=False 면 B+ 트리를 전혀 쓰지 않는다 (인덱스 도입 전과 같은 동작, 성능 비교용):
    - SELECT 는 id 조건이 있어도 항상 CSV 전체 스캔
    - INSERT 는 id 를 자동 부여하지 않고 중복 검사도 하지 않는다 (값을 적은 그대로 저장)
    """

    def __init__(self, data_dir: str | Path = DEFAULT_DATA_DIR, index_order: int = 32, use_index: bool = True):
        self.data_dir = Path(data_dir)
        self.index_order = index_order
        self.use_index = use_index
        # 테이블명 -> (인덱스를 만들 당시 CSV 파일 상태, 인덱스 또는 id 컬럼이 없으면 None)
        self._indexes: dict[str, tuple[tuple[int, int], TableIndex | None]] = {}

    def table_path(self, table: str) -> Path:
        path = self.data_dir / f"{table}.csv"
        if not path.is_file():
            raise SQLError(f"테이블 '{table}' 이(가) 없습니다 ({path}). CREATE TABLE 로 먼저 만들어 주세요")
        return path

    def exists(self, table: str) -> bool:
        return (self.data_dir / f"{table}.csv").exists()

    def create(self, table: str, columns: list[str]) -> None:
        """헤더 한 줄만 있는 CSV 파일을 새로 만든다. 이미 있으면 SQLError."""
        self.data_dir.mkdir(parents=True, exist_ok=True)
        path = self.data_dir / f"{table}.csv"
        try:
            with open(path, "x", newline="", encoding="utf-8") as f:  # "x": 이미 있으면 덮어쓰지 않고 실패
                csv.writer(f, lineterminator="\n").writerow(columns)
        except FileExistsError:
            raise SQLError(f"테이블 '{table}' 이(가) 이미 있습니다 ({path})") from None

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

    @staticmethod
    def _file_state(path: Path) -> tuple[int, int]:
        st = path.stat()
        return st.st_mtime_ns, st.st_size

    def index(self, table: str) -> TableIndex | None:
        """테이블의 id 인덱스 (id 컬럼이 없는 테이블이면 None).

        처음 접근할 때, 또는 CSV 파일이 이 객체 밖에서 바뀌었을 때(수정 시각/크기가 달라짐) CSV 를 읽어 새로 만든다.
        use_index=False 면 항상 None (Executor 는 인덱스가 없는 테이블처럼 처리한다).
        """
        if not self.use_index:
            return None
        state = self._file_state(self.table_path(table))
        cached = self._indexes.get(table)
        if cached is not None and cached[0] == state:
            return cached[1]
        index = self._build_index(table)
        self._indexes[table] = (state, index)
        return index

    def _build_index(self, table: str) -> TableIndex | None:
        header, rows = self.scan(table)
        id_col = find_id_column(header)
        if id_col is None:
            return None
        tree = BPlusTree(self.index_order)
        for row in rows:
            key = parse_id(row[id_col])
            if key is None:
                raise SQLError(f"테이블 '{table}' 의 id {row[id_col]!r} 이(가) 정수가 아니어서 인덱스를 만들 수 없습니다")
            if key in tree:
                raise SQLError(f"테이블 '{table}' 에 id {key} 이(가) 두 번 이상 있어서 인덱스를 만들 수 없습니다")
            tree.insert(key, row)
        return TableIndex(id_col, tree, max(tree.max_key() or 0, 0) + 1)

    def append(self, table: str, rows: list[list[str]]) -> None:
        """행을 CSV 끝에 추가하고, id 인덱스가 있으면 트리에도 넣는다.

        id 가 정수가 아니거나 이미 있으면 파일을 건드리지 않고 SQLError (id 부여/검사는 Executor 가 먼저 한다).
        """
        path = self.table_path(table)
        index = self.index(table)  # 파일에 쓰기 전에 최신 인덱스를 확보해 둔다
        keys: list[int] = []
        if index is not None:
            seen: set[int] = set()
            for row in rows:
                key = parse_id(row[index.id_col])
                if key is None or key in index.tree or key in seen:
                    raise SQLError(f"id {row[index.id_col]!r} 은(는) 정수가 아니거나 이미 있는 값입니다")
                seen.add(key)
                keys.append(key)

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

        # 파일에 쓴 다음 트리에 넣는다 (쓰기가 실패하면 트리도 그대로라 파일과 어긋나지 않음)
        if index is not None:
            for key, row in zip(keys, rows):
                index.tree.insert(key, row)
                index.next_id = max(index.next_id, key + 1)
        self._indexes[table] = (self._file_state(path), index)


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
class CreateResult:
    table: str
    columns: list[str]
    created: bool  # IF NOT EXISTS 로 건너뛰었으면 False


@dataclass
class InsertResult:
    table: str
    count: int
    ids: list[int] = field(default_factory=list)  # 들어간 행들의 id (id 컬럼이 없는 테이블이면 빈 목록)


@dataclass
class SelectResult:
    columns: list[str]
    rows: list[list[str]]
    used_index: bool = False  # True 면 전체 스캔 대신 B+ 트리 인덱스로 후보 행을 찾았다


@dataclass(frozen=True)
class KeyRange:
    """WHERE 절에서 뽑아낸 id 범위. lo/hi 가 None 이면 그쪽 끝은 제한 없음"""
    lo: float | None = None
    hi: float | None = None
    include_lo: bool = True
    include_hi: bool = True

    def intersect(self, other: "KeyRange") -> "KeyRange":
        lo, include_lo = self.lo, self.include_lo
        if other.lo is not None and (lo is None or other.lo > lo or (other.lo == lo and not other.include_lo)):
            lo, include_lo = other.lo, other.include_lo
        hi, include_hi = self.hi, self.include_hi
        if other.hi is not None and (hi is None or other.hi < hi or (other.hi == hi and not other.include_hi)):
            hi, include_hi = other.hi, other.include_hi
        return KeyRange(lo, hi, include_lo, include_hi)


_FLIPPED_OP = {"=": "=", "!=": "!=", "<>": "<>", "<": ">", ">": "<", "<=": ">=", ">=": "<="}


def id_range(node: Expr, header: list[str], table: str, id_col: int) -> KeyRange | None:
    """WHERE 조건식에서 id 가 있어야 하는 범위를 뽑는다. None 이면 인덱스로 좁힐 수 없음(전체 스캔).

    - id = 3, id > 3, 3 <= id 처럼 id 와 숫자를 비교하는 조건
    - 그런 조건이 AND 로 묶여 있으면 범위를 교집합으로 좁힌다 (나머지 조건은 찾은 행에 다시 검사)
    - OR, NOT, !=, 문자열 비교는 범위 하나로 표현할 수 없으므로 None
    """
    if isinstance(node, BoolOp) and node.op == "AND":
        left = id_range(node.left, header, table, id_col)
        right = id_range(node.right, header, table, id_col)
        if left is None or right is None:
            return left or right
        return left.intersect(right)
    if not isinstance(node, Comparison):
        return None

    column, op, literal = node.left, node.op, node.right
    if isinstance(column, Literal) and isinstance(literal, Column):  # 3 < id  ->  id > 3
        column, op, literal = literal, _FLIPPED_OP[op], column
    if not (isinstance(column, Column) and isinstance(literal, Literal)):
        return None
    if resolve_column(header, column.name, table) != id_col:
        return None
    value = _to_number(literal.value)
    if value is None:  # id = 'abc' 는 문자열 비교라서 숫자 순서로 정렬된 트리를 쓸 수 없다
        return None

    if op == "=":
        return KeyRange(value, value)
    if op == ">":
        return KeyRange(lo=value, include_lo=False)
    if op == ">=":
        return KeyRange(lo=value)
    if op == "<":
        return KeyRange(hi=value, include_hi=False)
    if op == "<=":
        return KeyRange(hi=value)
    return None  # != , <>


class Executor:
    def __init__(self, db: CSVDatabase):
        self.db = db

    def execute(self, stmt: Statement) -> CreateResult | InsertResult | SelectResult:
        if isinstance(stmt, CreateTableStatement):
            return self.execute_create(stmt)
        if isinstance(stmt, InsertStatement):
            return self.execute_insert(stmt)
        if isinstance(stmt, SelectStatement):
            return self.execute_select(stmt)
        raise SQLError(f"실행할 수 없는 문장입니다: {stmt!r}")

    def execute_create(self, stmt: CreateTableStatement) -> CreateResult:
        # SELECT/INSERT 는 컬럼 이름을 대소문자 무시로도 찾으므로, 대소문자만 다른 이름도 중복으로 본다
        seen: set[str] = set()
        for name in stmt.columns:
            if name.lower() in seen:
                raise SQLError(f"CREATE TABLE 에 컬럼 '{name}' 이(가) 두 번 이상 나왔습니다", stmt.line)
            seen.add(name.lower())

        if stmt.if_not_exists and self.db.exists(stmt.table):
            return CreateResult(stmt.table, stmt.columns, created=False)
        self.db.create(stmt.table, stmt.columns)
        return CreateResult(stmt.table, stmt.columns, created=True)

    def execute_insert(self, stmt: InsertStatement) -> InsertResult:
        header = self.db.read_header(stmt.table)

        if stmt.columns is None:
            indexes = list(range(len(header)))
        else:
            indexes = [resolve_column(header, c, stmt.table) for c in stmt.columns]
            if len(set(indexes)) != len(indexes):
                raise SQLError("INSERT 컬럼 목록에 같은 컬럼이 두 번 이상 나왔습니다", stmt.line)

        index = self.db.index(stmt.table)  # id 컬럼이 없는 테이블이면 None
        next_id = index.next_id if index is not None else 0
        new_ids: list[int] = []
        seen: set[int] = set()

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

            if index is not None:
                raw = row[index.id_col].strip()
                if raw == "":  # id 를 지정하지 않았으면(컬럼 목록에서 뺐거나 '') 자동으로 부여
                    key = next_id
                else:
                    key = parse_id(raw)
                    if key is None:
                        raise SQLError(f"{i}번째 VALUES 의 id {raw!r} 이(가) 정수가 아닙니다", stmt.line)
                    if key in index.tree or key in seen:
                        raise SQLError(f"{i}번째 VALUES 의 id {key} 이(가) 이미 있습니다", stmt.line)
                row[index.id_col] = str(key)  # '007' 같은 값도 트리 키와 같은 모양('7')으로 저장
                seen.add(key)
                new_ids.append(key)
                next_id = max(next_id, key + 1)
            new_rows.append(row)

        self.db.append(stmt.table, new_rows)  # CSV 에 쓰고 트리에도 넣는다 (next_id 도 함께 갱신)
        return InsertResult(stmt.table, len(new_rows), new_ids)

    def execute_select(self, stmt: SelectStatement) -> SelectResult:
        header, rows = self.db.scan(stmt.table)

        if stmt.columns is None:
            indexes = list(range(len(header)))
        else:
            indexes = [resolve_column(header, c, stmt.table) for c in stmt.columns]

        # WHERE 절을 행 -> bool 함수로 미리 바꿔 둔다 (컬럼 이름 검사도 이때 한 번만)
        predicate = self._compile(stmt.where, header, stmt.table) if stmt.where else (lambda row: True)

        # WHERE 에 id 범위 조건이 있으면 B+ 트리에서 그 범위의 행만 꺼내고(id 오름차순),
        # 없으면 지금처럼 CSV 를 처음부터 끝까지 읽는다. 어느 쪽이든 WHERE 전체로 다시 걸러서 결과는 같다.
        id_col = find_id_column(header)
        bounds = id_range(stmt.where, header, stmt.table, id_col) if stmt.where and id_col is not None else None
        index = self.db.index(stmt.table) if bounds is not None else None
        if index is not None:
            candidates = (
                row for _, row in index.tree.range(
                    bounds.lo, bounds.hi, include_lo=bounds.include_lo, include_hi=bounds.include_hi
                )
            )
        else:
            candidates = rows

        result = [[row[i] for i in indexes] for row in candidates if predicate(row)]
        return SelectResult([header[i] for i in indexes], result, used_index=index is not None)

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


def run_script(source: str, db: CSVDatabase, out=None) -> int:
    """SQL 스크립트를 실행하고 오류가 난 문장 수를 돌려준다. 오류가 나도 다음 문장은 계속 실행한다."""
    out = out if out is not None else sys.stdout  # 호출 시점의 stdout (redirect_stdout 도 반영)
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

        if isinstance(result, CreateResult):
            if result.created:
                print(f"테이블 '{result.table}' 이(가) 생성되었습니다. (컬럼: {', '.join(result.columns)})\n", file=out)
            else:
                print(f"테이블 '{result.table}' 이(가) 이미 있어서 건너뜁니다.\n", file=out)
        elif isinstance(result, InsertResult):
            ids = f" (id: {', '.join(map(str, result.ids))})" if result.ids else ""
            print(f"{result.count}개 행이 '{result.table}' 에 추가되었습니다.{ids}\n", file=out)
        else:
            print(format_table(result.columns, result.rows), file=out)
            how = " (id 인덱스 사용)" if result.used_index else ""
            print(f"{len(result.rows)}개 행 조회{how}\n", file=out)
    return errors


def main(argv: list[str] | None = None) -> int:
    arg_parser = argparse.ArgumentParser(description="텍스트 파일에 적힌 SQL(CREATE TABLE, INSERT, SELECT)을 CSV 테이블에 실행합니다.")
    arg_parser.add_argument("sql_file", help="실행할 SQL 코드가 적힌 텍스트 파일 (.txt)")
    arg_parser.add_argument(
        "-d", "--data-dir", default=str(DEFAULT_DATA_DIR),
        help=f"테이블 CSV 파일이 있는 디렉토리 (기본값: {DEFAULT_DATA_DIR})",
    )
    arg_parser.add_argument(
        "--no-index", action="store_true",
        help="B+ 트리 인덱스를 쓰지 않음 (SELECT 는 항상 전체 스캔, INSERT 는 id 자동 부여/중복 검사 없음)",
    )
    args = arg_parser.parse_args(argv)

    sql_path = Path(args.sql_file)
    if not sql_path.is_file():
        print(f"SQL 파일을 찾을 수 없습니다: {sql_path}", file=sys.stderr)
        return 2
    source = sql_path.read_text(encoding="utf-8-sig")

    errors = run_script(source, CSVDatabase(args.data_dir, use_index=not args.no_index))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
