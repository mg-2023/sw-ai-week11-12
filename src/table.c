#include "table.h"
#include "os.h"

#include <inttypes.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define HEADER_SIZE 12u
#define MAX_RECORD (1024u * 1024u)
#define MAX_TEXT (64u * 1024u)

struct Table {
    pthread_rwlock_t lock;
    OsFile *file;
    TableSchema schema;
    int64_t next_id; /* 0 means the int64 id space is exhausted. */
    uint64_t row_count;
    uint64_t written;
    int write_failed;
    int sync_always;
    BPTree *index;
};

static void clear_error(DbError *err) {
    if (err) *err = (DbError){0};
}

static int fail(DbError *err, uint64_t off, const char *message) {
    if (err) {
        *err = (DbError){.kind = DB_ERROR_INTERNAL};
        snprintf(err->message, sizeof err->message, "%s at offset %" PRIu64, message, off);
    }
    return -1;
}

static int sql_fail(DbError *err, uint64_t off, const char *message) {
    fail(err, off, message);
    if (err) err->kind = DB_ERROR_SQL;
    return -1;
}

static uint32_t get_u32(const unsigned char *p) {
    return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

static void put_u32(unsigned char *p, uint32_t value) {
    for (unsigned i = 0; i < 4; i++) p[i] = (unsigned char)(value >> (i * 8));
}

static int64_t get_i64(const unsigned char *p) {
    uint64_t value = 0;
    for (unsigned i = 0; i < 8; i++) value |= (uint64_t)p[i] << (i * 8);
    /* Avoid implementation-defined conversion of out-of-range unsigned values. */
    return value <= INT64_MAX ? (int64_t)value : -1 - (int64_t)(UINT64_MAX - value);
}

static void put_i64(unsigned char *p, int64_t value) {
    for (unsigned i = 0; i < 8; i++) p[i] = (unsigned char)((uint64_t)value >> (i * 8));
}

static uint32_t crc32(const unsigned char *p, size_t n) {
    uint32_t crc = UINT32_MAX;
    for (size_t i = 0; i < n; i++) {
        crc ^= p[i];
        for (int bit = 0; bit < 8; bit++) crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1u)));
    }
    return ~crc;
}

static uint32_t length_check(const unsigned char *encoded_length) {
    return crc32(encoded_length, 4) ^ 0x4D444231u;
}

void row_free(Row *row) {
    if (!row) return;
    for (int i = 0; i < row->n; i++) {
        if (row->fields[i].type == TYPE_TEXT) free(row->fields[i].s);
    }
    free(row->fields);
    *row = (Row){0};
}

/* Distinguish incomplete tail, corruption and operational failures. Only
 * incomplete/corrupt records may be removed, never a read/allocation failure. */
enum { RECORD_OK, RECORD_INCOMPLETE, RECORD_CORRUPT, RECORD_IO };

/* Per-call buffers. Rows passed to visitors borrow this workspace; read_at
 * still returns owned rows. TEXT remains NUL-terminated in both cases. */
typedef struct { Value fields[32]; unsigned char text[MAX_RECORD + 32]; } RowWorkspace;
typedef struct {
    Table *table;
    uint64_t size, base;
    size_t used;
    unsigned char data[MAX_RECORD];
    RowWorkspace row;
} BlockReader;

static int decode_row(const TableSchema *schema, const unsigned char *p, size_t n,
                      Row *out, uint64_t off, RowWorkspace *workspace, DbError *err) {
    if (n < 8) { fail(err, off, "invalid record fields"); return RECORD_CORRUPT; }
    Row row = {.n = schema->ncols, .id = get_i64(p)};
    if (row.id <= 0) {
        fail(err, off, "invalid record id");
        return RECORD_CORRUPT;
    }
    row.fields = workspace ? workspace->fields : calloc((size_t)row.n, sizeof *row.fields);
    if (!row.fields) { fail(err, off, "out of memory"); return RECORD_IO; }
    row.fields[0] = (Value){.type = TYPE_INT, .i = row.id};
    size_t pos = 8, text_used = 0;
    for (int i = 1; i < row.n; i++) {
        Value *v = &row.fields[i];
        v->type = schema->cols[i].type;
        if (v->type == TYPE_INT) {
            if (n - pos < 8) goto corrupt;
            v->i = get_i64(p + pos);
            pos += 8;
        } else {
            if (n - pos < 4) goto corrupt;
            v->len = get_u32(p + pos); pos += 4;
            if (v->len > MAX_TEXT || v->len > n - pos) goto corrupt;
            v->s = workspace ? (char *)workspace->text + text_used : malloc((size_t)v->len + 1);
            if (!v->s) {
                row_free(&row); fail(err, off, "out of memory"); return RECORD_IO;
            }
            memcpy(v->s, p + pos, v->len);
            v->s[v->len] = '\0'; pos += v->len;
            text_used += (size_t)v->len + 1;
        }
    }
    if (pos != n) goto corrupt;
    *out = row;
    return RECORD_OK;
corrupt:
    if (!workspace) row_free(&row);
    fail(err, off, "invalid record fields");
    return RECORD_CORRUPT;
}

/* Preserve the unconsumed suffix when a header or record crosses a block.
 * Every refill uses a positional read, never a shared file cursor. */
static const unsigned char *block_bytes(BlockReader *r, uint64_t off, size_t n, DbError *err) {
    if (off >= r->base && off - r->base <= r->used &&
        n <= r->used - (size_t)(off - r->base)) return r->data + (size_t)(off - r->base);
    size_t keep = 0;
    if (off >= r->base && off - r->base < r->used) {
        keep = r->used - (size_t)(off - r->base);
        memmove(r->data, r->data + (size_t)(off - r->base), keep);
    }
    r->base = off; r->used = keep;
    size_t wanted = r->size - off < MAX_RECORD ? (size_t)(r->size - off) : MAX_RECORD;
    while (r->used < wanted) {
        int64_t got = os_read_at(r->table->file, r->data + r->used, wanted - r->used, off + r->used);
        if (got <= 0) { fail(err, off, "cannot read table block"); return NULL; }
        r->used += (size_t)got;
    }
    if (r->used < n) { fail(err, off, "cannot read table block"); return NULL; }
    return r->data;
}

static int all_zero(const unsigned char *p, size_t n) {
    for (size_t i = 0; i < n; i++) if (p[i]) return 0;
    return 1;
}

static int zero_tail(BlockReader *r, uint64_t off, DbError *err) {
    while (off < r->size) {
        size_t n = r->size - off < MAX_RECORD ? (size_t)(r->size - off) : MAX_RECORD;
        const unsigned char *p = block_bytes(r, off, n, err);
        if (!p) return -1;
        if (!all_zero(p, n)) return 0;
        off += n;
    }
    return 1;
}

/* Framing and both checksums suffice: an out-of-order id or different schema
 * still means corruption that must require explicit repair. */
static int contains_complete_record(const unsigned char *tail, size_t n) {
    for (size_t pos = 1; n - pos >= HEADER_SIZE; pos++) {
        const unsigned char *header = tail + pos;
        uint32_t len = get_u32(header);
        if (!len || len > MAX_RECORD - HEADER_SIZE ||
            len > n - pos - HEADER_SIZE ||
            get_u32(header + 4) != length_check(header)) continue;
        if (get_u32(header + 8) == crc32(header + HEADER_SIZE, len)) return 1;
    }
    return 0;
}

static int read_record(BlockReader *r, uint64_t off, Row *out, uint64_t *next,
                       DbError *err) {
    if (off > r->size || r->size - off < HEADER_SIZE) {
        fail(err, off, "incomplete record header"); return RECORD_INCOMPLETE;
    }
    const unsigned char *header = block_bytes(r, off, HEADER_SIZE, err);
    if (!header) return RECORD_IO;
    if (all_zero(header, HEADER_SIZE)) {
        int zeros = zero_tail(r, off, err);
        if (zeros < 0) return RECORD_IO;
        fail(err, off, zeros ? "incomplete zero-filled tail" : "invalid record length");
        return zeros ? RECORD_INCOMPLETE : RECORD_CORRUPT;
    }
    uint32_t len = get_u32(header), crc = get_u32(header + 8);
    if (get_u32(header + 4) != length_check(header) || len == 0 || len > MAX_RECORD - HEADER_SIZE) {
        fail(err, off, "invalid record length"); return RECORD_CORRUPT;
    }
    if (len > r->size - off - HEADER_SIZE) {
        /* remaining < HEADER_SIZE + len <= MAX_RECORD; the tail fits in the
         * existing block buffer. Operational read failures never repair. */
        size_t remaining = (size_t)(r->size - off);
        const unsigned char *tail = block_bytes(r, off, remaining, err);
        if (!tail) return RECORD_IO;
        if (contains_complete_record(tail, remaining)) {
            fail(err, off, "complete record inside incomplete payload"); return RECORD_CORRUPT;
        }
        fail(err, off, "incomplete record payload"); return RECORD_INCOMPLETE;
    }
    const unsigned char *record = block_bytes(r, off, HEADER_SIZE + len, err);
    if (!record) return RECORD_IO;
    const unsigned char *payload = record + HEADER_SIZE;
    if (crc32(payload, len) != crc) {
        fail(err, off, "record CRC mismatch"); return RECORD_CORRUPT;
    }
    int rc = decode_row(&r->table->schema, payload, len, out, off, &r->row, err);
    if (rc == RECORD_OK) *next = off + HEADER_SIZE + len;
    return rc;
}

static int valid_schema(const TableSchema *s) {
    if (!s || s->ncols < 1 || s->ncols > 32 ||
        !memchr(s->name, '\0', sizeof s->name) || !s->name[0] ||
        strcmp(s->cols[0].name, "id") != 0 || s->cols[0].type != TYPE_INT) return 0;
    /* Catalog names are identifiers; reject path separators even for direct callers. */
    for (size_t i = 0; s->name[i]; i++) {
        unsigned char c = (unsigned char)s->name[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' ||
              (i && c >= '0' && c <= '9'))) return 0;
    }
    for (int i = 0; i < s->ncols; i++) {
        if (s->cols[i].type != TYPE_INT && s->cols[i].type != TYPE_TEXT) return 0;
    }
    return 1;
}

Table *table_open(const char *dir, const TableSchema *schema, int repair, DbError *err) {
    return table_open_with_visitor(dir, schema, repair, NULL, NULL, err);
}

Table *table_open_with_visitor(const char *dir, const TableSchema *schema, int repair,
                               TableOpenVisitor visitor, void *ctx, DbError *err) {
    clear_error(err);
    BlockReader *reader = NULL;
    if (!dir || !valid_schema(schema)) { fail(err, 0, "invalid table path or schema"); return NULL; }
    size_t dir_len = strlen(dir);
    if (dir_len > SIZE_MAX - sizeof schema->name - 6) {
        fail(err, 0, "table path too long"); return NULL;
    }
    size_t path_len = dir_len + strlen(schema->name) + 6;
    char *path = malloc(path_len);
    Table *t = calloc(1, sizeof *t);
    if (!path || !t) { free(path); free(t); fail(err, 0, "out of memory"); return NULL; }
    if (pthread_rwlock_init(&t->lock, NULL) != 0) {
        free(path); free(t); fail(err, 0, "cannot initialize table lock"); return NULL;
    }
    snprintf(path, path_len, "%s/%s.tbl", dir, schema->name);
    t->file = os_open(path, 1); free(path);
    if (!t->file) { fail(err, 0, "cannot open table file"); goto bad; }
    t->schema = *schema; t->next_id = 1; t->sync_always = 1;
    uint64_t size = os_size(t->file), off = 0;
    int64_t last_id = 0;
    if (size == UINT64_MAX) { fail(err, 0, "cannot get table size"); goto bad; }
    if (size) {
        reader = calloc(1, sizeof *reader);
        if (!reader) { fail(err, 0, "out of memory"); goto bad; }
        reader->table = t; reader->size = size;
    }
    while (off < size) {
        Row row = {0}; uint64_t next = 0;
        int rc = read_record(reader, off, &row, &next, err);
        if (rc == RECORD_OK && row.id <= last_id) {
            fail(err, off, "record ids are not increasing"); rc = RECORD_CORRUPT;
        }
        if (rc != RECORD_OK) {
            if (rc != RECORD_INCOMPLETE && !(repair && rc == RECORD_CORRUPT)) goto bad;
            if (os_truncate(t->file, off) || os_sync(t->file)) {
                fail(err, off, "cannot truncate/sync recovered table"); goto bad;
            }
            if (rc == RECORD_INCOMPLETE) {
                fprintf(stderr, "%" PRIu64 " bytes of incomplete tail truncated at offset %" PRIu64 "\n", size - off, off);
            }
            break;
        }
        if (visitor && visitor(row.id, off, ctx)) {
            fail(err, off, "table open visitor failed"); goto bad;
        }
        last_id = row.id; t->row_count++; off = next;
    }
    free(reader);
    t->next_id = last_id == INT64_MAX ? 0 : last_id + 1;
    clear_error(err);
    return t;
bad:
    free(reader);
    table_close(t);
    return NULL;
}

static int rollback(Table *t, uint64_t off, DbError *err, const char *message) {
    if (os_truncate(t->file, off) || os_sync(t->file)) {
        t->write_failed = 1;
        return fail(err, off, "append rollback failed; close and reopen table");
    }
    return fail(err, off, message);
}

int table_append(Table *t, const Value *fields, int64_t *id_out, uint64_t *off_out, DbError *err) {
    clear_error(err);
    if (!t || (t->schema.ncols > 1 && !fields)) return fail(err, 0, "missing table or fields");
    uint64_t off = os_size(t->file);
    if (off == UINT64_MAX) return fail(err, 0, "cannot get table size");
    if (t->write_failed) return fail(err, off, "table needs reopening after rollback failure");
    if (!t->next_id) return sql_fail(err, off, "id space exhausted");
    size_t len = 8;
    for (int i = 1; i < t->schema.ncols; i++) {
        const Value *v = &fields[i - 1];
        if (v->type != t->schema.cols[i].type) return sql_fail(err, off, "field type mismatch");
        if (v->type == TYPE_TEXT && (v->len > MAX_TEXT || (v->len && !v->s))) {
            return sql_fail(err, off, "invalid TEXT (maximum 64 KiB)");
        }
        size_t field_len = v->type == TYPE_INT ? 8 : 4 + (size_t)v->len;
        if (field_len > MAX_RECORD - HEADER_SIZE - len) return sql_fail(err, off, "record exceeds 1 MiB");
        len += field_len;
    }
    if (off > UINT64_MAX - HEADER_SIZE - len) return fail(err, off, "table size overflow");
    unsigned char *record = malloc(HEADER_SIZE + len);
    if (!record) return fail(err, off, "out of memory");
    put_u32(record, (uint32_t)len);
    put_u32(record + 4, length_check(record));
    put_i64(record + HEADER_SIZE, t->next_id);
    size_t pos = HEADER_SIZE + 8;
    for (int i = 1; i < t->schema.ncols; i++) {
        const Value *v = &fields[i - 1];
        if (v->type == TYPE_INT) { put_i64(record + pos, v->i); pos += 8; }
        else {
            put_u32(record + pos, v->len); pos += 4;
            if (v->len) memcpy(record + pos, v->s, v->len);
            pos += v->len;
        }
    }
    put_u32(record + 8, crc32(record + HEADER_SIZE, len));
    /* Reserve every possible split before touching the file. The write lock
     * keeps the key/path unchanged until the allocation-free registration. */
    if (t->index && bpt_reserve_insert(t->index, t->next_id)) {
        free(record);
        return fail(err, off, "cannot reserve index memory");
    }
    int rc = os_append(t->file, record, HEADER_SIZE + len, NULL);
    free(record);
    if (rc) return rollback(t, off, err, "cannot append record");
    if (t->sync_always && os_sync(t->file)) return rollback(t, off, err, "cannot sync record");
    if (t->index && bpt_insert(t->index, t->next_id, off)) {
        return rollback(t, off, err, "cannot register record in index");
    }
    if (id_out) *id_out = t->next_id;
    if (off_out) *off_out = off;
    t->row_count++; t->written++;
    t->next_id = t->next_id == INT64_MAX ? 0 : t->next_id + 1;
    return 0;
}

int table_read_at(Table *t, uint64_t off, Row *out, DbError *err) {
    clear_error(err);
    if (!out) return fail(err, off, "missing row output");
    *out = (Row){0};
    if (!t) return fail(err, off, "missing table");
    uint64_t size = os_size(t->file);
    if (size == UINT64_MAX) return fail(err, off, "cannot get table size");
    /* A point read needs only this record, not a full scan workspace. It never
     * repairs the file; incomplete and corrupt inputs both return an error. */
    unsigned char header[HEADER_SIZE];
    if (off > size || size - off < HEADER_SIZE) return fail(err, off, "incomplete record header");
    if (os_read_at(t->file, header, HEADER_SIZE, off) != HEADER_SIZE) return fail(err, off, "cannot read record header");
    uint32_t len = get_u32(header);
    if (get_u32(header + 4) != length_check(header) || !len || len > MAX_RECORD - HEADER_SIZE) return fail(err, off, "invalid record length");
    if (len > size - off - HEADER_SIZE) return fail(err, off, "incomplete record payload");
    unsigned char *payload = malloc(len);
    if (!payload) return fail(err, off, "out of memory");
    int rc;
    if (os_read_at(t->file, payload, len, off + HEADER_SIZE) != len) rc = fail(err, off, "cannot read record payload");
    else if (crc32(payload, len) != get_u32(header + 8)) rc = fail(err, off, "record CRC mismatch");
    else rc = decode_row(&t->schema, payload, len, out, off, NULL, err);
    free(payload);
    return rc == RECORD_OK ? 0 : -1;
}

int table_scan(Table *t, RowVisitor visitor, void *ctx, DbError *err) {
    clear_error(err);
    if (!t || !visitor) return fail(err, 0, "missing table or visitor");
    uint64_t size = os_size(t->file), off = 0;
    if (size == UINT64_MAX) return fail(err, 0, "cannot get table size");
    if (!size) return 0;
    BlockReader *reader = calloc(1, sizeof *reader);
    if (!reader) return fail(err, 0, "out of memory");
    reader->table = t; reader->size = size;
    int rc = 0;
    while (off < size) {
        Row row = {0}; uint64_t next;
        if (read_record(reader, off, &row, &next, err) != RECORD_OK) { rc = -1; break; }
        int stop = visitor(&row, off, ctx);
        if (stop) break;
        off = next;
    }
    free(reader);
    return rc;
}

void table_close(Table *t) {
    if (!t) return;
    bpt_free(t->index);
    os_close(t->file);
    pthread_rwlock_destroy(&t->lock);
    free(t);
}

int table_read_lock(Table *t) { return pthread_rwlock_rdlock(&t->lock); }
int table_write_lock(Table *t) { return pthread_rwlock_wrlock(&t->lock); }
int table_unlock(Table *t) { return pthread_rwlock_unlock(&t->lock); }
void table_set_sync(Table *t, int sync_always) { t->sync_always = sync_always != 0; }
uint64_t table_rows_written(const Table *t) { return t->written; }
void table_set_index(Table *t, BPTree *index) { bpt_free(t->index); t->index = index; }
const BPTree *table_index(const Table *t) { return t->index; }
