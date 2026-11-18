#ifndef MINI_DBMS_EXECUTOR_H
#define MINI_DBMS_EXECUTOR_H

#include "result.h"
#include "table.h"

/* A SELECT result may use at most this many bytes (cells at sizeof(Value) plus TEXT
 * bytes). Beyond it the statement fails with a SQL error so one request cannot
 * exhaust memory; the CLI and the server share the rule. */
#define EXECUTOR_MAX_RESULT_BYTES ((size_t)16 * 1024 * 1024)
#ifdef MINI_DBMS_TESTING
void executor_test_set_result_limit(size_t bytes);
#endif

/* Acquires one table lock and copies the complete result before releasing it.
 * schema must describe table; statement must come from parse_sql.
 * out is empty on entry and freed/cleared on failure.
 */
int executor_execute(Table *table, const TableSchema *schema, const Statement *statement,
                     StmtResult *out, DbError *err);

#endif
