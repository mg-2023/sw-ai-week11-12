#include "cli.h"
#include "db.h"
#include "os.h"

#include <stdlib.h>
#include <string.h>
#include <inttypes.h>

static int report_error(const char *message, DbErrorKind kind) {
    Result result = {.err = {.kind = kind}};
    snprintf(result.err.message, sizeof result.err.message, "%s", message);
    result_print_text(&result, stdout);
    return 1;
}

static int usage(void) {
    report_error("invalid command or arguments", DB_ERROR_SQL);
    fputs("usage: mini-dbms run <file.sql|-> [--data DIR] "
          "[--sync always|none] [--repair]\n"
          "       mini-dbms bench --rows N [--data DIR] [--queries 100] [--seed 42]\n"
          "       mini-dbms bench --query-only --data DIR [--queries 100] [--seed 42]\n"
          "       mini-dbms serve [--port 8100] [--threads 4] [--queue 64] [--data DIR] [--sync always|none]\n", stderr);
    return 1;
}

/* Read the entire input before opening the database. An input I/O/allocation
 * error cannot accidentally execute a truncated SQL program. No CLI size cap:
 * the 1 MiB HTTP body limit belongs to the later HTTP interface.
 */
static char *read_sql(FILE *file, const char **error) {
    size_t capacity = 4096, used = 0;
    char *sql = malloc(capacity);
    if (!sql) { *error = "out of memory reading SQL input"; return NULL; }
    for (;;) {
        size_t got = fread(sql + used, 1, capacity - used - 1, file);
        used += got;
        if (ferror(file)) { *error = "cannot read SQL input"; break; }
        if (feof(file)) {
            if (memchr(sql, '\0', used)) { *error = "SQL input contains NUL byte"; break; }
            /* UTF-8 BOMs from text editors are not part of the SQL statement. */
            if (used >= 3 && memcmp(sql, "\xef\xbb\xbf", 3) == 0) {
                used -= 3;
                memmove(sql, sql + 3, used);
            }
            sql[used] = '\0';
            return sql;
        }
        if (capacity > SIZE_MAX / 2) { *error = "SQL input too large"; break; }
        size_t next = capacity * 2;
        char *grown = realloc(sql, next);
        if (!grown) { *error = "out of memory reading SQL input"; break; }
        sql = grown; capacity = next;
    }
    free(sql);
    return NULL;
}

/* Strict decimal parsing, bounded before multiplication; no signed wrap or
 * acceptance of strtoull's optional sign/whitespace. */
static int decimal(const char *text, uint64_t maximum, uint64_t *out) {
    if (!*text) return -1;
    uint64_t value = 0;
    for (const char *p = text; *p; p++) {
        if (*p < '0' || *p > '9') return -1;
        unsigned digit = (unsigned)(*p - '0');
        if (value > maximum / 10 || (value == maximum / 10 && digit > maximum % 10)) return -1;
        value = value * 10 + digit;
    }
    *out = value;
    return 0;
}

static int bench_error(const DbError *err) {
    Result result = {.err = *err};
    result_print_text(&result, stdout);
    return 1;
}

/* SplitMix64: specified unsigned arithmetic, reproducible including seed zero. */
static uint64_t random_next(uint64_t *state) {
    uint64_t z = (*state += UINT64_C(0x9e3779b97f4a7c15));
    z = (z ^ (z >> 30)) * UINT64_C(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)) * UINT64_C(0x94d049bb133111eb);
    return z ^ (z >> 31);
}

typedef struct {
    double median_ms, p99_ms, max_ms;
    size_t returned;
    uint64_t examined;
    Plan plan;
} BenchStats;

static int compare_times(const void *left, const void *right) {
    uint64_t a = *(const uint64_t *)left, b = *(const uint64_t *)right;
    return (a > b) - (a < b);
}

static void summarize(uint64_t *times, size_t n, BenchStats *stats) {
    qsort(times, n, sizeof *times, compare_times);
    stats->median_ms = n % 2 ? (double)times[n / 2] / 1000.0 :
        ((double)times[n / 2 - 1] + (double)times[n / 2]) / 2000.0;
    /* Nearest rank: ceil(0.99*n)-1, without overflowing 99*n. */
    stats->p99_ms = (double)times[n - n / 100 - 1] / 1000.0;
    stats->max_ms = (double)times[n - 1] / 1000.0;
}

static int bench_insert(Db *db, uint64_t rows, DbError *err) {
    char sql[65536];
    for (uint64_t first = 0; first < rows;) {
        uint64_t count = rows - first < 1000 ? rows - first : 1000;
        size_t used = (size_t)snprintf(sql, sizeof sql, "INSERT INTO users VALUES ");
        for (uint64_t j = 1; j <= count; j++) {
            uint64_t id = first + j;
            int n = snprintf(sql + used, sizeof sql - used, "%s('user_%" PRIu64 "',%" PRIu64 ")",
                             j == 1 ? "" : ",", id, id % 100);
            if (n < 0 || (size_t)n >= sizeof sql - used - 1) {
                err->kind = DB_ERROR_INTERNAL;
                snprintf(err->message, sizeof err->message, "benchmark SQL buffer exhausted");
                return -1;
            }
            used += (size_t)n;
        }
        sql[used++] = ';'; sql[used] = '\0';
        Result result = {0};
        int rc = db_execute_sql(db, sql, &result);
        if (rc) *err = result.err;
        else if (result.n != 1 || result.items[0].ninserted != count ||
                 result.items[0].inserted_ids[0] != (int64_t)(first + 1) ||
                 result.items[0].inserted_ids[count - 1] != (int64_t)(first + count)) {
            err->kind = DB_ERROR_INTERNAL;
            snprintf(err->message, sizeof err->message, "benchmark INSERT result mismatch");
            rc = -1;
        }
        result_free(&result);
        if (rc) return -1;
        first += count;
    }
    return 0;
}

static int bench_queries(Db *db, uint64_t rows, size_t queries, uint64_t seed,
                         uint64_t *times, BenchStats stats[2], DbError *err) {
    for (size_t i = 0; i < queries; i++) {
        uint64_t id = random_next(&seed) % rows + 1;
        char name[32], sql[128];
        snprintf(name, sizeof name, "user_%" PRIu64, id);
        /* Alternate which plan runs first, so neither one always meets the colder cache. */
        for (int step = 0; step < 2; step++) {
            int plan = i % 2 ? 1 - step : step;
            if (plan == 0) snprintf(sql, sizeof sql, "SELECT * FROM users WHERE id = %" PRIu64 ";", id);
            else snprintf(sql, sizeof sql, "SELECT * FROM users WHERE name = '%s';", name);
            Result result = {0};
            int rc = db_execute_sql(db, sql, &result);
            if (rc) *err = result.err;
            else {
                StmtResult *s = result.n == 1 ? &result.items[0] : NULL;
                if (!s || !s->is_select || s->nrows != 1 || s->ncols != 3 ||
                    s->plan != (plan == 0 ? PLAN_INDEX : PLAN_SCAN) ||
                    s->rows_examined != (plan == 0 ? 1 : rows) ||
                    s->rows[0].type != TYPE_INT || s->rows[0].i != (int64_t)id ||
                    s->rows[1].type != TYPE_TEXT || s->rows[1].len != strlen(name) ||
                    memcmp(s->rows[1].s, name, strlen(name)) ||
                    s->rows[2].type != TYPE_INT || s->rows[2].i != (int64_t)(id % 100)) {
                    err->kind = DB_ERROR_INTERNAL;
                    snprintf(err->message, sizeof err->message, "benchmark SELECT result mismatch");
                    rc = -1;
                } else {
                    times[(size_t)plan * queries + i] = s->elapsed_us;
                    stats[plan].returned = s->nrows;
                    stats[plan].examined = s->rows_examined;
                    stats[plan].plan = s->plan;
                }
            }
            result_free(&result);
            if (rc) return -1;
        }
    }
    for (int plan = 0; plan < 2; plan++) summarize(times + (size_t)plan * queries, queries, &stats[plan]);
    return 0;
}

static void print_stats_table(const BenchStats stats[4], uint64_t queries) {
    puts("| pass | plan | queries | rows/result | rows_examined/query | median_ms | p99_ms | max_ms |");
    puts("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (int i = 0; i < 4; i++) {
        printf("| %s | %s | %" PRIu64 " | %zu | %" PRIu64 " | %.3f | %.3f | %.3f |\n",
               i < 2 ? "first" : "repeat", stats[i].plan == PLAN_INDEX ? "index" : "scan",
               queries, stats[i].returned, stats[i].examined, stats[i].median_ms, stats[i].p99_ms, stats[i].max_ms);
    }
}

/* Open an existing bench folder without inserting; measure only startup and queries.
 * Run right after a reboot to see the first open and first queries with a cold OS cache. */
static int bench_query_only(const char *dir, uint64_t queries, uint64_t seed) {
    DbError err = {.kind = DB_ERROR_INTERNAL};
    uint64_t *times = malloc((size_t)queries * 2 * sizeof *times);
    if (!times) return report_error("out of memory for benchmark samples", DB_ERROR_INTERNAL);
    if (os_init()) { free(times); return report_error("cannot initialize OS layer", DB_ERROR_INTERNAL); }
    uint64_t start = os_now_us();
    Db *db = db_open(dir, (DbOptions){.sync_always = 0}, &err);
    uint64_t startup_us = os_now_us() - start;
    int rc = 1;
    BenchStats stats[4] = {0};
    uint64_t rows = db ? db_table_row_count(db, "users") : 0;
    if (!db) goto done;
    if (!rows || rows == UINT64_MAX || rows > INT64_MAX) {
        snprintf(err.message, sizeof err.message, "query-only benchmark needs a users table with rows: %s", dir);
        goto done;
    }
    for (int pass = 0; pass < 2; pass++) {
        if (bench_queries(db, rows, (size_t)queries, seed, times, stats + pass * 2, &err)) goto done;
    }
    db_close(db); db = NULL;
    uint64_t peak = os_peak_memory_bytes();
    if (peak == UINT64_MAX) { snprintf(err.message, sizeof err.message, "cannot measure peak memory"); goto done; }
    printf("rows=%" PRIu64 " queries=%" PRIu64 " seed=%" PRIu64 " query_only=1 sync=none\n", rows, queries, seed);
    puts("cache: first=OS cache as found at start (cold only if it was emptied, e.g. by a reboot); repeat=same query sequence");
    printf("startup_ms: %.3f\n", (double)startup_us / 1000.0);
    print_stats_table(stats, queries);
    printf("peak_memory_bytes: %" PRIu64 "\n", peak);
    rc = 0;
done:
    if (rc) bench_error(&err);
    db_close(db); os_cleanup(); free(times);
    if (fflush(stdout) == EOF || ferror(stdout)) return 1;
    return rc;
}

static int bench_main(int argc, char **argv) {
    const char *dir = "bench-data";
    uint64_t rows = 0, queries = 100, seed = 42;
    unsigned seen = 0;
    for (int i = 2; i < argc; i++) {
        unsigned flag;
        uint64_t *value = NULL, maximum = UINT64_MAX;
        if (strcmp(argv[i], "--rows") == 0) { flag = 1; value = &rows; maximum = INT64_MAX; }
        else if (strcmp(argv[i], "--queries") == 0) { flag = 2; value = &queries; maximum = SIZE_MAX / (2 * sizeof(uint64_t)); }
        else if (strcmp(argv[i], "--seed") == 0) { flag = 4; value = &seed; }
        else if (strcmp(argv[i], "--data") == 0) flag = 8;
        else if (strcmp(argv[i], "--query-only") == 0) {
            if (seen & 16) return usage();
            seen |= 16; continue;
        }
        else return usage();
        if ((seen & flag) || ++i >= argc) return usage();
        seen |= flag;
        if (value) { if (decimal(argv[i], maximum, value)) return usage(); }
        else { dir = argv[i]; if (!*dir) return usage(); }
    }
    if (seen & 16) {
        /* Existing data only: the folder is required and the row count is not given. */
        if ((seen & 1) || !(seen & 8) || !queries) return usage();
        return bench_query_only(dir, queries, seed);
    }
    if (!rows || !queries) return usage();
    uint64_t *times = malloc((size_t)queries * 2 * sizeof *times);
    if (!times) return report_error("out of memory for benchmark samples", DB_ERROR_INTERNAL);
    if (os_init()) { free(times); return report_error("cannot initialize OS layer", DB_ERROR_INTERNAL); }
    DbError err = {.kind = DB_ERROR_INTERNAL};
    Db *db = NULL;
    int rc = 1;
    /* Never reuse or truncate an existing database, even an empty directory. */
    if (os_create_directory(dir)) {
        snprintf(err.message, sizeof err.message, "benchmark requires a new data directory: %s", dir);
        goto done;
    }
    size_t len = strlen(dir);
    if (len > SIZE_MAX - sizeof "/catalog.txt") {
        snprintf(err.message, sizeof err.message, "benchmark path too long"); goto done;
    }
    char *path = malloc(len + sizeof "/catalog.txt");
    if (!path) { snprintf(err.message, sizeof err.message, "out of memory"); goto done; }
    snprintf(path, len + sizeof "/catalog.txt", "%s/catalog.txt", dir);
    FILE *catalog = fopen(path, "wb");
    free(path);
    if (!catalog) { snprintf(err.message, sizeof err.message, "cannot create benchmark catalog"); goto done; }
    int failed = fputs("users : id INT, name TEXT, age INT\n", catalog) == EOF;
    if (fclose(catalog)) failed = 1;
    if (failed) { snprintf(err.message, sizeof err.message, "cannot write benchmark catalog"); goto done; }
    db = db_open(dir, (DbOptions){.sync_always = 0}, &err);
    if (!db) goto done;
    uint64_t start = os_now_us();
    failed = bench_insert(db, rows, &err);
    uint64_t insert_us = os_now_us() - start;
    fprintf(stderr, "warning: --sync none: rows written since the last synchronization may be lost on OS failure; rows written this run: %" PRIu64 "\n", db_rows_written(db));
    if (failed) goto done;
    db_close(db); db = NULL;
    start = os_now_us();
    db = db_open(dir, (DbOptions){.sync_always = 0}, &err);
    uint64_t startup_us = os_now_us() - start;
    if (!db) goto done;
    BenchStats stats[4] = {0};
    for (int pass = 0; pass < 2; pass++) {
        if (bench_queries(db, rows, (size_t)queries, seed, times, stats + pass * 2, &err)) goto done;
    }
    db_close(db); db = NULL;
    uint64_t peak = os_peak_memory_bytes();
    if (peak == UINT64_MAX) {
        err.kind = DB_ERROR_INTERNAL;
        snprintf(err.message, sizeof err.message, "cannot measure peak memory"); goto done;
    }
    printf("rows=%" PRIu64 " queries=%" PRIu64 " seed=%" PRIu64 " batch_rows=1000 sync=none\n", rows, queries, seed);
    puts("cache: first=warm OS cache after INSERT and reopen; repeat=same query sequence");
    printf("insert_total_ms: %.3f\nstartup_ms: %.3f\n", (double)insert_us / 1000.0, (double)startup_us / 1000.0);
    print_stats_table(stats, queries);
    printf("peak_memory_bytes: %" PRIu64 "\n", peak);
    rc = 0;
done:
    if (rc) {
        bench_error(&err);
    }
    db_close(db); os_cleanup(); free(times);
    if (fflush(stdout) == EOF || ferror(stdout)) return 1;
    return rc;
}

int cli_main(int argc, char **argv) {
    if (argc >= 2 && strcmp(argv[1], "bench") == 0) return bench_main(argc, argv);
    if (argc < 3 || strcmp(argv[1], "run") != 0) return usage();
    const char *input = argv[2], *dir = "data";
    DbOptions options = {.sync_always = 1};
    if (!input[0] || (input[0] == '-' && strcmp(input, "-") != 0)) return usage();
    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "--repair") == 0) options.repair = 1;
        else if (strcmp(argv[i], "--data") == 0) {
            if (++i >= argc || !argv[i][0]) return usage();
            dir = argv[i];
        } else if (strcmp(argv[i], "--sync") == 0) {
            if (++i >= argc) return usage();
            if (strcmp(argv[i], "always") == 0) options.sync_always = 1;
            else if (strcmp(argv[i], "none") == 0) options.sync_always = 0;
            else return usage();
        } else return usage();
    }

    FILE *file = strcmp(input, "-") == 0 ? stdin : fopen(input, "rb");
    if (!file) return report_error("cannot open SQL file", DB_ERROR_INTERNAL);
    if (file == stdin && os_stdin_binary()) return report_error("cannot set binary standard input", DB_ERROR_INTERNAL);
    const char *error = NULL;
    char *sql = read_sql(file, &error);
    if (file != stdin && fclose(file) != 0 && !error) error = "cannot close SQL file";
    if (error) { free(sql); return report_error(error, strcmp(error, "SQL input contains NUL byte") == 0 ? DB_ERROR_SQL : DB_ERROR_INTERNAL); }

    if (os_init() != 0) { free(sql); return report_error("cannot initialize OS layer", DB_ERROR_INTERNAL); }
    DbError db_error = {0};
    Db *db = db_open(dir, options, &db_error);
    if (!db) {
        Result result = {.err = db_error};
        result_print_text(&result, stdout);
        free(sql); os_cleanup();
        return 1;
    }
    Result result = {0};
    int rc = db_execute_sql(db, sql, &result);
    if (!options.sync_always) {
        fprintf(stderr, "warning: --sync none: rows written since the last synchronization may be lost on OS failure; rows written this run: %" PRIu64 "\n", db_rows_written(db));
    }
    result_print_text(&result, stdout);
    if (rc && result.committed) {
        fprintf(stdout, "(%zu %s committed before error)\n", result.committed,
                result.committed == 1 ? "statement" : "statements");
    }
    result_free(&result);
    db_close(db);
    os_cleanup();
    free(sql);
    if (fflush(stdout) == EOF || ferror(stdout)) return 1;
    return rc ? 1 : 0;
}
