#ifndef MINI_DBMS_TABLE_H
#define MINI_DBMS_TABLE_H

#include "catalog.h"

typedef struct Table Table;
typedef struct { Value *fields; int n; int64_t id; } Row;
typedef int (*RowVisitor)(const Row *row, uint64_t off, void *ctx);

/* The schema is copied. The directory must already exist.
 * Records: LE u32 payload length, LE u32 CRC32/IEEE, LE i64 id, fields.
 * Length excludes the 8-byte header; the entire record is at most 1 MiB.
 * TEXT is LE u32 byte length plus bytes (at most 64 KiB), INT is LE i64.
 * CRC covers the payload, including id. No string terminator is stored.
 * Open truncates incomplete tails; other corruption needs repair != 0.
 * Errors include the file offset; line/col are zero (not SQL positions).
 * All successful operations clear err. No internal locking: the caller
 * must serialize writes and exclude them during reads/scans/close.
 * Append synchronizes before publishing outputs/id (default sync always).
 * Failed append rolls back; failed rollback disables further appends.
 * Read uses only os_read_at and returns owned fields, with fields[0] = id.
 * Use an empty Row output. Free it with row_free, even after failure.
 * A visitor borrows its Row until return; nonzero stops a successful scan.
 */
Table *table_open(const char *dir, const TableSchema *schema, int repair, DbError *err);
int table_append(Table *table, const Value *fields_without_id, int64_t *id_out,
                 uint64_t *off_out, DbError *err);
int table_read_at(Table *table, uint64_t off, Row *out, DbError *err);
int table_scan(Table *table, RowVisitor visitor, void *ctx, DbError *err);
void row_free(Row *row);
void table_close(Table *table);

#endif
