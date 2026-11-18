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
 * statements. No transaction: an I/O error within a multi-row INSERT may leave
 * earlier rows stored; the error message states that count.
 */
void stmt_result_free(StmtResult *result);
void result_free(Result *result);
void result_print_text(const Result *result, FILE *file);

#endif
