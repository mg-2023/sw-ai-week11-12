"""CLI black-box tests; only elapsed milliseconds are normalized in fixtures."""

from contextlib import contextmanager
import difflib
from pathlib import Path
import re
import shutil
import subprocess
import uuid


ROOT = Path(__file__).resolve().parents[1]
EXE = ROOT / "build" / "mini-dbms.exe"
FIXTURES = ROOT / "tests" / "sql"
UNSYNCED = "warning: --sync none: acknowledged writes may be lost on crash\n"


def normalize(text):
    text = text.replace("\r\n", "\n")
    # Match only metadata suffixes, preserving numbers in rows and error messages.
    return re.sub(
        r"^(\([0-9]+ rows?(?: inserted, ids=[0-9,]+|, plan=(?:scan|index|none), examined=[0-9]+)), [0-9]+\.[0-9]{3} ms\)$",
        r"\1, <time> ms)", text, flags=re.M,
    )


@contextmanager
def database():
    (ROOT / "build").mkdir(exist_ok=True)
    # Inherit workspace ACLs. Python 3.13 TemporaryDirectory's private Windows
    # ACL excludes the restricted runner account used in this workspace.
    work = ROOT / "build" / f"cli tests {uuid.uuid4().hex}"
    work.mkdir()
    try:
        data = work / "data"
        data.mkdir()
        shutil.copyfile(ROOT / "data" / "catalog.txt", data / "catalog.txt")
        yield work, data
    finally:
        assert work.resolve().is_relative_to((ROOT / "build").resolve())
        shutil.rmtree(work)


def invoke(work, args, sql=None):
    proc = subprocess.run(
        [str(EXE), *map(str, args)], cwd=work, input=sql,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15,
    )
    return proc.returncode, normalize(proc.stdout.decode("utf-8")), proc.stderr.decode("utf-8").replace("\r\n", "\n")


def expect(actual, code, stdout, stderr=""):
    wanted = (code, stdout, stderr)
    if actual != wanted:
        diff = "".join(difflib.unified_diff(
            repr(wanted).splitlines(True), repr(actual).splitlines(True),
            fromfile="expected (exit, stdout, stderr)", tofile="actual",
        ))
        raise AssertionError(diff)


def fixture(path, stdin=False):
    header, stdout = path.with_suffix(".expected").read_text(encoding="utf-8").split("\n", 1)
    code = int(header.removeprefix("exit_code="))
    with database() as (work, data):
        args = ["run", "-" if stdin else path, "--data", data]
        expect(invoke(work, args, path.read_bytes() if stdin else None), code, stdout)
        if path.stem == "error_stops":
            expect(invoke(work, ["run", "-", "--data", data], b"SELECT id FROM users;"), 0,
                   "id\n--\n1\n(1 row, plan=scan, examined=1, <time> ms)\n")


def test_defaults_and_reopen():
    with database() as (work, _):
        expect(invoke(work, ["run", "-"], b"INSERT INTO users VALUES ('saved', 1);"), 0,
               "(1 row inserted, ids=1, <time> ms)\n")
        expect(invoke(work, ["run", "-", "--sync", "always"], b"INSERT INTO users VALUES ('next', 2); SELECT id FROM users;"), 0,
               "(1 row inserted, ids=2, <time> ms)\nid\n--\n1\n2\n(2 rows, plan=scan, examined=2, <time> ms)\n")


def test_sync_none():
    with database() as (work, data):
        expect(invoke(work, ["run", "-", "--sync", "none", "--data", data], b"SELECT id FROM users;"), 0,
               "id\n--\n(0 rows, plan=scan, examined=0, <time> ms)\n", UNSYNCED)


def test_empty_and_bom_input():
    with database() as (work, _):
        expect(invoke(work, ["run", "-"], b""), 0, "")
        sql = work / "with bom.sql"
        sql.write_bytes(b"\xef\xbb\xbf-- comment\r\nSELECT id FROM users;\r\n")
        expect(invoke(work, ["run", sql]), 0, "id\n--\n(0 rows, plan=scan, examined=0, <time> ms)\n")


def test_input_errors():
    with database() as (work, _):
        rc, out, err = invoke(work, ["run", "missing.sql"])
        assert rc == 1 and out.startswith("error at 0:0: cannot open SQL file") and not err, (rc, out, err)
        expect(invoke(work, ["run", "-"], b"SELECT id FROM users;\x00INSERT INTO users VALUES ('hidden',1);"),
               1, "error at 0:0: SQL input contains NUL byte\n")


def test_invalid_arguments():
    cases = [[], ["run"], ["bench"], ["serve"], ["run", "-", "extra"],
             ["run", "-", "--data"], ["run", "-", "--sync"],
             ["run", "-", "--sync", "sometimes"], ["run", "-", "--unknown"],
             ["run", "-", "--data", ""], ["run", "-", "--repair", "yes"]]
    with database() as (work, _):
        for args in cases:
            rc, out, err = invoke(work, args, b"")
            assert rc == 1 and "error at 0:0:" in out and "usage:" in err, (args, rc, out, err)
        assert not (work / "data" / "users.tbl").exists(), "argument errors opened the database"


def test_open_error():
    with database() as (work, data):
        (data / "catalog.txt").unlink()
        rc, out, err = invoke(work, ["run", "-"], b"SELECT id FROM users;")
        assert rc == 1 and re.fullmatch(r"error at [0-9]+:[0-9]+: cannot open catalog file\n", out) and not err, (rc, out, err)


def test_recovery_and_repair():
    with database() as (work, data):
        sql = b"INSERT INTO users VALUES ('one',1),('two',2),('three',3);"
        assert invoke(work, ["run", "-"], sql)[0] == 0
        table = data / "users.tbl"
        stored = table.read_bytes()
        # Incomplete final record is truncated automatically.
        table.write_bytes(stored[:-5])
        expect(invoke(work, ["run", "-"], b"SELECT id FROM users;"), 0,
               "id\n--\n1\n2\n(2 rows, plan=scan, examined=2, <time> ms)\n")
        first_end = 8 + int.from_bytes(stored[:4], "little")
        damaged = bytearray(stored)
        damaged[first_end + 16] ^= 1  # Second payload, preserving length/header.
        table.write_bytes(damaged)
        rc, out, err = invoke(work, ["run", "-"], b"SELECT id FROM users;")
        assert rc == 1 and "CRC mismatch" in out and "offset" in out and not err, (rc, out, err)
        assert table.read_bytes() == damaged, "startup refusal modified corrupt file"
        expect(invoke(work, ["run", "-", "--repair"], b"SELECT id FROM users;"), 0,
               "id\n--\n1\n(1 row, plan=scan, examined=1, <time> ms)\n")
        assert table.stat().st_size == first_end


def test_parse_error_commits_prefix():
    with database() as (work, _):
        expect(invoke(work, ["run", "-"], b"INSERT INTO users VALUES ('ok',1);\nINSERT INTO users (name,age) ('bad',2);\nINSERT INTO users VALUES ('never',3);"), 1,
               "(1 row inserted, ids=1, <time> ms)\nerror at 2:30: expected VALUES\n(1 statement committed before error)\n")
        expect(invoke(work, ["run", "-"], b"SELECT id FROM users;"), 0,
               "id\n--\n1\n(1 row, plan=scan, examined=1, <time> ms)\n")


def test_large_input():
    with database() as (work, _):
        # Force growth of the input buffer; no HTTP body limit applies to CLI.
        sql = b"-- " + b"x" * (1024 * 1024) + b"\nSELECT id FROM users;"
        expect(invoke(work, ["run", "-"], sql), 0,
               "id\n--\n(0 rows, plan=scan, examined=0, <time> ms)\n")


def main():
    tests = [(path.stem, lambda path=path: fixture(path)) for path in sorted(FIXTURES.glob("*.sql"))]
    tests += [("stdin_basic", lambda: fixture(FIXTURES / "basic_insert_select.sql", stdin=True))]
    tests += [(fn.__name__, fn) for fn in (
        test_defaults_and_reopen, test_sync_none, test_empty_and_bom_input,
        test_input_errors, test_invalid_arguments, test_open_error,
        test_recovery_and_repair, test_parse_error_commits_prefix, test_large_input,
    )]
    passed = failed = 0
    for name, test in tests:
        try:
            test()
        except (AssertionError, OSError, subprocess.SubprocessError, UnicodeError, ValueError) as exc:
            failed += 1
            print(f"FAIL {name}: {exc}")
        else:
            passed += 1
            print(f"PASS {name}")
    print(f"CLI: {passed} passed, {failed} failed")
    return int(failed != 0)


if __name__ == "__main__":
    raise SystemExit(main())
