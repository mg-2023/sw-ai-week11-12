#ifndef MINI_DBMS_DB_H
#define MINI_DBMS_DB_H

#include "result.h"

typedef struct { int sync_always; int repair; } DbOptions;
typedef struct Db Db;

/* Directory and catalog.txt must exist. Owns the process's os directory lock;
 * the current OS layer permits one open Db per process. Close after all calls
 * finish. Options are explicit: sync_always != 0 synchronizes each append.
 */
Db *db_open(const char *dir, DbOptions options, DbError *err);
void db_close(Db *db);
/* Successful appends during this open session, including partial INSERTs.
 * Call after execution has stopped (used by the CLI durability warning). */
uint64_t db_rows_written(const Db *db);
/* Rows currently stored in a table, or UINT64_MAX for an unknown table name. */
uint64_t db_table_row_count(const Db *db, const char *table);
/* Use an empty output. Statements execute in order, including when a later
 * statement cannot be parsed. Errors carry original SQL line/byte-column.
 * Concurrent calls may share Db, but must use separate Result objects.
 */
int db_execute_sql(Db *db, const char *sql, Result *out);

#endif
