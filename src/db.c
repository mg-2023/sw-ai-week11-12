#include "db.h"
#include "executor.h"
#include "os.h"

#include <limits.h>
#include <stdlib.h>
#include <string.h>

struct Db {
    Catalog catalog;
    Table **tables;
    int owns_lock;
};

static int fail(DbError *err, int line, int col, const char *message) {
    if (err) {
        (void)line; (void)col;
        err->kind = DB_ERROR_INTERNAL;
        err->line = 0; err->col = 0;
        snprintf(err->message, sizeof err->message, "%s", message);
    }
    return -1;
}

void db_close(Db *db) {
    if (!db) return;
    if (db->tables) {
        for (int i = 0; i < db->catalog.n; i++) table_close(db->tables[i]);
    }
    free(db->tables);
    catalog_free(&db->catalog);
    if (db->owns_lock) os_unlock_dir();
    free(db);
}

typedef struct {
    int64_t *ids;
    uint64_t *offsets;
    size_t n, capacity;
} IndexBuild;

static int collect_index_row(int64_t id, uint64_t off, void *ctx) {
    IndexBuild *build = ctx;
    if (build->n == build->capacity) {
        size_t max = SIZE_MAX / sizeof *build->ids;
        if (build->capacity > max / 2) return -1;
        size_t next = build->capacity ? build->capacity * 2 : 256;
        if (next > max) return -1;
        int64_t *ids = realloc(build->ids, next * sizeof *ids);
        if (!ids) return -1;
        build->ids = ids;
        uint64_t *offsets = realloc(build->offsets, next * sizeof *offsets);
        if (!offsets) return -1;
        build->offsets = offsets; build->capacity = next;
    }
    build->ids[build->n] = id; build->offsets[build->n++] = off;
    return 0;
}

Db *db_open(const char *dir, DbOptions options, DbError *err) {
    if (err) *err = (DbError){0};
    if (!dir) { fail(err, 0, 0, "missing database directory"); return NULL; }
    if (!os_is_directory(dir)) {
        fail(err, 0, 0, "data directory not found");
        if (err) snprintf(err->message, sizeof err->message, "data directory not found: %s", dir);
        return NULL;
    }
    Db *db = calloc(1, sizeof *db);
    if (!db) { fail(err, 0, 0, "out of memory"); return NULL; }
    if (os_lock_dir(dir)) { fail(err, 0, 0, "cannot lock database directory (already open or unavailable)"); goto bad; }
    db->owns_lock = 1;
    size_t len = strlen(dir);
    if (len > SIZE_MAX - sizeof "/catalog.txt") { fail(err, 0, 0, "catalog path too long"); goto bad; }
    char *path = malloc(len + sizeof "/catalog.txt");
    if (!path) { fail(err, 0, 0, "out of memory"); goto bad; }
    snprintf(path, len + sizeof "/catalog.txt", "%s/catalog.txt", dir);
    int rc = catalog_load(path, &db->catalog, err);
    free(path);
    if (rc) goto bad;
    if (db->catalog.n) {
        db->tables = calloc((size_t)db->catalog.n, sizeof *db->tables);
        if (!db->tables) { fail(err, 0, 0, "out of memory"); goto bad; }
    }
    for (int i = 0; i < db->catalog.n; i++) {
        IndexBuild build = {0};
        db->tables[i] = table_open_with_visitor(dir, &db->catalog.tables[i], options.repair,
                                               collect_index_row, &build, err);
        if (!db->tables[i]) { free(build.ids); free(build.offsets); goto bad; }
        BPTree *index = bpt_create();
        int failed = !index || bpt_bulk_load(index, build.ids, build.offsets, build.n);
        free(build.ids); free(build.offsets);
        if (failed) {
            bpt_free(index); fail(err, 0, 0, "cannot build table index"); goto bad;
        }
        table_set_index(db->tables[i], index);
        table_set_sync(db->tables[i], options.sync_always);
    }
    return db;
bad:
    db_close(db);
    return NULL;
}

/* Find a single statement without lexing later statements: a later lexical or
 * syntax error must not erase earlier commits. Only delimiters are recognized;
 * parse_sql remains responsible for all SQL validation and decoded values.
 */
static const char *statement_end(const char *p) {
    int quoted = 0, comment = 0;
    while (*p) {
        if (comment) {
            if (*p == '\n') comment = 0;
        } else if (quoted) {
            if (*p == '\'') {
                if (p[1] == '\'') { p += 2; continue; }
                quoted = 0;
            }
        } else {
            if (*p == '-' && p[1] == '-') { comment = 1; p += 2; continue; }
            if (*p == '\'') quoted = 1;
            else if (*p == ';') return p + 1;
        }
        p++;
    }
    return p;
}

static void absolute_position(int *line, int *col, int base_line, int base_col) {
    if (*line == 1) *col = *col > INT_MAX - (base_col - 1) ? INT_MAX : *col + (base_col - 1);
    *line = *line > INT_MAX - (base_line - 1) ? INT_MAX : *line + (base_line - 1);
}

int db_execute_sql(Db *db, const char *sql, Result *out) {
    if (!out) return -1;
    *out = (Result){.failed_index = SIZE_MAX};
    uint64_t start = os_now_us();
    if (!db || !sql) { fail(&out->err, 1, 1, "missing database or SQL"); goto bad; }
    const char *begin = sql; int line = 1, col = 1;
    size_t capacity = 0;
    while (*begin) {
        const char *end = statement_end(begin);
        size_t len = (size_t)(end - begin);
        char *chunk = malloc(len + 1);
        if (!chunk) { fail(&out->err, line, col, "out of memory"); goto bad; }
        memcpy(chunk, begin, len); chunk[len] = '\0';
        StatementList statements = {0};
        int rc = parse_sql(chunk, &statements, &out->err);
        free(chunk);
        if (rc) {
            if (out->err.kind == DB_ERROR_SQL) absolute_position(&out->err.line, &out->err.col, line, col);
            goto bad;
        }
        if (statements.n) {
            Statement *s = &statements.items[0];
            absolute_position(&s->line, &s->col, line, col);
            if (out->n == capacity) {
                size_t max = SIZE_MAX / sizeof *out->items;
                size_t next = capacity ? capacity * 2 : 4;
                if (capacity > max / 2 || next > max) {
                    fail(&out->err, s->line, s->col, "too many results");
                    statements_free(&statements); goto bad;
                }
                StmtResult *items = realloc(out->items, next * sizeof *items);
                if (!items) {
                    fail(&out->err, s->line, s->col, "out of memory");
                    statements_free(&statements); goto bad;
                }
                out->items = items; capacity = next;
            }
            const TableSchema *schema = catalog_find(&db->catalog, s->table);
            if (!schema) {
                rc = fail(&out->err, s->line, s->col, "unknown table");
                out->err.kind = DB_ERROR_SQL; out->err.line = s->line; out->err.col = s->col;
            }
            else rc = executor_execute(db->tables[schema - db->catalog.tables], schema, s, &out->items[out->n], &out->err);
            statements_free(&statements);
            if (rc) goto bad;
            out->n++; out->committed = out->n;
        } else statements_free(&statements);
        for (const char *p = begin; p < end; p++) {
            if (*p == '\n') { if (line < INT_MAX) line++; col = 1; }
            else if (col < INT_MAX) col++;
        }
        begin = end;
    }
    out->ok = 1;
    out->elapsed_us = os_now_us() - start;
    return 0;
bad:
    out->failed_index = out->n;
    out->elapsed_us = os_now_us() - start;
    return -1;
}

uint64_t db_table_row_count(const Db *db, const char *table) {
    const TableSchema *schema = catalog_find(&db->catalog, table);
    return schema ? table_row_count(db->tables[schema - db->catalog.tables]) : UINT64_MAX;
}

int db_table_count(const Db *db) { return db->catalog.n; }
const char *db_table_name(const Db *db, int index) { return db->catalog.tables[index].name; }
uint64_t db_table_rows_at(const Db *db, int index) { return table_row_count(db->tables[index]); }

void db_insert_lock_wait(const Db *db, uint64_t *p99_us, uint64_t *max_us, uint64_t *samples) {
    *p99_us = *max_us = *samples = 0;
    uint32_t *all = malloc(TABLE_WAIT_SAMPLES * sizeof *all * (size_t)(db->catalog.n ? db->catalog.n : 1));
    if (!all) return;
    size_t n = 0;
    for (int i = 0; i < db->catalog.n; i++) {
        uint64_t max, total;
        n += table_write_wait_samples(db->tables[i], all + n, &max, &total);
        if (max > *max_us) *max_us = max;
        *samples += total;
    }
    *p99_us = wait_p99(all, n);
    free(all);
}

uint64_t db_rows_written(const Db *db) {
    uint64_t count = 0;
    for (int i = 0; i < db->catalog.n; i++) count += table_rows_written(db->tables[i]);
    return count;
}
