#ifndef MINI_DBMS_EXECUTOR_H
#define MINI_DBMS_EXECUTOR_H

#include "result.h"
#include "table.h"

/* One request's aggregate retained results: cells, TEXT, names, statement
 * metadata and inserted ids. The shared remaining budget is charged before
 * copying results or starting an INSERT. CLI and server share the rule. */
#define EXECUTOR_MAX_RESULT_BYTES ((size_t)16 * 1024 * 1024)
size_t executor_result_limit(void);
#ifdef MINI_DBMS_TESTING
void executor_test_set_result_limit(size_t bytes);
#endif

/* Acquires one table lock and copies the complete result before releasing it.
 * schema must describe table; statement must come from parse_sql.
 * out is empty on entry and freed/cleared on failure.
 */
int executor_execute(Table *table, const TableSchema *schema, const Statement *statement,
                     StmtResult *out, DbError *err, uint64_t deadline_us, size_t *remaining);

#endif
