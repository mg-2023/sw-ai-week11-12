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
