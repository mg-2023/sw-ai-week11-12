#include "result.h"

#include <inttypes.h>
#include <stdlib.h>
#include <string.h>

void stmt_result_free(StmtResult *result) {
    if (!result) return;
    if (result->columns) {
        for (int i = 0; i < result->ncols; i++) free(result->columns[i]);
    }
    for (size_t i = 0; i < result->nrows * (size_t)result->ncols; i++) {
        if (result->rows[i].type == TYPE_TEXT) free(result->rows[i].s);
    }
    free(result->columns); free(result->rows); free(result->inserted_ids);
    *result = (StmtResult){0};
}

void result_free(Result *result) {
    if (!result) return;
    for (size_t i = 0; i < result->n; i++) stmt_result_free(&result->items[i]);
    free(result->items);
    *result = (Result){0};
}

static size_t value_width(const Value *v) {
    if (v->type == TYPE_TEXT) return v->len;
    char number[32];
    return (size_t)snprintf(number, sizeof number, "%" PRId64, v->i);
}

static void padding(FILE *file, size_t count, int ch) {
    for (size_t i = 0; i < count; i++) fputc(ch, file);
}

static void print_select(const StmtResult *s, FILE *file) {
    size_t widths[32] = {0};
    for (int col = 0; col < s->ncols; col++) {
        widths[col] = strlen(s->columns[col]);
        for (size_t row = 0; row < s->nrows; row++) {
            const Value *v = &s->rows[row * (size_t)s->ncols + (size_t)col];
            size_t width = value_width(v);
            if (v->type == TYPE_TEXT && width < 8) width = 8;
            if (width > widths[col]) widths[col] = width;
        }
        if (col) fputs(" | ", file);
        fputs(s->columns[col], file);
        if (col + 1 < s->ncols) padding(file, widths[col] - strlen(s->columns[col]), ' ');
    }
    fputc('\n', file);
    for (int col = 0; col < s->ncols; col++) {
        if (col) fputc('+', file);
        padding(file, widths[col] + (col > 0) + (col + 1 < s->ncols), '-');
    }
    fputc('\n', file);
    for (size_t row = 0; row < s->nrows; row++) {
        for (int col = 0; col < s->ncols; col++) {
            const Value *v = &s->rows[row * (size_t)s->ncols + (size_t)col];
            if (col) fputs(" | ", file);
            size_t pad = col + 1 < s->ncols ? widths[col] - value_width(v) : 0;
            if (v->type == TYPE_INT) {
                padding(file, pad, ' ');
                fprintf(file, "%" PRId64, v->i);
            } else {
                if (v->len) fwrite(v->s, 1, v->len, file);
                padding(file, pad, ' ');
            }
        }
        fputc('\n', file);
    }
    const char *plan = s->plan == PLAN_INDEX ? "index" : s->plan == PLAN_SCAN ? "scan" : "none";
    fprintf(file, "(%zu %s, plan=%s, examined=%" PRIu64 ", %.3f ms)\n",
            s->nrows, s->nrows == 1 ? "row" : "rows", plan, s->rows_examined, (double)s->elapsed_us / 1000.0);
}

void result_print_text(const Result *result, FILE *file) {
    if (!result || !file) return;
    for (size_t i = 0; i < result->n; i++) {
        const StmtResult *s = &result->items[i];
        if (s->is_select) print_select(s, file);
        else {
            fprintf(file, "(%zu %s inserted, ids=", s->ninserted, s->ninserted == 1 ? "row" : "rows");
            for (size_t j = 0; j < s->ninserted; j++) fprintf(file, "%s%" PRId64, j ? "," : "", s->inserted_ids[j]);
            fprintf(file, ", %.3f ms)\n", (double)s->elapsed_us / 1000.0);
        }
    }
    if (!result->ok) {
        if (result->err.kind == DB_ERROR_INTERNAL) fprintf(file, "internal error: %s\n", result->err.message);
        else fprintf(file, "error at %d:%d: %s\n", result->err.line, result->err.col, result->err.message);
    }
}

/* ---- JSON (design 2.10) ---- */
typedef struct { char *p; size_t len, cap; int failed; } JsonBuf;

/* Append n bytes; a failed allocation is remembered and checked once at the end. */
static void jb_put(JsonBuf *b, const void *data, size_t n) {
    if (b->failed) return;
    if (b->len + n + 1 > b->cap) {
        size_t cap = b->cap ? b->cap : 256;
        while (b->len + n + 1 > cap) cap *= 2;
        char *bigger = realloc(b->p, cap);
        if (!bigger) { b->failed = 1; return; }
        b->p = bigger; b->cap = cap;
    }
    memcpy(b->p + b->len, data, n);
    b->len += n;
    b->p[b->len] = '\0';
}
static void jb_str(JsonBuf *b, const char *s) { jb_put(b, s, strlen(s)); }
static void jb_i64(JsonBuf *b, int64_t v) { char t[32]; int n = snprintf(t, sizeof t, "%" PRId64, v); jb_put(b, t, (size_t)n); }
static void jb_u64(JsonBuf *b, uint64_t v) { char t[32]; int n = snprintf(t, sizeof t, "%" PRIu64, v); jb_put(b, t, (size_t)n); }

/* Length (1-4) of the valid UTF-8 sequence at s, or 0 when invalid (overlong, surrogate, > U+10FFFF, truncated). */
static size_t utf8_seq_len(const unsigned char *s, size_t n) {
    unsigned char c = s[0];
    size_t need; unsigned char lo = 0x80, hi = 0xBF;
    if (c < 0x80) return 1;
    if (c >= 0xC2 && c <= 0xDF) need = 1;
    else if (c >= 0xE0 && c <= 0xEF) { need = 2; if (c == 0xE0) lo = 0xA0; if (c == 0xED) hi = 0x9F; }
    else if (c >= 0xF0 && c <= 0xF4) { need = 3; if (c == 0xF0) lo = 0x90; if (c == 0xF4) hi = 0x8F; }
    else return 0;
    if (n < need + 1 || s[1] < lo || s[1] > hi) return 0;
    for (size_t i = 2; i <= need; i++) if (s[i] < 0x80 || s[i] > 0xBF) return 0;
    return need + 1;
}

/* Write a quoted JSON string : controls as \u00XX, quote and backslash escaped, each invalid UTF-8 byte as �. */
static void jb_string(JsonBuf *b, const char *bytes, size_t n) {
    static const char hex[] = "0123456789abcdef";
    const unsigned char *s = (const unsigned char *)bytes;
    jb_put(b, "\"", 1);
    for (size_t i = 0; i < n;) {
        unsigned char c = s[i];
        if (c == '"' || c == '\\') { char t[2] = {'\\', (char)c}; jb_put(b, t, 2); i++; }
        else if (c < 0x20) { char t[6] = {'\\', 'u', '0', '0', hex[c >> 4], hex[c & 15]}; jb_put(b, t, 6); i++; }
        else {
            size_t k = utf8_seq_len(s + i, n - i);
            if (k == 0) { jb_str(b, "\\ufffd"); i++; }
            else { jb_put(b, s + i, k); i += k; }
        }
    }
    jb_put(b, "\"", 1);
}

static void json_value(JsonBuf *b, const Value *v) {
    if (v->type == TYPE_INT) jb_i64(b, v->i);
    else jb_string(b, v->s ? v->s : "", v->len);
}

static void json_statement(JsonBuf *b, const StmtResult *s) {
    jb_str(b, "{\"columns\":[");
    for (int c = 0; c < s->ncols; c++) { if (c) jb_put(b, ",", 1); jb_string(b, s->columns[c], strlen(s->columns[c])); }
    jb_str(b, "],\"rows\":[");
    for (size_t r = 0; r < s->nrows; r++) {
        if (r) jb_put(b, ",", 1);
        jb_put(b, "[", 1);
        for (int c = 0; c < s->ncols; c++) { if (c) jb_put(b, ",", 1); json_value(b, &s->rows[r * (size_t)s->ncols + (size_t)c]); }
        jb_put(b, "]", 1);
    }
    jb_str(b, "],\"plan\":");
    jb_str(b, s->plan == PLAN_INDEX ? "\"index\"" : s->plan == PLAN_SCAN ? "\"scan\"" : "\"none\"");
    jb_str(b, ",\"rows_examined\":"); jb_u64(b, s->rows_examined);
    jb_str(b, ",\"inserted_ids\":[");
    for (size_t i = 0; i < s->ninserted; i++) { if (i) jb_put(b, ",", 1); jb_i64(b, s->inserted_ids[i]); }
    jb_str(b, "]}");
}

int result_to_json(const Result *result, int worker_id, char **out, size_t *len) {
    JsonBuf b = {0};
    if (!result || !out) return -1;
    if (result->ok) {
        jb_str(&b, "{\"ok\":true,\"results\":[");
        for (size_t i = 0; i < result->n; i++) { if (i) jb_put(&b, ",", 1); json_statement(&b, &result->items[i]); }
        jb_str(&b, "],\"elapsed_us\":"); jb_u64(&b, result->elapsed_us);
        jb_str(&b, ",\"worker\":"); jb_i64(&b, worker_id);
        jb_str(&b, "}");
    } else {
        jb_str(&b, "{\"ok\":false,\"error\":{\"statement\":"); jb_u64(&b, result->failed_index);
        jb_str(&b, ",\"line\":"); jb_i64(&b, result->err.line);
        jb_str(&b, ",\"col\":"); jb_i64(&b, result->err.col);
        jb_str(&b, ",\"message\":"); jb_string(&b, result->err.message, strlen(result->err.message));
        jb_str(&b, "},\"committed\":"); jb_u64(&b, result->committed);
        jb_str(&b, "}");
    }
    if (b.failed) { free(b.p); return -1; }
    *out = b.p;
    if (len) *len = b.len;
    return 0;
}

int result_http_status(const Result *result) {
    if (!result || result->ok) return 200;
    if (result->err.kind == DB_ERROR_DEADLINE) return 503;
    return result->err.kind == DB_ERROR_INTERNAL ? 500 : 400;
}
