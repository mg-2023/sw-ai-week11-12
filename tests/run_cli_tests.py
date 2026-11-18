"""CLI black-box tests; only elapsed milliseconds are normalized in fixtures."""

from contextlib import contextmanager
import difflib
from pathlib import Path
import re
import shutil
import subprocess
import uuid
import zlib


ROOT = Path(__file__).resolve().parents[1]
EXE = ROOT / "build" / "mini-dbms.exe"
FIXTURES = ROOT / "tests" / "sql"
UNSYNCED = "warning: --sync none: rows written since the last synchronization may be lost on OS failure; rows written this run: {}\n"


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


def check_repair(work, err, before, off):
    """Check the --repair report and backup; returns (record count, id range or None)."""
    m = re.fullmatch(r"repair: cut (\d+) bytes at offset (\d+), backup (\S+), (\d+) intact records in the cut bytes"
                     r"(?:, ids (\d+)\.\.(\d+))?\n", err)
    assert m, err
    assert int(m[1]) == len(before) - off and int(m[2]) == off, err
    assert (work / m[3]).read_bytes() == bytes(before[off:]), "backup differs from the cut bytes"
    return int(m[4]), (int(m[5]), int(m[6])) if m[5] else None


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
               "id\n--\n(0 rows, plan=scan, examined=0, <time> ms)\n", UNSYNCED.format(0))
        expect(invoke(work, ["run", "-", "--sync", "none", "--data", data],
                      b"INSERT INTO users VALUES ('a',1),('b',2); SELECT * FROM absent;"), 1,
               "(2 rows inserted, ids=1,2, <time> ms)\nerror at 1:43: unknown table\n(1 statement committed before error)\n",
               UNSYNCED.format(2))


def test_empty_and_bom_input():
    with database() as (work, _):
        expect(invoke(work, ["run", "-"], b""), 0, "")
        sql = work / "with bom.sql"
        sql.write_bytes(b"\xef\xbb\xbf-- comment\r\nSELECT id FROM users;\r\n")
        expect(invoke(work, ["run", sql]), 0, "id\n--\n(0 rows, plan=scan, examined=0, <time> ms)\n")


def test_input_errors():
    with database() as (work, _):
        rc, out, err = invoke(work, ["run", "missing.sql"])
        assert rc == 1 and out.startswith("internal error: cannot open SQL file") and not err, (rc, out, err)
        expect(invoke(work, ["run", "-"], b"SELECT id FROM users;\x00INSERT INTO users VALUES ('hidden',1);"),
               1, "error at 0:0: SQL input contains NUL byte\n")


def test_invalid_arguments():
    cases = [[], ["run"], ["bench"], ["serve", "--unknown"], ["serve", "--port"],
             ["serve", "--port", "70000"], ["serve", "--threads", "0"], ["serve", "--sync", "sometimes"],
             ["run", "-", "extra"],
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
        assert rc == 1 and out == "internal error: cannot open catalog file\n" and not err, (rc, out, err)


def test_recovery_and_repair():
    with database() as (work, data):
        sql = b"INSERT INTO users VALUES ('one',1),('two',2),('three',3);"
        assert invoke(work, ["run", "-"], sql)[0] == 0
        table = data / "users.tbl"
        stored = table.read_bytes()
        # Incomplete final record is truncated automatically.
        table.write_bytes(stored[:-5])
        first_end = 12 + int.from_bytes(stored[:4], "little")
        second_end = first_end + 12 + int.from_bytes(stored[first_end:first_end + 4], "little")
        expect(invoke(work, ["run", "-"], b"SELECT id FROM users;"), 0,
               "id\n--\n1\n2\n(2 rows, plan=scan, examined=2, <time> ms)\n",
               f"{len(stored) - 5 - second_end} bytes of incomplete tail truncated at offset {second_end}\n")
        damaged = bytearray(stored)
        damaged[first_end + 16] ^= 1  # Second payload, preserving length/header.
        table.write_bytes(damaged)
        rc, out, err = invoke(work, ["run", "-"], b"SELECT id FROM users;")
        assert rc == 1 and "CRC mismatch" in out and "offset" in out and not err, (rc, out, err)
        assert table.read_bytes() == damaged, "startup refusal modified corrupt file"
        rc, out, err = invoke(work, ["run", "-", "--repair"], b"SELECT id FROM users;")
        assert (rc, out) == (0, "id\n--\n1\n(1 row, plan=scan, examined=1, <time> ms)\n"), (rc, out)
        # The third record after the damaged one is reported, not silently dropped.
        assert check_repair(work, err, damaged, first_end) == (1, (3, 3)), err
        assert table.stat().st_size == first_end


def test_binary_stdin_control_z():
    sql = b"INSERT INTO users VALUES ('a',1);\x1aINSERT INTO users VALUES ('b',2);"
    results = []
    for stdin in (False, True):
        with database() as (work, data):
            path = work / "input.sql"
            path.write_bytes(sql)
            result = invoke(work, ["run", "-" if stdin else path], sql if stdin else None)
            assert result[0] == 1 and "error at 1:34: unexpected character" in result[1], result
            assert "(1 statement committed before error)" in result[1], result
            results.append((result, (data / "users.tbl").read_bytes()))
    assert results[0] == results[1], results


def test_binary_stdin_crlf():
    stored = []
    for stdin in (False, True):
        with database() as (work, data):
            sql = b"INSERT INTO users VALUES ('x\r\ny',1);"
            path = work / "input.sql"
            path.write_bytes(sql)
            assert invoke(work, ["run", "-" if stdin else path], sql if stdin else None)[0] == 0
            raw = (data / "users.tbl").read_bytes()
            assert int.from_bytes(raw[20:24], "little") == 4 and raw[24:28] == b"x\r\ny", raw
            stored.append(raw)
    assert stored[0] == stored[1]


def test_length_corruption_refuses_and_repairs():
    with database() as (work, data):
        assert invoke(work, ["run", "-"], b"INSERT INTO users VALUES ('a',1),('b',2),('c',3);")[0] == 0
        table = data / "users.tbl"
        raw = table.read_bytes()
        first_end = 12 + int.from_bytes(raw[:4], "little")
        for off in (0, first_end):
            damaged = bytearray(raw)
            damaged[off + 2] ^= 0x08
            table.write_bytes(damaged)
            rc, out, err = invoke(work, ["run", "-"], b"SELECT id FROM users;")
            assert rc == 1 and out.startswith("internal error:") and f"offset {off}" in out and not err, (rc, out, err)
            assert table.read_bytes() == damaged
            rc, out, err = invoke(work, ["run", "-", "--repair"], b"SELECT id FROM users;")
            assert rc == 0 and f"({int(off != 0)} row" in out, (rc, out, err)
            assert check_repair(work, err, damaged, off)[0] == 2 - int(off != 0), err
            assert table.read_bytes() == raw[:off]


def test_incomplete_tails():
    with database() as (work, data):
        assert invoke(work, ["run", "-"], b"INSERT INTO users VALUES ('a',1);")[0] == 0
        table = data / "users.tbl"
        raw = table.read_bytes()
        for tail in [raw[:n] for n in range(1, 12)] + [bytes(40), raw[:-1], bytes(1024 * 1024 + 7)]:
            table.write_bytes(raw + tail)
            rc, out, err = invoke(work, ["run", "-"], b"SELECT id FROM users;")
            assert rc == 0 and "(1 row," in out, (rc, out, err)
            assert err == f"{len(tail)} bytes of incomplete tail truncated at offset {len(raw)}\n", err
            assert table.read_bytes() == raw
        # A zero-looking header with later nonzero bytes is corruption, not padding.
        tail = bytes(40) + b"x"
        table.write_bytes(raw + tail)
        assert invoke(work, ["run", "-"], b"")[0] == 1
        assert table.read_bytes() == raw + tail


def test_invalid_length_guards():
    with database() as (work, data):
        assert invoke(work, ["run", "-"], b"INSERT INTO users VALUES ('a',1);")[0] == 0
        table = data / "users.tbl"
        raw = table.read_bytes()
        for length in (0, 1024 * 1024 - 11, 0xffffffff):
            encoded = length.to_bytes(4, "little")
            damaged = encoded + (zlib.crc32(encoded) ^ 0x4D444231).to_bytes(4, "little") + raw[8:]
            table.write_bytes(damaged)
            rc, out, err = invoke(work, ["run", "-"], b"")
            assert rc == 1 and "invalid record length" in out and not err, (rc, out, err)
            assert table.read_bytes() == damaged
        damaged = bytearray(raw)
        damaged[4] ^= 1
        table.write_bytes(damaged)
        assert invoke(work, ["run", "-"], b"")[0] == 1
        assert table.read_bytes() == damaged


def test_catalog_names():
    for catalog in ("t: id INT\nT: id INT\n", "bad-name: id INT\n", "9bad: id INT\n",
                    "../bad: id INT\n", "bad/name: id INT\n", "한글: id INT\n"):
        with database() as (work, data):
            (data / "catalog.txt").write_text(catalog, encoding="utf-8")
            rc, out, err = invoke(work, ["run", "-"], b"")
            assert rc == 1 and out and not err, (catalog, rc, out, err)
            assert not list(data.glob("*.tbl"))


def test_length_checksum_wire_format():
    with database() as (work, data):
        for size in (0, 1, 255, 65536):
            assert invoke(work, ["run", "-"], b"INSERT INTO users VALUES ('" + b"x" * size + b"',1);")[0] == 0
        raw = (data / "users.tbl").read_bytes()
        off = 0
        while off < len(raw):
            length = int.from_bytes(raw[off:off + 4], "little")
            check = int.from_bytes(raw[off + 4:off + 8], "little")
            assert check == zlib.crc32(raw[off:off + 4]) ^ 0x4D444231, (length, check)
            assert int.from_bytes(raw[off + 8:off + 12], "little") == zlib.crc32(raw[off + 12:off + 12 + length])
            off += 12 + length
        assert off == len(raw)


def test_paired_length_corruption_refuses():
    with database() as (work, data):
        assert invoke(work, ["run", "-"], b"INSERT INTO users VALUES ('a',1),('b',2),('c',3);")[0] == 0
        table = data / "users.tbl"
        raw = table.read_bytes()
        first_end = 12 + int.from_bytes(raw[:4], "little")
        for off in (0, first_end):
            for bit in [8] + [n for n in range(32) if n != 8]:
                damaged = bytearray(raw)
                damaged[off + bit // 8] ^= 1 << (bit % 8)
                damaged[off + 4 + bit // 8] ^= 1 << (bit % 8)
                table.write_bytes(damaged)
                rc, out, err = invoke(work, ["run", "-"], b"")
                assert rc == 1 and "invalid record length" in out and f"offset {off}" in out and not err, (bit, rc, out, err)
                assert table.read_bytes() == damaged
        rc, out, err = invoke(work, ["run", "-", "--repair"], b"SELECT id FROM users;")
        assert rc == 0 and "(1 row," in out, (rc, out, err)
        check_repair(work, err, damaged, first_end)
        assert table.read_bytes() == raw[:first_end]


def test_complete_record_inside_incomplete_tail():
    with database() as (work, data):
        assert invoke(work, ["run", "-"], b"INSERT INTO users VALUES ('a',1);")[0] == 0
        table = data / "users.tbl"
        prefix = table.read_bytes()
        assert invoke(work, ["run", "-"], b"INSERT INTO users VALUES ('" + b"x" * 1024 + b"',2);")[0] == 0
        # Borrow an authentic oversized header, so this also fails on the old format.
        header = table.read_bytes()[len(prefix):len(prefix) + 12]
        for padding in (b"", b"x", bytes(127)):
            tail = header + padding + prefix
            table.write_bytes(prefix + tail)
            rc, out, err = invoke(work, ["run", "-"], b"")
            assert rc == 1 and "offset" in out and not err, (rc, out, err)
            assert table.read_bytes() == prefix + tail
        rc, out, err = invoke(work, ["run", "-", "--repair"], b"SELECT id FROM users;")
        assert rc == 0 and "(1 row," in out, (rc, out, err)
        check_repair(work, err, prefix + tail, len(prefix))
        assert table.read_bytes() == prefix
        # A partial candidate, bad header check, or bad payload CRC is insufficient.
        bad_check, bad_crc = bytearray(prefix), bytearray(prefix)
        bad_check[4] ^= 1
        bad_crc[-1] ^= 1
        for candidate in (prefix[:-1], bad_check, bad_crc):
            tail = header + b"x" + candidate
            table.write_bytes(prefix + tail)
            rc, out, err = invoke(work, ["run", "-"], b"")
            assert rc == 0 and err == f"{len(tail)} bytes of incomplete tail truncated at offset {len(prefix)}\n", (rc, out, err)
            assert table.read_bytes() == prefix


def test_catalog_reserved_identifiers():
    for keyword in ("select", "insert", "into", "values", "from", "where", "limit"):
        for word in (keyword, keyword.upper(), keyword.title()):
            for catalog in (f"{word}: id INT\n", f"t: id INT, {word} TEXT\n"):
                with database() as (work, data):
                    (data / "catalog.txt").write_text(catalog, encoding="ascii")
                    rc, out, err = invoke(work, ["run", "-"], b"")
                    assert rc == 1 and "reserved" in out and not err, (catalog, rc, out, err)
                    assert not list(data.glob("*.tbl"))


def test_missing_data_directory():
    with database() as (work, _):
        missing = work / "missing"
        expect(invoke(work, ["run", "-", "--data", missing], b""), 1,
               f"internal error: data directory not found: {missing}\n")


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


def check_benchmark(out, rows, queries, seed):
    assert f"rows={rows} queries={queries} seed={seed} batch_rows=1000 sync=none\n" in out, out
    assert "first=warm OS cache after INSERT and reopen; repeat=same query sequence" in out, out
    for key in ("insert_total_ms", "startup_ms"):
        assert re.search(rf"^{key}: [0-9]+\.[0-9]{{3}}$", out, re.M), out
    memory = re.search(r"^peak_memory_bytes: ([0-9]+)$", out, re.M)
    assert memory and int(memory[1]) > 0, out
    records = re.findall(
        r"^\| (first|repeat) \| (index|scan) \| ([0-9]+) \| ([0-9]+) \| ([0-9]+) \| "
        r"([0-9]+\.[0-9]{3}) \| ([0-9]+\.[0-9]{3}) \| ([0-9]+\.[0-9]{3}) \|$", out, re.M)
    assert len(records) == 4, out
    assert {(r[0], r[1]) for r in records} == {
        (phase, plan) for phase in ("first", "repeat") for plan in ("index", "scan")}, out
    for _, plan, count, returned, examined, median, p99, maximum in records:
        assert (int(count), int(returned), int(examined)) == (queries, 1, 1 if plan == "index" else rows), out
        assert 0 <= float(median) <= float(p99) <= float(maximum), out


def test_bench_10000():
    with database() as (work, _):
        rc, out, err = invoke(work, ["bench", "--rows", "10000"])
        assert rc == 0 and err == UNSYNCED.format(10000), (rc, out, err)
        check_benchmark(out, 10000, 100, 42)
        expect(invoke(work, ["run", "-", "--data", work / "bench-data"],
                      b"SELECT * FROM users WHERE id = 10000;"), 0,
               "id    | name       | age\n------+------------+----\n10000 | user_10000 | 0\n"
               "(1 row, plan=index, examined=1, <time> ms)\n")


def test_bench_query_only():
    with database() as (work, _):
        rc, out, err = invoke(work, ["bench", "--rows", "10000"])
        assert rc == 0, (rc, out, err)
        before = {path.name: path.read_bytes() for path in (work / "bench-data").iterdir() if path.suffix == ".tbl"}
        rc, out, err = invoke(work, ["bench", "--query-only", "--data", work / "bench-data", "--queries", "30", "--seed", "5"])
        assert rc == 0 and not err, (rc, out, err)
        assert "rows=10000 queries=30 seed=5 query_only=1 sync=none\n" in out, out
        assert "insert_total_ms" not in out and re.search(r"^startup_ms: [0-9]+\.[0-9]{3}$", out, re.M), out
        records = re.findall(
            r"^\| (first|repeat) \| (index|scan) \| ([0-9]+) \| ([0-9]+) \| ([0-9]+) \| "
            r"([0-9]+\.[0-9]{3}) \| ([0-9]+\.[0-9]{3}) \| ([0-9]+\.[0-9]{3}) \|$", out, re.M)
        assert len(records) == 4, out
        medians = {(r[0], r[1]): float(r[5]) for r in records}
        for phase in ("first", "repeat"):
            # The index lookup reads one record; the scan reads all 10000. It must stay faster.
            assert medians[(phase, "index")] < medians[(phase, "scan")], out
        assert {path.name: path.read_bytes() for path in (work / "bench-data").iterdir() if path.suffix == ".tbl"} == before
        # --query-only never inserts: it needs a folder and takes no row count.
        for args in (["--query-only"], ["--query-only", "--rows", "5", "--data", work / "bench-data"],
                     ["--query-only", "--query-only", "--data", work / "bench-data"]):
            rc, out, err = invoke(work, ["bench", *args])
            assert rc == 1 and "error at 0:0:" in out and "usage:" in err, (args, rc, out, err)
        rc, out, err = invoke(work, ["bench", "--query-only", "--data", work / "missing"])
        assert rc == 1 and "internal error:" in out, (rc, out, err)


def test_bench_options_and_partial_batch():
    with database() as (work, _):
        for rows, queries, seed in ((1001, 3, 7), (1, 1, 0)):
            data = work / f"bench data {rows}"
            rc, out, err = invoke(work, ["bench", "--rows", rows, "--queries", queries,
                                       "--seed", seed, "--data", data])
            assert rc == 0 and err == UNSYNCED.format(rows), (rc, out, err)
            check_benchmark(out, rows, queries, seed)
            rc, out, err = invoke(work, ["run", "-", "--data", data],
                                  f"SELECT id FROM users WHERE name = 'user_{rows}';".encode())
            assert rc == 0 and f"\n{rows}\n" in out and f"examined={rows}," in out and not err, (rc, out, err)


def test_bench_invalid_arguments():
    cases = [["--rows", value] for value in ("0", "-1", "1x", " 1", "+1", "9223372036854775808")]
    cases += [["--rows", "1", flag, value] for flag, value in (
        ("--queries", "0"), ("--queries", "-1"), ("--queries", "18446744073709551615"),
        ("--seed", "-1"), ("--seed", "18446744073709551616"), ("--data", ""))]
    cases += [["--rows"], ["--rows", "1", "--queries"], ["--rows", "1", "--seed"],
              ["--rows", "1", "--data"], ["--queries", "2"], ["--rows", "1", "--sync", "none"],
              ["--rows", "1", "--rows", "2"]]
    with database() as (work, _):
        for args in cases:
            rc, out, err = invoke(work, ["bench", *args])
            assert rc == 1 and "error at 0:0:" in out and "usage:" in err, (args, rc, out, err)
        assert not (work / "bench-data").exists(), "invalid arguments created benchmark data"


def test_bench_preserves_existing_directory():
    with database() as (work, data):
        original = (data / "catalog.txt").read_bytes()
        rc, out, err = invoke(work, ["bench", "--rows", "1", "--data", data])
        assert rc == 1 and "internal error:" in out and not err, (rc, out, err)
        assert (data / "catalog.txt").read_bytes() == original
        assert not list(data.glob("*.tbl")), "bench opened an existing database"
        rc, out, err = invoke(work, ["bench", "--rows", "1", "--data", work / "missing" / "child"])
        assert rc == 1 and "internal error:" in out and not err, (rc, out, err)


def main():
    tests = [(path.stem, lambda path=path: fixture(path)) for path in sorted(FIXTURES.glob("*.sql"))]
    tests += [("stdin_basic", lambda: fixture(FIXTURES / "basic_insert_select.sql", stdin=True))]
    tests += [(fn.__name__, fn) for fn in (
        test_defaults_and_reopen, test_sync_none, test_empty_and_bom_input,
        test_input_errors, test_invalid_arguments, test_open_error,
        test_recovery_and_repair, test_parse_error_commits_prefix, test_large_input,
        test_binary_stdin_control_z, test_binary_stdin_crlf,
        test_length_corruption_refuses_and_repairs, test_incomplete_tails,
        test_invalid_length_guards, test_catalog_names, test_missing_data_directory,
        test_length_checksum_wire_format, test_paired_length_corruption_refuses,
        test_complete_record_inside_incomplete_tail, test_catalog_reserved_identifiers,
        test_bench_10000, test_bench_query_only, test_bench_options_and_partial_batch,
        test_bench_invalid_arguments, test_bench_preserves_existing_directory,
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
