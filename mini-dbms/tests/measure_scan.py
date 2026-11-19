"""Reproducible Phase 1 scan/startup measurement, using only db_execute_sql.

Run before and after changes: python tests/measure_scan.py
All generated data and the measurement executable live under build/.
Startup measures db_open, excluding process launch and SQL input parsing.
The database has just been written, so these are warm OS-cache measurements.
"""
from pathlib import Path
import shutil
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
SOURCE = r'''
#include "db.h"
#include "os.h"
#include <stdio.h>
int main(int argc, char **argv) {
    if (argc != 2 || os_init()) return 1;
    DbError err = {0};
    uint64_t start = os_now_us();
    Db *db = db_open(argv[1], (DbOptions){0}, &err);
    uint64_t startup = os_now_us() - start;
    if (!db) { fprintf(stderr, "%s\n", err.message); return 1; }
    printf("startup: %.3f ms\n", (double)startup / 1000.0);
    Result r = {0};
    int rc = db_execute_sql(db, "SELECT * FROM users WHERE name = 'user_199999'", 0, &r);
    result_print_text(&r, stdout);
    if (!rc && (r.items[0].nrows != 1 || r.items[0].rows_examined != 200000 ||
                r.items[0].rows[0].i != 200000)) rc = 1;
    result_free(&r); db_close(db); os_cleanup(); return rc ? 1 : 0;
}
'''


def main():
    BUILD.mkdir(exist_ok=True)
    work = BUILD / f"measure-{uuid.uuid4().hex}"
    work.mkdir()
    try:
        shutil.copyfile(ROOT / "data/catalog.txt", work / "catalog.txt")
        sql = work / "insert.sql"
        with sql.open("w", encoding="ascii", newline="\n") as out:
            for first in range(0, 200000, 1000):
                out.write("INSERT INTO users VALUES " + ",".join(
                    f"('user_{i}',{i % 100})" for i in range(first, first + 1000)) + ";\n")
        p = subprocess.run([str(BUILD / "mini-dbms.exe"), "run", str(sql),
                            "--data", str(work), "--sync", "none"],
                           capture_output=True, check=True, timeout=180)
        print(p.stderr.decode("utf-8").strip(), flush=True)
        helper = work / "measure.c"
        helper.write_text(SOURCE, encoding="utf-8")
        exe = work / "measure.exe"
        sources = [str(p) for p in sorted((ROOT / "src").glob("*.c"))
                   if p.name not in ("main.c", "cli.c")]
        subprocess.run(["gcc", "-Isrc", "-D_POSIX_C_SOURCE=200809L", "-std=c11", "-O2",
                        "-Wall", "-Wextra", "-Wpedantic", "-Werror", str(helper),
                        *sources, "-o", str(exe), "-pthread", "-lws2_32"], cwd=ROOT, check=True)
        print("200000 rows, warm OS cache; three fresh db_open calls:", flush=True)
        for _ in range(3):
            subprocess.run([str(exe), str(work)], check=True, timeout=60)
    finally:
        assert work.resolve().is_relative_to(BUILD.resolve())
        shutil.rmtree(work)


if __name__ == "__main__":
    main()
