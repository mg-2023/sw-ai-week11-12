#ifndef MINI_DBMS_TABLE_H
#define MINI_DBMS_TABLE_H

#include "catalog.h"
#include "bptree.h"

typedef struct Table Table;
typedef struct { Value *fields; int n; int64_t id; } Row;
typedef int (*RowVisitor)(const Row *row, uint64_t off, void *ctx);
typedef int (*TableOpenVisitor)(int64_t id, uint64_t off, void *ctx);

/* The schema is copied. The directory must already exist.
 * Records: LE u32 payload length, LE u32 (CRC32/IEEE of its four LE bytes
 * XOR 0x4D444231), LE u32 payload CRC32/IEEE, id, fields.
 * Length excludes the 12-byte header; the entire record is at most 1 MiB.
 * TEXT is LE u32 byte length plus bytes (at most 64 KiB), INT is LE i64.
 * CRC covers the payload, including id. No string terminator is stored.
 * Open truncates incomplete tails; other corruption needs repair != 0.
 * Errors include the file offset; line/col are zero (not SQL positions).
 * All successful operations clear err. No internal locking: the caller
 * must serialize writes and exclude them during reads/scans/close.
 * Append synchronizes before publishing outputs/id unless sync is disabled
 * with table_set_sync (default sync always).
 * Failed append rolls back; failed rollback disables further appends.
 * Read uses only os_read_at and returns owned fields, with fields[0] = id.
 * Use an empty Row output. Free it with row_free, even after failure.
 * A visitor borrows its Row until return; nonzero stops a successful scan.
 */
Table *table_open(const char *dir, const TableSchema *schema, int repair, DbError *err);
/* Called for each validated row in file order. Nonzero fails open without
 * repair/truncation; the caller owns callback state, including failure cleanup.
 * The callback may have received a valid prefix before a later record fails.
 */
Table *table_open_with_visitor(const char *dir, const TableSchema *schema, int repair,
                               TableOpenVisitor visitor, void *ctx, DbError *err);
int table_append(Table *table, const Value *fields_without_id, int64_t *id_out,
                 uint64_t *off_out, DbError *err);
/* Statement-atomic append of nrows rows (row-major, ncols - 1 fields each).
 * Reserves index nodes, writes every record, syncs once (sync always), then
 * registers all rows and publishes ids_out[0..nrows). Any failure truncates back
 * to the confirmed end, so no row of the statement remains. Same locking rule
 * as table_append. Rollback failure disables further appends until reopen.
 */
int table_append_rows(Table *table, const Value *rows, size_t nrows,
                      int64_t *ids_out, DbError *err);
int table_read_at(Table *table, uint64_t off, Row *out, DbError *err);
int table_scan(Table *table, RowVisitor visitor, void *ctx, DbError *err);
void row_free(Row *row);
void table_close(Table *table);

/* Executor lock access without exposing Table's representation. Set the sync
 * policy before publishing the table to callers; table_open defaults to always.
 */
int table_read_lock(Table *table);
int table_write_lock(Table *table);
int table_unlock(Table *table);
void table_set_sync(Table *table, int sync_always);
uint64_t table_rows_written(const Table *table);
/* Rows in the confirmed file (counted at open, grown by appends). */
uint64_t table_row_count(const Table *table);

/* db_open attaches the index built from its open callback before publication.
 * Transfers ownership to Table. Storage-only callers may leave it unattached.
 * Index access and append share the caller's table read/write lock.
 */
void table_set_index(Table *table, BPTree *index);
const BPTree *table_index(const Table *table);

#ifdef MINI_DBMS_TESTING
/* Largest buffer written per os_append call (default 1 MiB); 1 = one record each. */
void table_test_set_write_chunk(size_t bytes);
#endif

#endif
