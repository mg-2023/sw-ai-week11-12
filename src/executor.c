#include "executor.h"
#include "os.h"

#include <stdlib.h>
#include <string.h>

static int fail(const Statement *s, DbError *err, const char *message) {
    if (err) {
        err->line = s->line; err->col = s->col;
        err->kind = DB_ERROR_SQL;
        snprintf(err->message, sizeof err->message, "%s", message);
    }
    return -1;
}

static int internal(const Statement *s, DbError *err, const char *message) {
    fail(s, err, message);
    if (err) { err->kind = DB_ERROR_INTERNAL; err->line = err->col = 0; }
    return -1;
}

static int insert_mapping(const TableSchema *schema, const Statement *s, int map[32], DbError *err) {
    int seen[32] = {0};
    int n = s->ncols < 0 ? schema->ncols - 1 : s->ncols;
    for (int i = 0; i < n; i++) {
        int col = s->ncols < 0 ? i + 1 : schema_col_index(schema, s->cols[i]);
        if (col < 0) return fail(s, err, "unknown INSERT column");
        if (col == 0) return fail(s, err, "id is automatic; cannot insert id column");
        if (seen[col]) return fail(s, err, "duplicate INSERT column");
        seen[col] = 1; map[i] = col - 1;
    }
    /* The SQL subset has neither NULL nor DEFAULT. Every non-id field is required. */
    if (n != schema->ncols - 1) return fail(s, err, "missing required INSERT column");
    if (s->row_width != n) return fail(s, err, "VALUES count does not match column count");
    for (int row = 0; row < s->nrows; row++) {
        size_t record_size = 20; /* header and id */
        for (int i = 0; i < n; i++) {
            const Value *v = &s->values[(size_t)row * (size_t)n + (size_t)i];
            if (v->type != schema->cols[map[i] + 1].type) return fail(s, err, "INSERT value type mismatch");
            if (v->type == TYPE_TEXT && v->len > 64u * 1024u) return fail(s, err, "TEXT exceeds 64 KiB");
            record_size += v->type == TYPE_INT ? 8 : 4 + (size_t)v->len;
        }
        if (record_size > 1024u * 1024u) return fail(s, err, "record exceeds 1 MiB");
    }
    return 0;
}

static int insert_rows(Table *table, const Statement *s, const int map[32], StmtResult *out, DbError *err) {
    if ((size_t)s->nrows > SIZE_MAX / sizeof *out->inserted_ids) return internal(s, err, "too many inserted ids");
    out->inserted_ids = malloc((size_t)s->nrows * sizeof *out->inserted_ids);
    if (!out->inserted_ids) return internal(s, err, "out of memory");
    for (int row = 0; row < s->nrows; row++) {
        Value fields[32] = {0};
        for (int i = 0; i < s->row_width; i++) fields[map[i]] = s->values[(size_t)row * (size_t)s->row_width + (size_t)i];
        if (table_append(table, fields, &out->inserted_ids[row], NULL, err)) {
            if (err) {
                char detail[sizeof err->message]; memcpy(detail, err->message, sizeof detail);
                if (err->kind == DB_ERROR_SQL) { err->line = s->line; err->col = s->col; }
                snprintf(err->message, sizeof err->message, "%.180s (%zu rows already inserted)", detail, out->ninserted);
            }
            return -1;
        }
        out->ninserted++;
    }
    return 0;
}

typedef struct {
    const Statement *statement;
    StmtResult *out;
    int columns[32], where_col, failed;
    size_t capacity;
    DbError *err;
} Scan;

static int copy_value(Value *out, const Value *in) {
    *out = *in;
    if (in->type == TYPE_TEXT) {
        out->s = malloc((size_t)in->len + 1);
        if (!out->s) return -1;
        if (in->len) memcpy(out->s, in->s, in->len);
        out->s[in->len] = '\0';
    }
    return 0;
}

static int visit_row(const Row *row, uint64_t off, void *ctx) {
    (void)off;
    Scan *scan = ctx; StmtResult *out = scan->out; const Statement *s = scan->statement;
    out->rows_examined++;
    if (s->has_where) {
        const Value *v = &row->fields[scan->where_col], *w = &s->where_val;
        if (v->type == TYPE_INT ? v->i != w->i :
            (v->len != w->len || (v->len && memcmp(v->s, w->s, v->len)))) return 0;
    }
    if (out->nrows == scan->capacity) {
        size_t max = SIZE_MAX / (size_t)out->ncols / sizeof *out->rows;
        size_t next = scan->capacity ? scan->capacity * 2 : 16;
        if (scan->capacity > max / 2 || next > max) goto memory_error;
        Value *rows = realloc(out->rows, next * (size_t)out->ncols * sizeof *rows);
        if (!rows) goto memory_error;
        out->rows = rows; scan->capacity = next;
    }
    Value *dest = out->rows + out->nrows * (size_t)out->ncols;
    memset(dest, 0, (size_t)out->ncols * sizeof *dest);
    out->nrows++; /* Includes a partial row so failure cleanup frees its TEXT. */
    for (int i = 0; i < out->ncols; i++) {
        if (copy_value(&dest[i], &row->fields[scan->columns[i]])) goto memory_error;
    }
    return s->limit >= 0 && out->nrows >= (uint64_t)s->limit;
memory_error:
    scan->failed = 1;
    internal(s, scan->err, "out of memory copying SELECT result");
    return 1;
}

static int select_rows(Table *table, const TableSchema *schema, const Statement *s, StmtResult *out, DbError *err) {
    Scan scan = {.statement = s, .out = out, .err = err};
    out->is_select = 1; out->plan = PLAN_SCAN;
    out->ncols = s->star ? schema->ncols : s->ncols;
    out->columns = calloc((size_t)out->ncols, sizeof *out->columns);
    if (!out->columns) return internal(s, err, "out of memory");
    for (int i = 0; i < out->ncols; i++) {
        int col = s->star ? i : schema_col_index(schema, s->cols[i]);
        if (col < 0) return fail(s, err, "unknown SELECT column");
        scan.columns[i] = col;
        const char *name = schema->cols[col].name;
        out->columns[i] = malloc(strlen(name) + 1);
        if (!out->columns[i]) return internal(s, err, "out of memory");
        strcpy(out->columns[i], name);
    }
    if (s->has_where) {
        scan.where_col = schema_col_index(schema, s->where_col);
        if (scan.where_col < 0) return fail(s, err, "unknown WHERE column");
        if (schema->cols[scan.where_col].type != s->where_val.type) return fail(s, err, "WHERE value type mismatch");
        if (scan.where_col == 0) out->plan = PLAN_INDEX;
    }
    if (s->limit == 0) return 0;
    if (out->plan == PLAN_INDEX) {
        uint64_t off;
        if (!bpt_find(table_index(table), s->where_val.i, &off)) return 0;
        Row row = {0};
        int rc = table_read_at(table, off, &row, err);
        if (!rc) (void)visit_row(&row, off, &scan);
        row_free(&row);
        return rc || scan.failed ? -1 : 0;
    }
    if (table_scan(table, visit_row, &scan, err) || scan.failed) {
        if (err && err->kind == DB_ERROR_SQL && !err->line) { err->line = s->line; err->col = s->col; }
        return -1;
    }
    return 0;
}

int executor_execute(Table *table, const TableSchema *schema, const Statement *s, StmtResult *out, DbError *err) {
    uint64_t start = os_now_us(); int map[32] = {0};
    *out = (StmtResult){0};
    if (err) *err = (DbError){0};
    if (s->kind == STMT_INSERT && insert_mapping(schema, s, map, err)) return -1;
    int rc = s->kind == STMT_INSERT ? table_write_lock(table) : table_read_lock(table);
    if (rc) return internal(s, err, "cannot acquire table lock");
    rc = s->kind == STMT_INSERT ? insert_rows(table, s, map, out, err) : select_rows(table, schema, s, out, err);
    if (table_unlock(table) && !rc) rc = internal(s, err, "cannot release table lock");
    out->elapsed_us = os_now_us() - start;
    if (rc) stmt_result_free(out);
    return rc;
}
