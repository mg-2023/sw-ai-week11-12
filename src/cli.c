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
          "[--sync always|none] [--repair]\n", stderr);
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

int cli_main(int argc, char **argv) {
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
