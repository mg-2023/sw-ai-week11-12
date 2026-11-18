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
 * Meta records share the header; their id is 0 and the body is [u8 kind][i64 value]:
 * kind 3 FORMAT (value 3, first record), kind 1 COMMIT (rows written by the statement before it), kind 2 ID_FLOOR (ids up to
 * the value are never reused). Every INSERT statement is rows + COMMIT; rows count only
 * once their COMMIT is intact. Meta records are never returned as rows.
 * Open truncates incomplete tails, including a final statement without its COMMIT
 * (the whole statement is removed); other corruption needs repair != 0. Repair writes an
 * durable .idfloor sidecar before truncation, then an ID_FLOOR record and removes
 * the sidecar. A remaining sidecar is validated and replayed before opening.
 * Errors include the file offset; line/col are zero (not SQL positions).
 * All successful operations clear err. No internal locking: the caller
 * must serialize writes and exclude them during reads/scans/close.
 * Append synchronizes before publishing outputs/id unless sync is disabled
 * with table_set_sync (default sync always).
 * Failed append rolls back; failed rollback disables further appends (the unconfirmed
 * bytes stay invisible, and a reopen removes the statement because it has no COMMIT).
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
 * Reserves index nodes, writes every record, syncs (sync always), writes the COMMIT
 * record, syncs again, then registers all rows and publishes ids_out[0..nrows). Any
 * failure truncates back to the confirmed end, so no row of the statement remains.
 * Same locking rule as table_append. Rollback failure disables further appends until reopen.
 */
/* Error message when the COMMIT record was written but the statement could be neither confirmed nor
 * cut back: a reopen decides whether its rows exist. Kind is DB_ERROR_INTERNAL. */
#define TABLE_OUTCOME_UNKNOWN "statement outcome unknown: commit record was written but could not be confirmed or rolled back; reopen the table to see whether the rows exist"
int table_append_rows(Table *table, const Value *rows, size_t nrows,
                      int64_t *ids_out, DbError *err);
int table_read_at(Table *table, uint64_t off, Row *out, DbError *err);
int table_scan(Table *table, RowVisitor visitor, void *ctx, DbError *err);
/* Same scan, but the caller must hold the table READ lock, which this function releases and
 * takes again about every 1 MiB so a waiting INSERT is not blocked for the whole scan. It
 * sees the rows committed when it started (a snapshot of the confirmed end). It returns with
 * the read lock held, except when it cannot re-take it: then *lock_lost = 1 and the caller
 * must not unlock. *lock_lost is 0 otherwise. */
#define SCAN_YIELD_BYTES (1024u * 1024u)
int table_scan_yielding(Table *table, RowVisitor visitor, void *ctx, DbError *err, int *lock_lost);
int table_scan_deadline(Table *table, RowVisitor visitor, void *ctx, DbError *err, int *lock_lost, uint64_t deadline_us);
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
/* Write-lock waits of INSERT statements: the last TABLE_WAIT_SAMPLES in us (copied
 * into out, which must hold that many), the largest ever, and how many waits were
 * ever recorded. Safe from any thread and never takes the table lock. */
#define TABLE_WAIT_SAMPLES 8192u
size_t table_write_wait_samples(Table *table, uint32_t *out, uint64_t *max, uint64_t *total);
/* Nearest-rank 99th percentile of samples[0..n); sorts them in place. 0 when n == 0. */
uint64_t wait_p99(uint32_t *samples, size_t n);
/* Rows in the confirmed file (counted at open, grown by appends). Atomic: needs no table lock. */
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
