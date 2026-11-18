#ifndef MINI_DBMS_RESULT_H
#define MINI_DBMS_RESULT_H

#include "parser.h"
#include <stdio.h>

typedef enum { PLAN_NONE, PLAN_INDEX, PLAN_SCAN } Plan;

typedef struct {
    int is_select; char **columns; int ncols;
    Value *rows; size_t nrows;
    Plan plan; uint64_t rows_examined; uint64_t elapsed_us;
    int64_t *inserted_ids; size_t ninserted;
} StmtResult;

typedef struct {
    int ok; StmtResult *items; size_t n; size_t committed; size_t failed_index;
    DbError err; uint64_t elapsed_us;
} Result;

/* Results own all columns, TEXT bytes and inserted ids. Free is idempotent.
 * committed counts successful statements (including SELECT), not rows.
 * failed_index is zero-based, SIZE_MAX on success. items holds only successful
 * statements. There is no multi-statement transaction, but each INSERT is
 * atomic: after a failed INSERT none of its rows are stored (also after a
 * reopen), while earlier statements of the same input stay committed.
 */
void stmt_result_free(StmtResult *result);
void result_free(Result *result);
void result_print_text(const Result *result, FILE *file);
/* JSON body for POST /query (design 2.10). *out is malloc'd, NUL-terminated;
 * the caller frees it. 0 = ok, -1 = out of memory. */
int result_to_json(const Result *result, int worker_id, char **out, size_t *len);
/* 200 when ok, 400 for a SQL error, 500 for an internal error. */
int result_http_status(const Result *result);

#endif
