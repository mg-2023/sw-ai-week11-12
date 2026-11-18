#ifndef MINI_DBMS_EXECUTOR_H
#define MINI_DBMS_EXECUTOR_H

#include "result.h"
#include "table.h"

/* Acquires one table lock and copies the complete result before releasing it.
 * schema must describe table; statement must come from parse_sql.
 * out is empty on entry and freed/cleared on failure.
 */
int executor_execute(Table *table, const TableSchema *schema, const Statement *statement,
                     StmtResult *out, DbError *err);

#endif
