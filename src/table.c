#include "table.h"
#include "os.h"

#include <inttypes.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define HEADER_SIZE 12u
#define MAX_RECORD (1024u * 1024u)
#define MAX_TEXT (64u * 1024u)
/* Meta record: normal header, id 0, then [u8 kind][i64 value] (17 payload bytes). */
#define META_PAYLOAD 17u
#define META_SIZE (HEADER_SIZE + META_PAYLOAD)
enum { META_COMMIT = 1, META_ID_FLOOR = 2 };
typedef struct { int kind; int64_t value; } Meta;

/* Recent INSERT lock-wait times (us), guarded by their own mutex so /stats never touches the table lock. */
typedef struct {
    pthread_mutex_t mutex;
    uint32_t samples[TABLE_WAIT_SAMPLES];
    size_t next, count;
    uint64_t max, total;
} WaitStats;

struct Table {
    pthread_rwlock_t lock;
    WaitStats wait;
    OsFile *file;
    TableSchema schema;
    /* Confirmed end: bytes before it belong to committed rows. Scans and point
     * reads stop here, so unconfirmed bytes left by a failed rollback stay invisible. */
    uint64_t end;
    int64_t next_id; /* 0 means the int64 id space is exhausted. */
    _Atomic uint64_t row_count; /* written under the write lock, read lock-free by /stats */
    _Atomic uint64_t written;
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
enum { RECORD_OK, RECORD_INCOMPLETE, RECORD_CORRUPT, RECORD_IO, RECORD_META };

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

/* A CRC-valid record whose id is 0 must be a well-formed meta record. */
static int decode_meta(const unsigned char *p, size_t n, Meta *meta, uint64_t off, DbError *err) {
    int64_t value = n == META_PAYLOAD ? get_i64(p + 9) : -1;
    if (n != META_PAYLOAD || value <= 0 || (p[8] != META_COMMIT && p[8] != META_ID_FLOOR)) {
        fail(err, off, "invalid meta record"); return RECORD_CORRUPT;
    }
    *meta = (Meta){.kind = p[8], .value = value};
    return RECORD_META;
}

/* Returns RECORD_OK (row in *out) or RECORD_META (*meta); other codes are incomplete/corrupt/IO. */
static int read_record(BlockReader *r, uint64_t off, Row *out, Meta *meta, uint64_t *next,
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
    int rc = len >= 8 && get_i64(payload) == 0 ? decode_meta(payload, len, meta, off, err)
                                                : decode_row(&r->table->schema, payload, len, out, off, &r->row, err);
    if (rc == RECORD_OK || rc == RECORD_META) *next = off + HEADER_SIZE + len;
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

/* What the cut range still shows: intact records, and the highest id that must never be reused. */
typedef struct { uint64_t records; int64_t min_id, max_id, id_floor; } CutInfo;

/* Copy bytes [from, size) to `backup`, then sync it. The copy is removed on failure. */
static int copy_cut_range(Table *t, const char *backup, uint64_t from, uint64_t size, DbError *err) {
    OsFile *out = os_open(backup, 1);
    unsigned char *buf = malloc(MAX_RECORD);
    int ok = out && buf;
    for (uint64_t pos = from; ok && pos < size;) {
        size_t n = size - pos < MAX_RECORD ? (size_t)(size - pos) : MAX_RECORD;
        ok = os_read_at(t->file, buf, n, pos) == (int64_t)n && os_append(out, buf, n, NULL) == 0;
        pos += n;
    }
    if (ok) ok = os_sync(out) == 0;
    free(buf);
    if (out) os_close(out);
    if (!ok) { remove(backup); return fail(err, from, "cannot back up table bytes before repair"); }
    return 0;
}

/* Find every record in [from, size) whose length check and payload CRC are intact.
 * Row ids, ID_FLOOR values and the last id a COMMIT implies (statement start id + rows - 1)
 * all raise id_floor. settled_id is the last id committed before `from`. */
static int scan_cut_range(Table *t, uint64_t from, uint64_t size, int64_t settled_id, CutInfo *info, DbError *err) {
    int64_t next_start = settled_id + 1, first_row = 0; /* start id of the statement being read */
    enum { WINDOW = 2 * MAX_RECORD };
    unsigned char *buf = malloc(WINDOW);
    if (!buf) return fail(err, from, "out of memory");
    for (uint64_t pos = from; pos < size;) {
        size_t n = size - pos < WINDOW ? (size_t)(size - pos) : WINDOW;
        int last = pos + n == size;
        if (os_read_at(t->file, buf, n, pos) != (int64_t)n) { free(buf); return fail(err, pos, "cannot read cut range"); }
        size_t limit = last ? n : n - MAX_RECORD, p = 0; /* Inside limit every record fits the window. */
        while (p + HEADER_SIZE <= (last ? n : limit)) {
            const unsigned char *h = buf + p;
            uint32_t len = get_u32(h);
            if (len >= 8 && len <= MAX_RECORD - HEADER_SIZE && len <= n - p - HEADER_SIZE &&
                get_u32(h + 4) == length_check(h) && get_u32(h + 8) == crc32(h + HEADER_SIZE, len)) {
                int64_t id = get_i64(h + HEADER_SIZE);
                if (id > 0) {
                    if (!info->records || id < info->min_id) info->min_id = id;
                    if (!info->records || id > info->max_id) info->max_id = id;
                    info->records++;
                    if (id > info->id_floor) info->id_floor = id;
                    if (!first_row) first_row = id;
                } else if (id == 0 && len == META_PAYLOAD && h[HEADER_SIZE + 8] == META_ID_FLOOR) {
                    int64_t value = get_i64(h + HEADER_SIZE + 9);
                    if (value > info->id_floor) info->id_floor = value;
                    if (value > 0 && value < INT64_MAX) next_start = value + 1;
                    first_row = 0;
                } else if (id == 0 && len == META_PAYLOAD && h[HEADER_SIZE + 8] == META_COMMIT) {
                    int64_t count = get_i64(h + HEADER_SIZE + 9), base = first_row ? first_row : next_start;
                    if (count > 0 && base > 0 && count <= INT64_MAX - base) {
                        int64_t last = base + count - 1;
                        if (last > info->id_floor) info->id_floor = last;
                        if (last < INT64_MAX) next_start = last + 1;
                    }
                    first_row = 0;
                }
                p += HEADER_SIZE + len;
            } else p++;
        }
        pos += p ? p : n;
    }
    free(buf);
    return 0;
}

/* The corrupt record itself may still have an intact header. Ids grow by 1, so its id column counts
 * only if it equals kept_id + 1, where kept_id is the last id read before it, pending rows included
 * (the one id it can have had); any other value is garbage. */
static void note_corrupt_record_id(Table *t, uint64_t off, uint64_t size, int64_t kept_id, CutInfo *info) {
    unsigned char h[HEADER_SIZE + 8];
    if (size - off < sizeof h || os_read_at(t->file, h, sizeof h, off) != (int64_t)sizeof h) return;
    if (get_u32(h + 4) != length_check(h)) return;
    int64_t id = get_i64(h + HEADER_SIZE);
    if (kept_id < INT64_MAX && id == kept_id + 1 && id > info->id_floor) info->id_floor = id;
}

/* Back up the bytes repair is about to cut, then report them. Name: <table>.tbl.repair-YYYYMMDD-HHMMSS.
 * The cut starts at `off`; the corrupt record that triggered it starts at `bad_off` (>= off). */
static int back_up_before_repair(Table *t, const char *dir, uint64_t off, uint64_t bad_off, uint64_t size,
                                 int64_t settled_id, int64_t kept_id, CutInfo *info, DbError *err) {
    char stamp[32], backup[4096];
    time_t now = time(NULL); struct tm *tm = localtime(&now);
    if (!tm || !strftime(stamp, sizeof stamp, "%Y%m%d-%H%M%S", tm)) return fail(err, off, "cannot name repair backup");
    for (int attempt = 1; attempt <= 100; attempt++) {
        int n = attempt == 1 ? snprintf(backup, sizeof backup, "%s/%s.tbl.repair-%s", dir, t->schema.name, stamp)
                             : snprintf(backup, sizeof backup, "%s/%s.tbl.repair-%s-%d", dir, t->schema.name, stamp, attempt);
        if (n < 0 || (size_t)n >= sizeof backup) return fail(err, off, "repair backup path too long");
        OsFile *existing = os_open(backup, 0);
        if (!existing) break; /* Unused name. */
        os_close(existing);
        if (attempt == 100) return fail(err, off, "cannot choose repair backup name");
    }
    if (copy_cut_range(t, backup, off, size, err) || scan_cut_range(t, off, size, settled_id, info, err)) return -1;
    note_corrupt_record_id(t, bad_off, size, kept_id, info);
    fprintf(stderr, "repair: cut %" PRIu64 " bytes at offset %" PRIu64 ", backup %s, %" PRIu64 " intact records in the cut bytes",
            size - off, off, backup, info->records);
    if (info->records) fprintf(stderr, ", ids %" PRId64 "..%" PRId64, info->min_id, info->max_id);
    fputc('\n', stderr);
    return 0;
}

/* Fill out[META_SIZE] with a meta record. */
static void encode_meta(unsigned char *out, int kind, int64_t value) {
    memset(out, 0, META_SIZE);
    put_u32(out, META_PAYLOAD);
    put_u32(out + 4, length_check(out));
    out[HEADER_SIZE + 8] = (unsigned char)kind;
    put_i64(out + HEADER_SIZE + 9, value);
    put_u32(out + 8, crc32(out + HEADER_SIZE, META_PAYLOAD));
}

/* Append one meta record at the end of the file. */
static int append_meta(Table *t, int kind, int64_t value) {
    unsigned char record[META_SIZE];
    encode_meta(record, kind, value);
    return os_append(t->file, record, sizeof record, NULL);
}

Table *table_open(const char *dir, const TableSchema *schema, int repair, DbError *err) {
    return table_open_with_visitor(dir, schema, repair, NULL, NULL, err);
}

/* Rows read since the last COMMIT; they count only when a matching COMMIT follows. */
typedef struct { int64_t id; uint64_t off; } PendingRow;
typedef struct { PendingRow *rows; size_t n, capacity; uint64_t start; } Pending;

static int pending_add(Pending *p, int64_t id, uint64_t off) {
    if (!p->n) p->start = off;
    if (p->n == p->capacity) {
        size_t next = p->capacity ? p->capacity * 2 : 64;
        PendingRow *rows = next > SIZE_MAX / sizeof *rows ? NULL : realloc(p->rows, next * sizeof *rows);
        if (!rows) return -1;
        p->rows = rows; p->capacity = next;
    }
    p->rows[p->n++] = (PendingRow){id, off};
    return 0;
}

Table *table_open_with_visitor(const char *dir, const TableSchema *schema, int repair,
                               TableOpenVisitor visitor, void *ctx, DbError *err) {
    clear_error(err);
    BlockReader *reader = NULL;
    Pending pending = {0};
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
    if (pthread_mutex_init(&t->wait.mutex, NULL) != 0) {
        pthread_rwlock_destroy(&t->lock);
        free(path); free(t); fail(err, 0, "cannot initialize table lock"); return NULL;
    }
    snprintf(path, path_len, "%s/%s.tbl", dir, schema->name);
    t->file = os_open(path, 1); free(path);
    if (!t->file) { fail(err, 0, "cannot open table file"); goto bad; }
    t->schema = *schema; t->next_id = 1; t->sync_always = 1;
    uint64_t size = os_size(t->file), off = 0;
    /* last_id: highest id read (pending included, for ordering); settled_id: highest id that is
     * committed or reserved by an ID_FLOOR. next_id starts one above settled_id. */
    int64_t last_id = 0, settled_id = 0;
    CutInfo cut = {0};
    if (size == UINT64_MAX) { fail(err, 0, "cannot get table size"); goto bad; }
    if (size) {
        reader = calloc(1, sizeof *reader);
        if (!reader) { fail(err, 0, "out of memory"); goto bad; }
        reader->table = t; reader->size = size;
    }
    for (;;) {
        Row row = {0}; Meta meta = {0}; uint64_t next = 0; int rc;
        if (off >= size) {
            if (!pending.n) break;
            fail(err, off, "statement has no commit record"); rc = RECORD_INCOMPLETE;
        } else {
            rc = read_record(reader, off, &row, &meta, &next, err);
            if (rc == RECORD_OK && row.id <= last_id) {
                fail(err, off, "record ids are not increasing"); rc = RECORD_CORRUPT;
            } else if (rc == RECORD_META && meta.kind == META_COMMIT && meta.value != (int64_t)pending.n) {
                fail(err, off, "commit record does not match the rows before it"); rc = RECORD_CORRUPT;
            } else if (rc == RECORD_META && meta.kind == META_ID_FLOOR && pending.n) {
                fail(err, off, "id floor record inside an unfinished statement"); rc = RECORD_CORRUPT;
            }
        }
        if (rc == RECORD_OK) {
            if (pending_add(&pending, row.id, off)) { fail(err, off, "out of memory"); goto bad; }
            last_id = row.id; off = next;
            continue;
        }
        if (rc == RECORD_META) {
            if (meta.kind == META_COMMIT) {
                for (size_t i = 0; i < pending.n; i++) {
                    if (visitor && visitor(pending.rows[i].id, pending.rows[i].off, ctx)) {
                        fail(err, pending.rows[i].off, "table open visitor failed"); goto bad;
                    }
                }
                t->row_count += pending.n; settled_id = last_id; pending.n = 0;
            } else {
                if (meta.value > settled_id) settled_id = meta.value;
                if (meta.value > last_id) last_id = meta.value;
            }
            off = next;
            continue;
        }
        if (rc != RECORD_INCOMPLETE && !(repair && rc == RECORD_CORRUPT)) goto bad;
        /* An unfinished statement is cut whole, from its first row. Repair also keeps a copy and
         * never reuses the ids of the bytes it cuts. */
        uint64_t cut_at = pending.n ? pending.start : off;
        if (rc == RECORD_CORRUPT && back_up_before_repair(t, dir, cut_at, off, size, settled_id, last_id, &cut, err)) goto bad;
        if (os_truncate(t->file, cut_at) || os_sync(t->file)) {
            fail(err, cut_at, "cannot truncate/sync recovered table"); goto bad;
        }
        if (rc == RECORD_INCOMPLETE && pending.n) {
            fprintf(stderr, "incomplete statement: %zu records (%" PRIu64 " bytes) truncated at offset %" PRIu64 "\n",
                    pending.n, size - cut_at, cut_at);
        } else if (rc == RECORD_INCOMPLETE) {
            fprintf(stderr, "%" PRIu64 " bytes of incomplete tail truncated at offset %" PRIu64 "\n", size - off, off);
        }
        off = cut_at;
        if (rc == RECORD_CORRUPT && cut.id_floor > settled_id) {
            /* Leave the cut ids burned in the file itself, so a later session cannot reuse them. */
            if (append_meta(t, META_ID_FLOOR, cut.id_floor) || os_sync(t->file)) {
                fail(err, cut_at, "cannot write id floor after repair"); goto bad;
            }
            settled_id = cut.id_floor; off += META_SIZE;
        }
        break;
    }
    free(reader); free(pending.rows);
    t->end = off;
    t->next_id = settled_id == INT64_MAX ? 0 : settled_id + 1;
    clear_error(err);
    return t;
bad:
    free(reader); free(pending.rows);
    table_close(t);
    return NULL;
}

#ifdef MINI_DBMS_TESTING
#include <stdatomic.h>
static atomic_size_t write_chunk = MAX_RECORD;
void table_test_set_write_chunk(size_t bytes) { atomic_store(&write_chunk, bytes); }
#define WRITE_CHUNK atomic_load(&write_chunk)
#else
#define WRITE_CHUNK ((size_t)MAX_RECORD)
#endif

/* Cut the file back to the statement start; if that fails the table refuses appends.
 * With commit_written the COMMIT may already be in the file, so a failed cut leaves the outcome unknown. */
static int rollback(Table *t, uint64_t off, DbError *err, const char *message, int commit_written) {
    if (t->index) bpt_release_reserved(t->index);
    if (os_truncate(t->file, off) || os_sync(t->file)) {
        t->write_failed = 1;
        if (commit_written) {
            if (err) {
                *err = (DbError){.kind = DB_ERROR_INTERNAL};
                snprintf(err->message, sizeof err->message, "%s", TABLE_OUTCOME_UNKNOWN);
            }
            return -1;
        }
        return fail(err, off, "append rollback failed; close and reopen table");
    }
    return fail(err, off, message);
}

/* Validate one row and return its payload length (id and fields). */
static int payload_length(const Table *t, const Value *fields, uint64_t off, size_t *len_out, DbError *err) {
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
    *len_out = len;
    return 0;
}

/* Write header, id and fields of one row at record. */
static void encode_record(const Table *t, const Value *fields, int64_t id, size_t len, unsigned char *record) {
    put_u32(record, (uint32_t)len);
    put_u32(record + 4, length_check(record));
    put_i64(record + HEADER_SIZE, id);
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
}

int table_append_rows(Table *t, const Value *rows, size_t nrows, int64_t *ids_out, DbError *err) {
    clear_error(err);
    size_t width = t && t->schema.ncols > 1 ? (size_t)t->schema.ncols - 1 : 0;
    if (!t || !nrows || (width && !rows)) return fail(err, 0, "missing table or fields");
    uint64_t start = t->end;
    if (t->write_failed) return fail(err, start, "table needs reopening after rollback failure");
    if (!t->next_id || (uint64_t)(nrows - 1) > (uint64_t)(INT64_MAX - t->next_id)) {
        return sql_fail(err, start, "id space exhausted");
    }
    if (nrows > SIZE_MAX / sizeof(uint32_t)) return fail(err, start, "too many rows");
    /* Pass 1: validate every row before touching the index or the file. */
    uint32_t *sizes = malloc(nrows * sizeof *sizes);
    if (!sizes) return fail(err, start, "out of memory");
    uint64_t total = 0; size_t largest = 0;
    for (size_t r = 0; r < nrows; r++) {
        size_t len;
        if (payload_length(t, width ? rows + r * width : NULL, start, &len, err)) { free(sizes); return -1; }
        sizes[r] = (uint32_t)(HEADER_SIZE + len);
        if (sizes[r] > largest) largest = sizes[r];
        if (total > UINT64_MAX - sizes[r] - META_SIZE || start > UINT64_MAX - total - sizes[r] - META_SIZE) {
            free(sizes); return fail(err, start, "table size overflow");
        }
        total += sizes[r];
    }
    size_t chunk = WRITE_CHUNK, capacity = total < chunk ? (size_t)total : chunk;
    if (capacity < largest) capacity = largest;
    unsigned char *buf = malloc(capacity);
    if (!buf) { free(sizes); return fail(err, start, "out of memory"); }
    /* Reserve every possible index split first; the write lock keeps the keys unchanged. */
    if (t->index && bpt_reserve_insert_range(t->index, t->next_id, nrows)) {
        free(buf); free(sizes);
        return fail(err, start, "cannot reserve index memory");
    }
    int64_t id = t->next_id;
    size_t used = 0; int rc = 0;
    for (size_t r = 0; r < nrows && !rc; r++, id++) {
        if (used && used + sizes[r] > chunk) {
            rc = os_append(t->file, buf, used, NULL); used = 0;
            if (rc) break;
        }
        encode_record(t, width ? rows + r * width : NULL, id, sizes[r] - HEADER_SIZE, buf + used);
        used += sizes[r];
    }
    if (!rc && used) rc = os_append(t->file, buf, used, NULL);
    free(buf);
    if (rc) { free(sizes); return rollback(t, start, err, "cannot append record", 0); }
    if (t->sync_always && os_sync(t->file)) { free(sizes); return rollback(t, start, err, "cannot sync record", 0); }
    /* The COMMIT record makes the statement count: a reopen keeps the rows only if it is intact. */
    if (append_meta(t, META_COMMIT, (int64_t)nrows)) { free(sizes); return rollback(t, start, err, "cannot append commit record", 0); }
    if (t->sync_always && os_sync(t->file)) { free(sizes); return rollback(t, start, err, "cannot sync commit record", 1); }
    /* Registration uses only reserved nodes and should not fail. If it does, undo the file; the
     * index cannot drop entries it already took, so then the table stops accepting appends. */
    uint64_t off = start;
    for (size_t r = 0; r < nrows; r++) {
        int64_t row_id = t->next_id + (int64_t)r;
        if (t->index && bpt_insert_reserved(t->index, row_id, off)) {
            free(sizes);
            if (r) t->write_failed = 1;
            return rollback(t, start, err, "cannot register record in index; close and reopen table", 1);
        }
        if (ids_out) ids_out[r] = row_id;
        off += sizes[r];
    }
    free(sizes);
    if (t->index) bpt_release_reserved(t->index);
    t->end = start + total + META_SIZE;
    t->row_count += nrows; t->written += nrows;
    int64_t last = t->next_id + (int64_t)(nrows - 1);
    t->next_id = last == INT64_MAX ? 0 : last + 1;
    return 0;
}

int table_append(Table *t, const Value *fields, int64_t *id_out, uint64_t *off_out, DbError *err) {
    uint64_t off = t ? t->end : 0; int64_t id = 0;
    if (table_append_rows(t, fields, 1, &id, err)) return -1;
    if (id_out) *id_out = id;
    if (off_out) *off_out = off;
    return 0;
}

int table_read_at(Table *t, uint64_t off, Row *out, DbError *err) {
    clear_error(err);
    if (!out) return fail(err, off, "missing row output");
    *out = (Row){0};
    if (!t) return fail(err, off, "missing table");
    uint64_t size = t->end;
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

/* Scan the confirmed prefix [0, end at start). With yield set, the caller's read lock is
 * released and taken again about every SCAN_YIELD_BYTES, so a waiting writer gets in between
 * blocks. Bytes before the snapshot end never change (appends go after it), so the rows seen
 * are one consistent committed prefix. */
static int scan_prefix(Table *t, RowVisitor visitor, void *ctx, DbError *err, int yield, int *lock_lost) {
    clear_error(err);
    if (lock_lost) *lock_lost = 0;
    if (!t || !visitor) return fail(err, 0, "missing table or visitor");
    uint64_t size = t->end, off = 0, last_yield = 0;
    if (!size) return 0;
    BlockReader *reader = calloc(1, sizeof *reader);
    if (!reader) return fail(err, 0, "out of memory");
    reader->table = t; reader->size = size;
    int rc = 0;
    while (off < size) {
        if (yield && off - last_yield >= SCAN_YIELD_BYTES) {
            pthread_rwlock_unlock(&t->lock);
            if (pthread_rwlock_rdlock(&t->lock)) {
                if (lock_lost) *lock_lost = 1;
                rc = fail(err, off, "cannot reacquire table read lock"); break;
            }
            last_yield = off;
        }
        Row row = {0}; Meta meta; uint64_t next;
        int kind = read_record(reader, off, &row, &meta, &next, err);
        if (kind == RECORD_META) { off = next; continue; } /* meta records are never rows */
        if (kind != RECORD_OK) { rc = -1; break; }
        int stop = visitor(&row, off, ctx);
        if (stop) break;
        off = next;
    }
    free(reader);
    return rc;
}

int table_scan(Table *t, RowVisitor visitor, void *ctx, DbError *err) {
    return scan_prefix(t, visitor, ctx, err, 0, NULL);
}

int table_scan_yielding(Table *t, RowVisitor visitor, void *ctx, DbError *err, int *lock_lost) {
    return scan_prefix(t, visitor, ctx, err, 1, lock_lost);
}

void table_close(Table *t) {
    if (!t) return;
    bpt_free(t->index);
    os_close(t->file);
    pthread_rwlock_destroy(&t->lock);
    pthread_mutex_destroy(&t->wait.mutex);
    free(t);
}

int table_read_lock(Table *t) { return pthread_rwlock_rdlock(&t->lock); }
/* Take the write lock and record how long the caller waited for it. */
int table_write_lock(Table *t) {
    uint64_t start = os_now_us();
    int rc = pthread_rwlock_wrlock(&t->lock);
    if (rc) return rc;
    uint64_t waited = os_now_us() - start;
    pthread_mutex_lock(&t->wait.mutex);
    t->wait.samples[t->wait.next] = waited > UINT32_MAX ? UINT32_MAX : (uint32_t)waited;
    t->wait.next = (t->wait.next + 1) % TABLE_WAIT_SAMPLES;
    if (t->wait.count < TABLE_WAIT_SAMPLES) t->wait.count++;
    if (waited > t->wait.max) t->wait.max = waited;
    t->wait.total++;
    pthread_mutex_unlock(&t->wait.mutex);
    return 0;
}
int table_unlock(Table *t) { return pthread_rwlock_unlock(&t->lock); }
void table_set_sync(Table *t, int sync_always) { t->sync_always = sync_always != 0; }
uint64_t table_rows_written(const Table *t) { return atomic_load(&t->written); }
uint64_t table_row_count(const Table *t) { return atomic_load(&t->row_count); }

/* qsort order for wait samples. */
static int compare_u32(const void *a, const void *b) {
    uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b;
    return (x > y) - (x < y);
}

/* Copy the recent write-lock waits into out; *max and *total cover all time. */
size_t table_write_wait_samples(Table *t, uint32_t *out, uint64_t *max, uint64_t *total) {
    pthread_mutex_lock(&t->wait.mutex);
    size_t n = t->wait.count;
    memcpy(out, t->wait.samples, n * sizeof *out);
    *max = t->wait.max; *total = t->wait.total;
    pthread_mutex_unlock(&t->wait.mutex);
    return n;
}

/* Nearest-rank p99 of samples[0..n) (sorts in place); 0 when empty. */
uint64_t wait_p99(uint32_t *samples, size_t n) {
    if (!n) return 0;
    qsort(samples, n, sizeof *samples, compare_u32);
    return samples[n - n / 100 - 1];
}
void table_set_index(Table *t, BPTree *index) { bpt_free(t->index); t->index = index; }
const BPTree *table_index(const Table *t) { return t->index; }
