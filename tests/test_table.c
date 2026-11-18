#include "test.h"
#include "test_dir.h"
#include "table.h"
#include "os.h"
#include <limits.h>
#include <pthread.h>
#include <stdatomic.h>
#include <io.h>
#include <fcntl.h>

static char path[256];
static const TableSchema schema = {
    .name = "task5_table", .cols = {{"id", TYPE_INT}, {"name", TYPE_TEXT}, {"age", TYPE_INT}}, .ncols = 3
};

static Table *fresh(DbError *err) {
    test_dir_clear();
    return table_open(test_dir, &schema, 0, err);
}

static int append_row(Table *t, const char *text, uint32_t len, int64_t age,
                      int64_t *id, uint64_t *off, DbError *err) {
    Value fields[] = {{.type = TYPE_TEXT, .s = (char *)text, .len = len}, {.type = TYPE_INT, .i = age}};
    return table_append(t, fields, id, off, err);
}

static int populate(uint64_t offsets[3], DbError *err) {
    Table *t = fresh(err);
    if (!t) return -1;
    int rc = 0;
    for (int i = 0; i < 3 && !rc; i++) {
        char name[] = {'a' + i, '\0'};
        int64_t id;
        rc = append_row(t, name, 1, 20 + i, &id, &offsets[i], err);
        if (!rc && id != i + 1) rc = -1;
    }
    table_close(t);
    return rc;
}

typedef struct { int count, ok, stop; uint64_t *offsets; } Scan;
static int visit(const Row *row, uint64_t off, void *ctx) {
    Scan *s = ctx;
    int i = s->count++;
    if (row->n != 3 || row->id != i + 1 || row->fields[0].type != TYPE_INT ||
        row->fields[0].i != row->id || row->fields[1].type != TYPE_TEXT ||
        row->fields[1].len != 1 || row->fields[1].s[0] != 'a' + i ||
        row->fields[2].type != TYPE_INT || row->fields[2].i != 20 + i ||
        (s->offsets && off != s->offsets[i])) s->ok = 0;
    return s->stop;
}

static int file_size(uint64_t *size) {
    OsFile *f = os_open(path, 0);
    if (!f) return -1;
    *size = os_size(f);
    os_close(f);
    return *size == UINT64_MAX ? -1 : 0;
}

static int truncate_to(uint64_t size) {
    OsFile *f = os_open(path, 0);
    if (!f) return -1;
    int rc = os_truncate(f, size);
    os_close(f);
    return rc;
}

static int flip_byte(uint64_t off) {
    FILE *f = fopen(path, "r+b");
    if (!f) return -1;
    int rc = -1;
    if (off <= LONG_MAX && fseek(f, (long)off, SEEK_SET) == 0) {
        int ch = fgetc(f);
        if (ch != EOF && fseek(f, (long)off, SEEK_SET) == 0 && fputc(ch ^ 1, f) != EOF) rc = 0;
    }
    if (fclose(f)) rc = -1;
    return rc;
}

static void test_append_reopen_scan(void) {
    uint64_t offsets[3]; DbError err = {0};
    ASSERT(populate(offsets, &err) == 0);
    Table *t = table_open(test_dir, &schema, 0, &err);
    ASSERT(t != NULL);
    Scan s = {.ok = 1, .offsets = offsets};
    ASSERT(table_scan(t, visit, &s, &err) == 0 && s.ok && s.count == 3);
    Row row = {0};
    ASSERT(table_read_at(t, offsets[2], &row, &err) == 0 && row.id == 3);
    row_free(&row);
    ASSERT(row.fields == NULL && row.n == 0 && row.id == 0);
    row_free(&row); row_free(NULL);
    ASSERT(table_read_at(t, offsets[0], &row, &err) == 0 && row.id == 1);
    table_close(t);
    ASSERT(row.fields[1].s[0] == 'a'); /* Row owns its bytes. */
    row_free(&row);
}

static void test_ids_continue_after_reopen(void) {
    uint64_t offsets[3]; DbError err = {0}; int64_t id = 0; uint64_t off = 0, end;
    ASSERT(populate(offsets, &err) == 0 && file_size(&end) == 0);
    Table *t = table_open(test_dir, &schema, 0, &err);
    ASSERT(t && append_row(t, "d", 1, 23, &id, &off, &err) == 0);
    ASSERT(id == 4 && off == end);
    table_close(t);
}

static void test_truncated_tail_recovered(void) {
    uint64_t offsets[3], end, size; DbError err = {0}; int64_t id;
    ASSERT(populate(offsets, &err) == 0 && file_size(&end) == 0 && truncate_to(end - 5) == 0);
    Table *t = table_open(test_dir, &schema, 0, &err);
    ASSERT(t && file_size(&size) == 0 && size == offsets[2]);
    Scan s = {.ok = 1};
    ASSERT(table_scan(t, visit, &s, &err) == 0 && s.ok && s.count == 2);
    ASSERT(append_row(t, "c", 1, 22, &id, NULL, &err) == 0 && id == 3);
    table_close(t);
}

static void test_partial_header_recovered(void) {
    uint64_t offsets[3], size; DbError err = {0};
    for (uint64_t n = 1; n < 12; n++) {
        ASSERT(populate(offsets, &err) == 0 && truncate_to(offsets[2] + n) == 0);
        Table *t = table_open(test_dir, &schema, 0, &err);
        ASSERT(t && file_size(&size) == 0 && size == offsets[2]);
        table_close(t);
    }
}

static void test_crc_mismatch_refuses(void) {
    uint64_t offsets[3], before, after; DbError err = {0}; char expected[32];
    ASSERT(populate(offsets, &err) == 0 && file_size(&before) == 0);
    ASSERT(flip_byte(offsets[1] + 20) == 0);
    Table *t = table_open(test_dir, &schema, 0, &err);
    snprintf(expected, sizeof expected, "%llu", (unsigned long long)offsets[1]);
    ASSERT(t == NULL && strstr(err.message, "CRC") && strstr(err.message, expected));
    ASSERT(file_size(&after) == 0 && after == before);
}

static void test_crc_mismatch_repair(void) {
    uint64_t offsets[3], size; DbError err = {0}; int64_t id;
    ASSERT(populate(offsets, &err) == 0 && flip_byte(offsets[1] + 20) == 0);
    Table *t = table_open(test_dir, &schema, 1, &err);
    ASSERT(t && file_size(&size) == 0 && size == offsets[1] + 29);
    Scan s = {.ok = 1};
    ASSERT(table_scan(t, visit, &s, &err) == 0 && s.count == 1 && s.ok);
    /* The cut range held a valid record with id 3, so its id is not reused. */
    ASSERT(append_row(t, "b", 1, 21, &id, NULL, &err) == 0 && id == 4);
    table_close(t);
}

static void test_complete_tail_crc_refuses(void) {
    uint64_t offsets[3], before, after; DbError err = {0};
    ASSERT(populate(offsets, &err) == 0 && file_size(&before) == 0 && flip_byte(offsets[2] + 20) == 0);
    ASSERT(table_open(test_dir, &schema, 0, &err) == NULL && strstr(err.message, "CRC"));
    ASSERT(file_size(&after) == 0 && before == after);
}

static void test_text_with_nul_roundtrip(void) {
    char text[] = {'a', '\0', '\'', '\\', (char)0xff, 'z'}; DbError err = {0}; uint64_t off;
    Table *t = fresh(&err); Row row = {0};
    ASSERT(t && append_row(t, text, sizeof text, INT64_MIN, NULL, &off, &err) == 0);
    table_close(t); t = table_open(test_dir, &schema, 0, &err);
    ASSERT(t && table_read_at(t, off, &row, &err) == 0);
    ASSERT(row.fields[1].len == sizeof text && memcmp(row.fields[1].s, text, sizeof text) == 0);
    ASSERT(row.fields[2].i == INT64_MIN);
    row_free(&row); table_close(t);
}

static void test_text_too_long_error(void) {
    DbError err = {0}; uint64_t size; int64_t id = -1;
    char *text = malloc(65537); ASSERT(text); memset(text, 'x', 65537);
    Table *t = fresh(&err); ASSERT(t);
    ASSERT(append_row(t, text, 65537, 1, &id, NULL, &err) == -1 && err.message[0] && id == -1);
    ASSERT(file_size(&size) == 0 && size == 29);
    ASSERT(append_row(t, text, 65536, INT64_MAX, &id, NULL, &err) == 0 && id == 1);
    Row row = {0}; ASSERT(table_read_at(t, 29, &row, &err) == 0);
    ASSERT(row.fields[1].len == 65536 && memcmp(row.fields[1].s, text, 65536) == 0 && row.fields[2].i == INT64_MAX);
    row_free(&row); free(text); table_close(t);
}

static void test_empty_table_and_visitor_stop(void) {
    DbError err = {0}; Table *t = fresh(&err); Scan s = {.ok = 1};
    ASSERT(t && table_scan(t, visit, &s, &err) == 0 && s.count == 0);
    ASSERT(append_row(t, NULL, 0, 20, NULL, NULL, &err) == 0);
    Row row = {0}; ASSERT(table_read_at(t, 29, &row, &err) == 0 && row.fields[1].len == 0);
    row_free(&row); table_close(t);
    uint64_t offsets[3]; ASSERT(populate(offsets, &err) == 0);
    t = table_open(test_dir, &schema, 0, &err); s = (Scan){.ok = 1, .stop = 7};
    ASSERT(t && table_scan(t, visit, &s, &err) == 0 && s.ok && s.count == 1);
    table_close(t);
}

static void test_partial_write_rolls_back(void) {
    DbError err = {0}; uint64_t before, after, off = UINT64_MAX; int64_t id = -1;
    Table *t = fresh(&err); ASSERT(t && append_row(t, "a", 1, 20, NULL, NULL, &err) == 0);
    ASSERT(file_size(&before) == 0); os_test_fail_append();
    ASSERT(append_row(t, "bad", 3, 0, &id, &off, &err) == -1 && err.message[0]);
    ASSERT(file_size(&after) == 0 && before == after && id == -1 && off == UINT64_MAX);
    ASSERT(append_row(t, "b", 1, 21, &id, &off, &err) == 0 && id == 2 && off == before);
    table_close(t); t = table_open(test_dir, &schema, 0, &err); Scan s = {.ok = 1};
    ASSERT(t && table_scan(t, visit, &s, &err) == 0 && s.ok && s.count == 2);
    table_close(t);
}

static void test_sync_failure_rolls_back(void) {
    DbError err = {0}; uint64_t size; int64_t id = -1;
    Table *t = fresh(&err); ASSERT(t); os_test_fail_sync();
    ASSERT(append_row(t, "bad", 3, 0, &id, NULL, &err) == -1 && err.message[0] && id == -1);
    ASSERT(file_size(&size) == 0 && size == 29);
    table_close(t); t = table_open(test_dir, &schema, 0, &err);
    ASSERT(t && append_row(t, "a", 1, 20, &id, NULL, &err) == 0 && id == 1);
    table_close(t);
}

/* Independent little-endian fixture; CRC32/IEEE for id=1, TEXT='a', INT=-2. */
static const unsigned char fixture[] = {
    21,0,0,0, 0x80,0x3a,0xc7,0x0b, 0x9c,0x0a,0x9c,0xc0,
    1,0,0,0,0,0,0,0, 1,0,0,0,'a', 0xfe,0xff,0xff,0xff,0xff,0xff,0xff,0xff
};
static const unsigned char format_v3[29] = {17,0,0,0,215,173,165,132,155,202,237,126,0,0,0,0,0,0,0,0,3,3,0,0,0,0,0,0,0};
static int write_bytes(const unsigned char *bytes, size_t len) {
    FILE *f = fopen(path, "wb"); if (!f) return -1;
    int ok = fwrite(bytes, 1, len, f) == len;
    if (fclose(f)) ok = 0;
    return ok ? 0 : -1;
}

/* COMMIT (1 row) as Python computed it: len 17, check = crc32(len) ^ 0x4D444231, crc32(payload), id 0, kind 1, value 1. */
static const unsigned char commit_one[29] = {
    0x11,0x00,0x00,0x00, 0xd7,0xad,0xa5,0x84, 0x60,0xe5,0x3e,0x12,
    0,0,0,0,0,0,0,0, 0x01, 0x01,0,0,0,0,0,0,0
};
/* A one-row file: the given row bytes followed by their COMMIT. */
static int write_row_and_commit(const unsigned char *row, size_t len) {
    unsigned char bytes[29 + sizeof fixture + sizeof commit_one];
    memcpy(bytes, format_v3, 29); memcpy(bytes + 29, row, len); memcpy(bytes + 29 + len, commit_one, sizeof commit_one);
    return write_bytes(bytes, 29 + len + sizeof commit_one);
}

static void test_wire_format(void) {
    DbError err = {0}; unsigned char bytes[29 + sizeof fixture + sizeof commit_one];
    Table *t = fresh(&err); ASSERT(t && append_row(t, "a", 1, -2, NULL, NULL, &err) == 0);
    table_close(t);
    FILE *f = fopen(path, "rb"); ASSERT(f);
    ASSERT(fread(bytes, 1, sizeof bytes, f) == sizeof bytes && fgetc(f) == EOF);
    ASSERT(fclose(f) == 0 && memcmp(bytes, format_v3, 29) == 0 && memcmp(bytes + 29, fixture, sizeof fixture) == 0);
    ASSERT(memcmp(bytes + 29 + sizeof fixture, commit_one, sizeof commit_one) == 0);
    ASSERT(write_row_and_commit(fixture, sizeof fixture) == 0);
    t = table_open(test_dir, &schema, 0, &err); Row row = {0};
    ASSERT(t && table_read_at(t, 29, &row, &err) == 0 && row.id == 1 && row.fields[2].i == -2);
    row_free(&row); table_close(t);
}

static int write_framed_bytes(const unsigned char *row, size_t len) {
    unsigned char bytes[29 + sizeof fixture];
    memcpy(bytes, format_v3, 29); memcpy(bytes + 29, row, len);
    return write_bytes(bytes, 29 + len);
}

static void test_invalid_length_refuses(void) {
    DbError err = {0}; uint64_t size;
    unsigned char bad[sizeof fixture]; memcpy(bad, fixture, sizeof bad); memset(bad, 0xff, 4);
    ASSERT(write_framed_bytes(bad, sizeof bad) == 0);
    ASSERT(table_open(test_dir, &schema, 0, &err) == NULL && strstr(err.message, "offset 29"));
    ASSERT(file_size(&size) == 0 && size == 29 + sizeof bad);
    Table *t = table_open(test_dir, &schema, 1, &err);
    ASSERT(t && file_size(&size) == 0 && size == 29); table_close(t);
    memset(bad, 0, 4); ASSERT(write_framed_bytes(bad, sizeof bad) == 0);
    ASSERT(table_open(test_dir, &schema, 0, &err) == NULL);
}

static void test_bad_inputs_and_read_offsets(void) {
    DbError err = {0}; Table *t = fresh(&err); Row row = {0}; uint64_t size;
    ASSERT(t); Value wrong[] = {{.type = TYPE_INT}, {.type = TYPE_INT}};
    ASSERT(table_append(t, wrong, NULL, NULL, &err) == -1 && err.message[0]);
    ASSERT(append_row(t, NULL, 1, 0, NULL, NULL, &err) == -1);
    ASSERT(file_size(&size) == 0 && size == 29);
    ASSERT(append_row(t, "a", 1, 20, NULL, NULL, &err) == 0 && err.message[0] == '\0');
    ASSERT(table_read_at(t, UINT64_MAX, &row, &err) == -1 && row.fields == NULL);
    ASSERT(file_size(&size) == 0 && table_read_at(t, size, &row, &err) == -1);
    table_close(t);
}

static void test_crc_valid_malformed_fields(void) {
    /* Independently computed CRC for the fixture with TEXT length changed to 2,
     * leaving only 7 bytes for the final INT. CRC success must not bypass bounds. */
    unsigned char bad[sizeof fixture]; memcpy(bad, fixture, sizeof bad);
    const unsigned char crc[] = {0x52, 0x66, 0x56, 0x7d};
    memcpy(bad + 8, crc, sizeof crc); bad[20] = 2;
    DbError err = {0}; uint64_t size;
    ASSERT(write_framed_bytes(bad, sizeof bad) == 0);
    ASSERT(table_open(test_dir, &schema, 0, &err) == NULL && strstr(err.message, "fields"));
    ASSERT(file_size(&size) == 0 && size == 29 + sizeof bad);
    Table *t = table_open(test_dir, &schema, 1, &err);
    ASSERT(t && file_size(&size) == 0 && size == 58); /* FORMAT plus the ID_FLOOR record for the cut id 1 */
    table_close(t);
}

static void test_id_exhaustion_after_reopen(void) {
    unsigned char max_id[sizeof fixture]; memcpy(max_id, fixture, sizeof max_id);
    const unsigned char crc[] = {0xd6, 0x52, 0xde, 0x54};
    memcpy(max_id + 8, crc, sizeof crc);
    memset(max_id + 12, 0xff, 7); max_id[19] = 0x7f;
    DbError err = {0}; uint64_t size; int64_t id = -1; Row row = {0};
    ASSERT(write_row_and_commit(max_id, sizeof max_id) == 0);
    Table *t = table_open(test_dir, &schema, 0, &err);
    ASSERT(t && table_read_at(t, 29, &row, &err) == 0 && row.id == INT64_MAX);
    row_free(&row);
    ASSERT(append_row(t, "a", 1, 20, &id, NULL, &err) == -1 && id == -1 && strstr(err.message, "id"));
    ASSERT(file_size(&size) == 0 && size == 29 + sizeof max_id + sizeof commit_one); table_close(t);
}

static void test_record_size_limit(void) {
    TableSchema wide = {.name = "task5_table", .cols = {{"id", TYPE_INT}}, .ncols = 32};
    Value fields[31] = {0}; char *text = malloc(65536); ASSERT(text); memset(text, 'x', 65536);
    for (int i = 0; i < 31; i++) {
        wide.cols[i + 1].type = TYPE_TEXT;
        fields[i] = (Value){.type = TYPE_TEXT, .s = text, .len = 65536};
    }
    test_dir_clear(); DbError err = {0}; uint64_t size;
    Table *t = table_open(test_dir, &wide, 0, &err); ASSERT(t);
    ASSERT(table_append(t, fields, NULL, NULL, &err) == -1 && err.message[0]);
    ASSERT(file_size(&size) == 0 && size == 29);
    table_close(t); free(text);
}

static void test_record_exact_size_boundary(void) {
    TableSchema wide = {.name = "task5_table", .cols = {{"id", TYPE_INT}}, .ncols = 17};
    Value fields[16] = {0}; char *text = malloc(65536); ASSERT(text); memset(text, 'x', 65536);
    for (int i = 0; i < 16; i++) {
        wide.cols[i + 1].type = TYPE_TEXT;
        fields[i] = (Value){.type = TYPE_TEXT, .s = text, .len = 65536};
    }
    /* 12-byte header + 8-byte id + 16 length prefixes + TEXT = exactly 1 MiB. */
    fields[15].len = 65452;
    test_dir_clear(); DbError err = {0}; uint64_t size; int64_t id = -1;
    Table *t = table_open(test_dir, &wide, 0, &err); ASSERT(t);
    ASSERT(table_append(t, fields, &id, NULL, &err) == 0 && id == 1);
    ASSERT(file_size(&size) == 0 && size == 29 + 1024 * 1024 + 29); /* record + COMMIT */
    fields[15].len++;
    ASSERT(table_append(t, fields, &id, NULL, &err) == -1 && id == 1);
    ASSERT(file_size(&size) == 0 && size == 29 + 1024 * 1024 + 29); /* record + COMMIT */
    table_close(t); t = table_open(test_dir, &wide, 0, &err); Row row = {0};
    ASSERT(t && table_read_at(t, 29, &row, &err) == 0 && row.n == 17 && row.fields[16].len == 65452);
    for (int i = 1; i < row.n; i++) ASSERT(memcmp(row.fields[i].s, text, row.fields[i].len) == 0);
    row_free(&row); table_close(t); free(text);
}

typedef struct { int count, ok; } WideCheck;
static int check_wide_row(const Row *row, uint64_t off, void *ctx) {
    WideCheck *c = ctx;
    int index = c->count++;
    if (row->id != index + 1 || (index == 0 ? off != 29 : off != 29u + 81u + (uint64_t)(index - 1) * 524369u)) c->ok = 0;
    for (int i = 1; i < 9; i++) {
        uint32_t len = index == 0 ? 0 : 65536;
        if (row->fields[i].len != len || row->fields[i].s[len] != '\0') c->ok = 0;
        for (uint32_t j = 0; j < len; j++) if (row->fields[i].s[j] != (char)('a' + i - 1)) c->ok = 0;
    }
    return 0;
}
static int fail_open_visitor(int64_t id, uint64_t off, void *ctx) {
    (void)id; (void)off; (void)ctx; return -1;
}
static void test_block_payload_boundary_and_callback_failure(void) {
    TableSchema wide = {.name = "task5_table", .cols = {{"id", TYPE_INT}}, .ncols = 9};
    Value fields[8]; char *text = malloc(8 * 65536); ASSERT(text);
    for (int i = 0; i < 8; i++) {
        wide.cols[i + 1].type = TYPE_TEXT;
        memset(text + i * 65536, 'a' + i, 65536);
        fields[i] = (Value){.type = TYPE_TEXT, .s = text + i * 65536};
    }
    test_dir_clear(); DbError err = {0}; Table *t = table_open(test_dir, &wide, 0, &err); ASSERT(t);
    table_set_sync(t, 0);
    ASSERT(table_append(t, fields, NULL, NULL, &err) == 0);
    for (int i = 0; i < 8; i++) fields[i].len = 65536;
    for (int i = 0; i < 3; i++) ASSERT(table_append(t, fields, NULL, NULL, &err) == 0);
    table_close(t);
    uint64_t before, after; ASSERT(file_size(&before) == 0);
    ASSERT(table_open_with_visitor(test_dir, &wide, 1, fail_open_visitor, NULL, &err) == NULL);
    ASSERT(err.kind == DB_ERROR_INTERNAL && file_size(&after) == 0 && before == after);
    t = table_open(test_dir, &wide, 0, &err); ASSERT(t);
    WideCheck c = {.ok = 1}; ASSERT(table_scan(t, check_wide_row, &c, &err) == 0 && c.ok && c.count == 4);
    table_close(t); free(text);
}

typedef struct { Table *t; uint64_t off; int64_t id; int ok; } Reader;
static void *read_many(void *ctx) {
    Reader *r = ctx; r->ok = 1;
    for (int i = 0; i < 1000; i++) {
        Row row = {0}; DbError err = {0};
        if (table_read_at(r->t, r->off, &row, &err) != 0 || row.id != r->id ||
            row.fields[1].s[0] != 'a' + r->id - 1) r->ok = 0;
        row_free(&row);
        if (!r->ok) break;
    }
    return NULL;
}
static void test_concurrent_read_at(void) {
    uint64_t offsets[3]; DbError err = {0}; pthread_t threads[8]; Reader readers[8];
    ASSERT(populate(offsets, &err) == 0);
    Table *t = table_open(test_dir, &schema, 0, &err); ASSERT(t);
    for (int i = 0; i < 8; i++) {
        readers[i] = (Reader){t, offsets[i % 3], i % 3 + 1, 0};
        ASSERT(pthread_create(&threads[i], NULL, read_many, &readers[i]) == 0);
    }
    for (int i = 0; i < 8; i++) ASSERT(pthread_join(threads[i], NULL) == 0 && readers[i].ok);
    table_close(t);
}

typedef struct { int count, ok; uint64_t end; } BlockCheck;
static int check_open_id(int64_t id, uint64_t off, void *ctx) {
    BlockCheck *c = ctx;
    if (id != c->count + 1 || off != c->end) c->ok = 0;
    c->count++; c->end += 33 + 29; /* row + its COMMIT */
    return 0;
}
static int check_block_row(const Row *row, uint64_t off, void *ctx) {
    BlockCheck *c = ctx;
    check_open_id(row->id, off, ctx);
    if (row->fields[1].len != 1 || strcmp(row->fields[1].s, "a") || row->fields[2].i != 20) c->ok = 0;
    return 0;
}
static void *scan_blocks(void *ctx) {
    Table *t = ctx; BlockCheck c = {.ok = 1, .end = 29}; DbError err = {0};
    int rc = table_scan(t, check_block_row, &c, &err);
    return rc == 0 && c.ok && c.count == 40000 ? NULL : t;
}
static void test_block_scan_open_callback_and_concurrency(void) {
    DbError err = {0}; Table *t = fresh(&err); ASSERT(t);
    table_set_sync(t, 0);
    for (int i = 0; i < 40000; i++) ASSERT(append_row(t, "a", 1, 20, NULL, NULL, &err) == 0);
    table_close(t);
    BlockCheck c = {.ok = 1, .end = 29}; os_test_reset_reads();
    t = table_open_with_visitor(test_dir, &schema, 0, check_open_id, &c, &err);
    ASSERT(t && c.ok && c.count == 40000 && os_test_read_calls() <= 4);
    os_test_reset_reads();
    pthread_t threads[4];
    for (int i = 0; i < 4; i++) ASSERT(pthread_create(&threads[i], NULL, scan_blocks, t) == 0);
    for (int i = 0; i < 4; i++) { void *result; ASSERT(pthread_join(threads[i], &result) == 0 && !result); }
    ASSERT(os_test_read_calls() <= 16);
    os_test_fail_read();
    ASSERT(table_scan(t, check_block_row, &c, &err) == -1 && err.kind == DB_ERROR_INTERNAL);
    table_close(t);
    uint64_t before, after; ASSERT(file_size(&before) == 0); os_test_fail_read();
    ASSERT(!table_open(test_dir, &schema, 1, &err) && err.kind == DB_ERROR_INTERNAL);
    ASSERT(file_size(&after) == 0 && before == after);
}

/* First file in the private folder whose name contains `part`; 0 if none. */
static int find_file(const char *part, char *name, size_t size) {
    DIR *d = opendir(test_dir); if (!d) return 0;
    struct dirent *e; int found = 0;
    while (!found && (e = readdir(d))) {
        if (strstr(e->d_name, part)) { snprintf(name, size, "%s", e->d_name); found = 1; }
    }
    closedir(d); return found;
}

/* Run table_open with stderr redirected to a file; returns the captured text. */
static Table *open_capture_stderr(int repair, DbError *err, char *text, size_t size) {
    const char *capture = test_path("stderr.txt");
    fflush(stderr); int saved = _dup(2);
    int fd = _open(capture, _O_WRONLY | _O_CREAT | _O_TRUNC | _O_BINARY, 0600);
    if (saved < 0 || fd < 0) return NULL;
    _dup2(fd, 2); _close(fd);
    Table *t = table_open(test_dir, &schema, repair, err);
    fflush(stderr); _dup2(saved, 2); _close(saved);
    FILE *f = fopen(capture, "rb"); size_t n = f ? fread(text, 1, size - 1, f) : 0;
    text[n] = '\0'; if (f) fclose(f);
    return t;
}

static void test_repair_backs_up_cut_bytes_and_skips_their_ids(void) {
    uint64_t size; DbError err = {0}; int64_t id; char text[1024];
    Table *t = fresh(&err); ASSERT(t); uint64_t off[5];
    for (int i = 0; i < 5; i++) ASSERT(append_row(t, "a", 1, 20, &id, &off[i], &err) == 0);
    table_close(t);
    ASSERT(file_size(&size) == 0 && flip_byte(off[2] + 20) == 0);
    FILE *f = fopen(path, "rb"); ASSERT(f);
    unsigned char *original = malloc((size_t)size); ASSERT(original && fread(original, 1, (size_t)size, f) == size); fclose(f);
    t = open_capture_stderr(1, &err, text, sizeof text); ASSERT(t);
    uint64_t after; ASSERT(file_size(&after) == 0 && after == off[2] + 29);
    char name[256], expected[256]; ASSERT(find_file(".tbl.repair-", name, sizeof name));
    ASSERT(strlen(name) == strlen("task5_table.tbl.repair-YYYYMMDD-HHMMSS"));
    FILE *backup = fopen(test_path(name), "rb"); ASSERT(backup);
    unsigned char *copy = malloc((size_t)size); ASSERT(copy);
    size_t got = fread(copy, 1, (size_t)size, backup); fclose(backup);
    ASSERT(got == size - off[2] && memcmp(copy, original + off[2], got) == 0);
    snprintf(expected, sizeof expected, "cut %llu bytes at offset %llu", (unsigned long long)(size - off[2]), (unsigned long long)off[2]);
    ASSERT(strstr(text, expected) && strstr(text, name));
    ASSERT(strstr(text, "2 intact records") && strstr(text, "ids 4..5"));
    ASSERT(append_row(t, "n", 1, 1, &id, NULL, &err) == 0 && id == 6);
    table_close(t); free(original); free(copy);
}

static void test_repair_backup_failure_does_not_truncate(void) {
    DbError err = {0}; uint64_t size, after; int64_t id; char text[256];
    Table *t = fresh(&err); ASSERT(t); uint64_t off[3];
    for (int i = 0; i < 3; i++) ASSERT(append_row(t, "a", 1, 20, &id, &off[i], &err) == 0);
    table_close(t); ASSERT(file_size(&size) == 0 && flip_byte(off[1] + 20) == 0);
    os_test_fail_append();
    ASSERT(open_capture_stderr(1, &err, text, sizeof text) == NULL && err.message[0]);
    ASSERT(file_size(&after) == 0 && after == size);
    char name[256]; ASSERT(find_file(".tbl.repair-", name, sizeof name) == 0); /* No partial backup left. */
}

static void test_repair_without_later_valid_records_reports_none(void) {
    uint64_t offsets[3]; DbError err = {0}; char text[1024];
    ASSERT(populate(offsets, &err) == 0 && flip_byte(offsets[2] + 20) == 0);
    Table *t = open_capture_stderr(1, &err, text, sizeof text); ASSERT(t);
    ASSERT(strstr(text, "0 intact records") && strstr(text, "backup"));
    int64_t id; ASSERT(append_row(t, "n", 1, 1, &id, NULL, &err) == 0 && id == 4); /* id 3 stays burned (ID_FLOOR) */
    table_close(t);
}

static void test_failed_rollback_hides_unconfirmed_bytes(void) {
    DbError err = {0}; uint64_t before, off1; int64_t id;
    Table *t = fresh(&err); ASSERT(t && append_row(t, "a", 1, 20, &id, NULL, &err) == 0);
    ASSERT(file_size(&before) == 0); os_test_fail_sync(); os_test_fail_truncate();
    ASSERT(append_row(t, "b", 1, 21, &id, &off1, &err) == -1 && strstr(err.message, "rollback"));
    uint64_t grown; ASSERT(file_size(&grown) == 0 && grown > before); /* The bytes are still in the file. */
    Scan s = {.ok = 1}; ASSERT(table_scan(t, visit, &s, &err) == 0 && s.ok && s.count == 1);
    Row row = {0}; ASSERT(table_read_at(t, before, &row, &err) == -1); row_free(&row);
    ASSERT(append_row(t, "c", 1, 22, &id, NULL, &err) == -1);
    table_close(t);
}

static void test_append_rows_batch_and_single_sync(void) {
    DbError err = {0}; Table *t = fresh(&err); ASSERT(t);
    Value rows[2 * 4]; char names[4][2] = {"a", "b", "c", "d"}; int64_t ids[4]; Scan s = {.ok = 1};
    for (int i = 0; i < 4; i++) {
        rows[i * 2] = (Value){.type = TYPE_TEXT, .s = names[i], .len = 1};
        rows[i * 2 + 1] = (Value){.type = TYPE_INT, .i = 20 + i};
    }
    os_test_reset_syncs();
    ASSERT(table_append_rows(t, rows, 4, ids, &err) == 0 && os_test_sync_calls() == 2);
    ASSERT(ids[0] == 1 && ids[3] == 4 && table_rows_written(t) == 4);
    ASSERT(table_scan(t, visit, &s, &err) == 0 && s.ok && s.count == 4);
    table_close(t);
}

typedef struct { Table *t; atomic_int writer_done; int rows, writer_done_at_yield, past_yield; } Yield;

/* Writer thread: waits for the table write lock, appends one row, unlocks. */
static void *yield_writer(void *p) {
    Yield *y = p; DbError err = {0}; int64_t id;
    int ok = table_write_lock(y->t) == 0;
    if (ok) {
        ok = append_row(y->t, "zz", 2, 1, &id, NULL, &err) == 0;
        table_unlock(y->t);
    }
    atomic_store(&y->writer_done, ok ? 1 : -1);
    return NULL;
}

/* Counts rows; the first row at or past the yield point records whether the writer already got in. */
static int yield_visit(const Row *row, uint64_t off, void *ctx) {
    Yield *y = ctx; (void)row;
    y->rows++;
    if (!y->past_yield && off >= SCAN_YIELD_BYTES) {
        y->past_yield = 1;
        y->writer_done_at_yield = atomic_load(&y->writer_done) == 1;
    }
    return 0;
}

/* A long scan gives the read lock back between blocks: a waiting writer gets in mid-scan, and the scan still sees only the rows committed when it started. */
static void test_scan_yielding_lets_writer_in_and_keeps_snapshot(void) {
    DbError err = {0};
    Table *t = fresh(&err);
    ASSERT(t);
    table_set_sync(t, 0);
    enum { N = 30000 };
    for (int i = 0; i < N; i++) {
        char name[32]; int64_t id;
        int len = snprintf(name, sizeof name, "user_%d", i);
        ASSERT(append_row(t, name, (uint32_t)len, i, &id, NULL, &err) == 0);
    }
    Yield y = {.t = t};
    ASSERT(table_read_lock(t) == 0);
    pthread_t th;
    ASSERT(pthread_create(&th, NULL, yield_writer, &y) == 0);
    for (uint64_t until = os_now_us() + 30000; os_now_us() < until;) {}   /* let the writer block on the lock */
    int lock_lost = 1;
    int rc = table_scan_yielding(t, yield_visit, &y, &err, &lock_lost);
    ASSERT(rc == 0 && lock_lost == 0);
    table_unlock(t);
    pthread_join(th, NULL);
    ASSERT(y.rows == N);                       /* snapshot: the row appended mid-scan is not seen */
    ASSERT(y.past_yield && y.writer_done_at_yield);
    ASSERT(atomic_load(&y.writer_done) == 1 && table_row_count(t) == N + 1);
    table_close(t);
}

/* ---- statement commit records (meta records) and the id floor ---- */

/* Independent CRC32/IEEE and meta-record encoder, so the tests do not trust the implementation. */
static uint32_t test_crc32(const unsigned char *p, size_t n) {
    uint32_t crc = 0xffffffffu;
    for (size_t i = 0; i < n; i++) {
        crc ^= p[i];
        for (int bit = 0; bit < 8; bit++) crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1u)));
    }
    return ~crc;
}
static void test_put32(unsigned char *p, uint32_t v) { for (int i = 0; i < 4; i++) p[i] = (unsigned char)(v >> (8 * i)); }
/* 29-byte meta record: id 0, then [u8 kind][i64 value]. */
static void make_meta(unsigned char out[29], unsigned kind, int64_t value) {
    memset(out, 0, 29);
    test_put32(out, 17);
    test_put32(out + 4, test_crc32(out, 4) ^ 0x4D444231u);
    out[20] = (unsigned char)kind;
    for (int i = 0; i < 8; i++) out[21 + i] = (unsigned char)((uint64_t)value >> (8 * i));
    test_put32(out + 8, test_crc32(out + 12, 17));
}
static int append_bytes(const unsigned char *bytes, size_t n) {
    FILE *f = fopen(path, "ab"); if (!f) return -1;
    int ok = fwrite(bytes, 1, n, f) == n;
    return fclose(f) == 0 && ok ? 0 : -1;
}
static int read_all(unsigned char *buf, size_t cap, size_t *n) {
    FILE *f = fopen(path, "rb"); if (!f) return -1;
    *n = fread(buf, 1, cap, f); fclose(f); return 0;
}
static int is_meta_at(const unsigned char *file, uint64_t off, unsigned kind, int64_t value) {
    unsigned char want[29]; make_meta(want, kind, value);
    return memcmp(file + off, want, 29) == 0;
}
static Value statement_rows[4000];
static char statement_text[65536];
/* nrows rows of (TEXT of text_len x's, INT index) in schema order. */
static Value *statement_of(size_t nrows, size_t text_len) {
    memset(statement_text, 'x', sizeof statement_text);
    for (size_t i = 0; i < nrows; i++) {
        statement_rows[i * 2] = (Value){.type = TYPE_TEXT, .s = statement_text, .len = (uint32_t)text_len};
        statement_rows[i * 2 + 1] = (Value){.type = TYPE_INT, .i = (int64_t)i};
    }
    return statement_rows;
}
static int count_visit(const Row *row, uint64_t off, void *ctx) { (void)row; (void)off; (*(int *)ctx)++; return 0; }
static int count_rows(Table *t, DbError *err) {
    int n = 0;
    return table_scan(t, count_visit, &n, err) == 0 ? n : -1;
}
typedef struct { int64_t last; int n, ok; } Seen;
static int open_collect(int64_t id, uint64_t off, void *ctx) {
    (void)off; Seen *s = ctx;
    if (id != s->last + 1) s->ok = 0;
    s->last = id; s->n++;
    return 0;
}
/* Write a statement without its COMMIT: the sync fails and so does the rollback. */
static int write_unfinished_statement(Table *t, size_t nrows, DbError *err) {
    os_test_fail_sync(); os_test_fail_truncate();
    return table_append_rows(t, statement_of(nrows, 1), nrows, NULL, err);
}

static void test_commit_record_follows_each_statement(void) {
    DbError err = {0}; Table *t = fresh(&err); ASSERT(t);
    uint64_t off; int64_t id;
    ASSERT(append_row(t, "a", 1, 20, &id, &off, &err) == 0 && off == 29);
    ASSERT(table_append_rows(t, statement_of(3, 1), 3, NULL, &err) == 0);
    table_close(t);
    unsigned char file[512]; size_t n; ASSERT(read_all(file, sizeof file, &n) == 0);
    /* row (33 bytes) + COMMIT(1) + 3 rows (33 each) + COMMIT(3) */
    ASSERT(n == 29 + 33 + 29 + 3 * 33 + 29);
    ASSERT(memcmp(file + 29 + 33, commit_one, 29) == 0 && is_meta_at(file, 29 + 33, 1, 1) && is_meta_at(file, 29 + 33 + 29 + 99, 1, 3));
    t = table_open(test_dir, &schema, 0, &err);
    ASSERT(t && count_rows(t, &err) == 4 && table_row_count(t) == 4);
    ASSERT(append_row(t, "z", 1, 1, &id, NULL, &err) == 0 && id == 5);
    table_close(t);
}

static void test_failed_rollback_leaves_no_row_after_reopen_all_rows(void) {
    DbError err = {0}; Table *t = fresh(&err); ASSERT(t && append_row(t, "a", 1, 20, NULL, NULL, &err) == 0);
    uint64_t before; ASSERT(file_size(&before) == 0);
    ASSERT(write_unfinished_statement(t, 5, &err) == -1);
    uint64_t grown; ASSERT(file_size(&grown) == 0 && grown > before); /* all five rows are still in the file */
    table_close(t);
    char text[512]; t = open_capture_stderr(0, &err, text, sizeof text);
    ASSERT(t && count_rows(t, &err) == 1 && table_row_count(t) == 1);
    ASSERT(strstr(text, "incomplete statement: 5 records") && strstr(text, "truncated at offset"));
    uint64_t after; int64_t id;
    ASSERT(file_size(&after) == 0 && after == before);
    ASSERT(append_row(t, "b", 1, 21, &id, NULL, &err) == 0 && id == 2);
    table_close(t);
}

static void test_failed_rollback_leaves_no_row_after_reopen_some_rows(void) {
    DbError err = {0}; Table *t = fresh(&err); ASSERT(t && append_row(t, "a", 1, 20, NULL, NULL, &err) == 0);
    uint64_t before; ASSERT(file_size(&before) == 0);
    table_test_set_write_chunk(1); os_test_fail_append_after(2); os_test_fail_truncate();
    ASSERT(table_append_rows(t, statement_of(5, 1), 5, NULL, &err) == -1);
    table_test_set_write_chunk(1u << 20);
    uint64_t grown; ASSERT(file_size(&grown) == 0 && grown > before); /* two rows and half of a third remain */
    table_close(t);
    t = table_open(test_dir, &schema, 0, &err);
    ASSERT(t && count_rows(t, &err) == 1);
    uint64_t after; int64_t id;
    ASSERT(file_size(&after) == 0 && after == before);
    ASSERT(append_row(t, "b", 1, 21, &id, NULL, &err) == 0 && id == 2);
    table_close(t);
}

static void test_big_statement_stopped_midway_is_cut_on_reopen(void) {
    /* 20 rows of 64 KiB (about 1.3 MiB): the second 1 MiB write fails, rollback fails too. */
    DbError err = {0}; Table *t = fresh(&err); ASSERT(t && append_row(t, "a", 1, 20, NULL, NULL, &err) == 0);
    uint64_t before; ASSERT(file_size(&before) == 0);
    os_test_fail_append_after(1); os_test_fail_truncate();
    ASSERT(table_append_rows(t, statement_of(20, 65536), 20, NULL, &err) == -1);
    uint64_t grown; ASSERT(file_size(&grown) == 0 && grown > before + (1u << 20));
    table_close(t);
    t = table_open(test_dir, &schema, 0, &err);
    uint64_t after; ASSERT(t && count_rows(t, &err) == 1 && file_size(&after) == 0 && after == before);
    table_close(t);
}

static void test_statement_without_commit_at_end_is_cut_and_earlier_kept(void) {
    DbError err = {0}; Table *t = fresh(&err); ASSERT(t);
    ASSERT(table_append_rows(t, statement_of(2, 1), 2, NULL, &err) == 0);
    uint64_t end; ASSERT(file_size(&end) == 0);
    ASSERT(table_append_rows(t, statement_of(3, 1), 3, NULL, &err) == 0);
    table_close(t);
    uint64_t full; ASSERT(file_size(&full) == 0 && truncate_to(full - 29) == 0); /* drop only the last COMMIT */
    char text[512]; t = open_capture_stderr(0, &err, text, sizeof text);
    ASSERT(t && count_rows(t, &err) == 2);
    uint64_t after; ASSERT(file_size(&after) == 0 && after == end);
    char expected[128]; snprintf(expected, sizeof expected, "incomplete statement: 3 records (%llu bytes) truncated at offset %llu",
                                 (unsigned long long)(full - 29 - end), (unsigned long long)end);
    ASSERT(strstr(text, expected));
    table_close(t);
}

static void test_commit_count_mismatch_refuses_and_repair_cuts_statement(void) {
    DbError err = {0}; Table *t = fresh(&err); ASSERT(t);
    ASSERT(table_append_rows(t, statement_of(2, 1), 2, NULL, &err) == 0);
    uint64_t end; ASSERT(file_size(&end) == 0);
    ASSERT(write_unfinished_statement(t, 3, &err) == -1); /* three rows, no COMMIT */
    table_close(t);
    unsigned char commit[29]; make_meta(commit, 1, 2);    /* valid CRC, but claims 2 rows */
    ASSERT(append_bytes(commit, sizeof commit) == 0);
    uint64_t before; ASSERT(file_size(&before) == 0);
    ASSERT(table_open(test_dir, &schema, 0, &err) == NULL && err.message[0]);
    uint64_t after; ASSERT(file_size(&after) == 0 && after == before);
    t = table_open(test_dir, &schema, 1, &err);
    ASSERT(t && count_rows(t, &err) == 2 && file_size(&after) == 0 && after == end + 29);
    table_close(t);
}

static void test_commit_without_rows_refused(void) {
    DbError err = {0}; Table *t = fresh(&err); ASSERT(t);
    ASSERT(table_append_rows(t, statement_of(1, 1), 1, NULL, &err) == 0);
    table_close(t);
    unsigned char commit[29]; make_meta(commit, 1, 1);
    ASSERT(append_bytes(commit, sizeof commit) == 0); /* a COMMIT with no rows before it */
    ASSERT(table_open(test_dir, &schema, 0, &err) == NULL);
}

static void test_id_floor_inside_unfinished_statement_refused(void) {
    DbError err = {0}; Table *t = fresh(&err); ASSERT(t);
    ASSERT(write_unfinished_statement(t, 1, &err) == -1);
    table_close(t);
    unsigned char floor_rec[29]; make_meta(floor_rec, 2, 9);
    ASSERT(append_bytes(floor_rec, sizeof floor_rec) == 0); /* something other than COMMIT after a pending row */
    ASSERT(table_open(test_dir, &schema, 0, &err) == NULL);
}

static void test_many_statements_reopen_and_visitor_sees_ordered_rows(void) {
    DbError err = {0}; Table *t = fresh(&err); ASSERT(t);
    for (size_t i = 0; i < 20; i++) ASSERT(table_append_rows(t, statement_of(i % 4 + 1, 1), i % 4 + 1, NULL, &err) == 0);
    ASSERT(table_row_count(t) == 50);
    table_close(t);
    Seen seen = {0, 0, 1};
    t = table_open_with_visitor(test_dir, &schema, 0, open_collect, &seen, &err);
    ASSERT(t && seen.ok && seen.n == 50 && table_row_count(t) == 50 && count_rows(t, &err) == 50);
    int64_t id; ASSERT(append_row(t, "n", 1, 1, &id, NULL, &err) == 0 && id == 51);
    table_close(t);
}

static void test_open_visitor_gets_no_rows_of_unfinished_statement(void) {
    DbError err = {0}; Table *t = fresh(&err); ASSERT(t);
    ASSERT(table_append_rows(t, statement_of(2, 1), 2, NULL, &err) == 0);
    ASSERT(write_unfinished_statement(t, 3, &err) == -1);
    table_close(t);
    Seen seen = {0, 0, 1};
    t = table_open_with_visitor(test_dir, &schema, 0, open_collect, &seen, &err);
    ASSERT(t && seen.n == 2 && seen.ok); table_close(t);
}

static void test_sync_always_two_syncs_per_statement_and_none_when_off(void) {
    DbError err = {0}; Table *t = fresh(&err); ASSERT(t);
    os_test_reset_syncs();
    ASSERT(table_append_rows(t, statement_of(1000, 1), 1000, NULL, &err) == 0 && os_test_sync_calls() == 2);
    table_set_sync(t, 0); os_test_reset_syncs();
    ASSERT(table_append_rows(t, statement_of(10, 1), 10, NULL, &err) == 0 && os_test_sync_calls() == 0);
    table_close(t);
    static unsigned char file[1 << 16]; size_t n; ASSERT(read_all(file, sizeof file, &n) == 0);
    ASSERT(n == 29 + 1000 * 33 + 29 + 10 * 33 + 29 && is_meta_at(file, n - 29, 1, 10)); /* COMMIT is written even with sync off */
}

static void test_commit_write_failure_rolls_back_statement(void) {
    DbError err = {0}; Table *t = fresh(&err); ASSERT(t && append_row(t, "a", 1, 20, NULL, NULL, &err) == 0);
    uint64_t before; ASSERT(file_size(&before) == 0);
    os_test_fail_append_after(1); /* rows go out in one write; the COMMIT write fails */
    ASSERT(table_append_rows(t, statement_of(3, 1), 3, NULL, &err) == -1);
    uint64_t after; int64_t id;
    ASSERT(file_size(&after) == 0 && after == before);
    ASSERT(append_row(t, "b", 1, 21, &id, NULL, &err) == 0 && id == 2);
    table_close(t);
}

static void test_repair_writes_id_floor_that_survives_next_sessions(void) {
    DbError err = {0}; Table *t = fresh(&err); ASSERT(t); uint64_t off[5]; int64_t id;
    for (int i = 0; i < 5; i++) ASSERT(append_row(t, "a", 1, 20, &id, &off[i], &err) == 0);
    table_close(t); ASSERT(flip_byte(off[1] + 20) == 0);
    char text[1024]; t = open_capture_stderr(1, &err, text, sizeof text); ASSERT(t); /* SELECT only: no append here */
    ASSERT(count_rows(t, &err) == 1);
    table_close(t);
    unsigned char file[512]; size_t n; ASSERT(read_all(file, sizeof file, &n) == 0);
    ASSERT(n == off[1] + 29 && is_meta_at(file, off[1], 2, 5)); /* ID_FLOOR 5 stands where the cut was */
    t = table_open(test_dir, &schema, 0, &err); ASSERT(t && count_rows(t, &err) == 1);
    for (int i = 0; i < 4; i++) { ASSERT(append_row(t, "n", 1, 1, &id, NULL, &err) == 0 && id == 6 + i); }
    table_close(t);
    t = table_open(test_dir, &schema, 0, &err); ASSERT(t && count_rows(t, &err) == 5);
    ASSERT(append_row(t, "n", 1, 1, &id, NULL, &err) == 0 && id == 10);
    table_close(t);
}

static void test_repair_of_last_record_does_not_reuse_its_id(void) {
    uint64_t offsets[3]; DbError err = {0}; int64_t id;
    ASSERT(populate(offsets, &err) == 0 && flip_byte(offsets[2] + 20) == 0);
    Table *t = table_open(test_dir, &schema, 1, &err); ASSERT(t); table_close(t);
    t = table_open(test_dir, &schema, 0, &err); ASSERT(t);
    ASSERT(append_row(t, "n", 1, 1, &id, NULL, &err) == 0 && id == 4);
    table_close(t);
}

static void test_repair_inside_a_statement_cuts_the_whole_statement(void) {
    DbError err = {0}; Table *t = fresh(&err); ASSERT(t);
    ASSERT(table_append_rows(t, statement_of(1, 1), 1, NULL, &err) == 0);
    uint64_t start; ASSERT(file_size(&start) == 0);
    ASSERT(table_append_rows(t, statement_of(4, 1), 4, NULL, &err) == 0);
    table_close(t);
    ASSERT(flip_byte(start + 33 + 20) == 0); /* second row of the second statement */
    ASSERT(table_open(test_dir, &schema, 0, &err) == NULL);
    t = table_open(test_dir, &schema, 1, &err);
    uint64_t after; ASSERT(t && count_rows(t, &err) == 1 && file_size(&after) == 0 && after == start + 29);
    int64_t id; ASSERT(append_row(t, "n", 1, 1, &id, NULL, &err) == 0 && id == 6);
    table_close(t);
}

static void test_id_floor_inside_cut_range_is_carried_over(void) {
    DbError err = {0}; Table *t = fresh(&err); uint64_t off[4]; int64_t id; ASSERT(t);
    for (int i = 0; i < 3; i++) ASSERT(append_row(t, "a", 1, 20, &id, &off[i], &err) == 0);
    table_close(t);
    unsigned char floor_rec[29]; make_meta(floor_rec, 2, 40);
    ASSERT(append_bytes(floor_rec, sizeof floor_rec) == 0);
    ASSERT(flip_byte(off[1] + 20) == 0); /* the cut starts at record 2 and includes the floor of 40 */
    t = table_open(test_dir, &schema, 1, &err); ASSERT(t);
    ASSERT(append_row(t, "n", 1, 1, &id, NULL, &err) == 0 && id == 41);
    table_close(t);
}

static void test_repair_ignores_corrupt_id_column_that_is_not_next_id(void) {
    uint64_t offsets[3]; DbError err = {0}; int64_t id;
    ASSERT(populate(offsets, &err) == 0);
    FILE *f = fopen(path, "r+b"); ASSERT(f && fseek(f, (long)offsets[2] + 12, SEEK_SET) == 0);
    unsigned char huge[8] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f}; /* id column becomes INT64_MAX, header check intact */
    ASSERT(fwrite(huge, 1, 8, f) == 8 && fclose(f) == 0);
    Table *t = table_open(test_dir, &schema, 1, &err); ASSERT(t); table_close(t);
    t = table_open(test_dir, &schema, 0, &err); ASSERT(t);
    ASSERT(append_row(t, "n", 1, 1, &id, NULL, &err) == 0 && id == 4); /* garbage id column ignored; id 3 was committed (its COMMIT is in the cut), so the next is 4 */
    table_close(t);
}

static void test_repair_keeps_ids_of_pending_rows_and_corrupt_row(void) {
    /* ids 1 / 2,3,4: the id 4 row is corrupt, rows 2,3 are pending. Id 4 was handed out. */
    DbError err = {0}; Table *t = fresh(&err); ASSERT(t); int64_t id;
    ASSERT(table_append_rows(t, statement_of(1, 1), 1, NULL, &err) == 0);
    uint64_t start; ASSERT(file_size(&start) == 0);
    ASSERT(table_append_rows(t, statement_of(3, 1), 3, NULL, &err) == 0);
    table_close(t);
    ASSERT(flip_byte(start + 2 * 33 + 20) == 0);
    t = table_open(test_dir, &schema, 1, &err); ASSERT(t && count_rows(t, &err) == 1);
    ASSERT(append_row(t, "n", 1, 1, &id, NULL, &err) == 0 && id >= 5);
    table_close(t);
}

static void test_repair_uses_commit_count_when_corrupt_row_header_is_unreadable(void) {
    /* The id 4 row has a broken length check, so its id is unreadable; the COMMIT (3 rows from id 2) still shows 4. */
    DbError err = {0}; Table *t = fresh(&err); ASSERT(t); int64_t id;
    ASSERT(table_append_rows(t, statement_of(1, 1), 1, NULL, &err) == 0);
    uint64_t start; ASSERT(file_size(&start) == 0);
    ASSERT(table_append_rows(t, statement_of(3, 1), 3, NULL, &err) == 0);
    table_close(t);
    ASSERT(flip_byte(start + 2 * 33 + 5) == 0);
    t = table_open(test_dir, &schema, 1, &err); ASSERT(t && count_rows(t, &err) == 1);
    ASSERT(append_row(t, "n", 1, 1, &id, NULL, &err) == 0 && id >= 5);
    table_close(t);
}

static void test_format_marker_and_partial_creation(void) {
    DbError err = {0}; Table *t = fresh(&err); ASSERT(t); table_close(t);
    unsigned char b[128]; size_t n;
    ASSERT(read_all(b, sizeof b, &n) == 0 && n == 29 && is_meta_at(b, 0, 3, 3));
    for (size_t cut = 1; cut < 29; cut++) {
        ASSERT(write_bytes(b, cut) == 0);
        t = table_open(test_dir, &schema, 0, &err); ASSERT(t); table_close(t);
        unsigned char actual[128]; size_t got;
        ASSERT(read_all(actual, sizeof actual, &got) == 0 && got == 29 && memcmp(actual, b, 29) == 0);
    }
}

static void test_legacy_file_refused_unchanged(void) {
    unsigned char old[3 * sizeof fixture];
    for (int i = 0; i < 3; i++) {
        unsigned char *r = old + i * sizeof fixture;
        memcpy(r, fixture, sizeof fixture); r[12] = (unsigned char)(i + 1);
        test_put32(r + 8, test_crc32(r + 12, sizeof fixture - 12));
    }
    for (int repair = 0; repair < 2; repair++) {
        ASSERT(write_bytes(old, sizeof old) == 0);
        DbError err = {0}; Table *t = table_open(test_dir, &schema, repair, &err);
        if (t) table_close(t);
        ASSERT(!t && err.kind == DB_ERROR_INTERNAL && strstr(err.message, "older or unknown format; it was not modified"));
        unsigned char actual[256]; size_t n;
        ASSERT(read_all(actual, sizeof actual, &n) == 0 && n == sizeof old && memcmp(actual, old, n) == 0);
    }
}

static void test_repair_interruption_preserves_id_floor(void) {
    for (int stage = 0; stage < 4; stage++) {
        DbError err = {0}; Table *t = fresh(&err); ASSERT(t); uint64_t offsets[5];
        for (int i = 0; i < 5; i++) ASSERT(append_row(t, "a", 1, 1, NULL, &offsets[i], &err) == 0);
        table_close(t); ASSERT(flip_byte(offsets[1] + 24) == 0);
        if (stage == 0) os_test_fail_truncate();       /* after durable sidecar */
        if (stage == 1) os_test_fail_sync_after(2);    /* after truncate */
        if (stage == 2) os_test_fail_append_after(2);  /* half ID_FLOOR */
        if (stage == 3) os_test_fail_sync_after(3);    /* full ID_FLOOR, before sidecar removal */
        t = table_open(test_dir, &schema, 1, &err);
        if (t) table_close(t);
        ASSERT(!t);
        /* If truncation itself failed, the original corruption still needs repair. */
        t = table_open(test_dir, &schema, stage == 0, &err); ASSERT(t);
        int64_t id; ASSERT(append_row(t, "new", 3, 1, &id, NULL, &err) == 0 && id >= 6);
        table_close(t);
        t = table_open(test_dir, &schema, 0, &err); ASSERT(t);
        ASSERT(append_row(t, "new", 3, 1, &id, NULL, &err) == 0 && id >= 7);
        table_close(t);
    }
}

static void test_idfloor_validation_and_replay_failures(void) {
    DbError err = {0}; Table *t = fresh(&err); ASSERT(t); table_close(t);
    char sidecar[300]; snprintf(sidecar, sizeof sidecar, "%s.idfloor", path);
    const char *invalid[] = {"", "idfloor 9 00000000\n", "idfloor -1 00000000\n",
        "idfloor 9223372036854775808 00000000\n", "idfloor 9 8d076785\nextra", "idfloor 9 8d076785"};
    for (size_t i = 0; i < sizeof invalid / sizeof *invalid; i++) {
        FILE *f = fopen(sidecar, "wb"); ASSERT(f);
        ASSERT(fputs(invalid[i], f) >= 0 && fclose(f) == 0);
        uint64_t before, after; ASSERT(file_size(&before) == 0);
        ASSERT(table_open(test_dir, &schema, 1, &err) == NULL && strstr(err.message, "sidecar"));
        ASSERT(file_size(&after) == 0 && after == before);
    }
    char line[96]; const unsigned char value[] = "40";
    snprintf(line, sizeof line, "idfloor 40 %08x\n", (unsigned)test_crc32(value, 2));
    FILE *f = fopen(sidecar, "wb"); ASSERT(f && fputs(line, f) >= 0 && fclose(f) == 0);
    os_test_fail_append();
    ASSERT(table_open(test_dir, &schema, 0, &err) == NULL);
    f = fopen(sidecar, "rb"); ASSERT(f); fclose(f); /* journal survives failed replay */
    t = table_open(test_dir, &schema, 0, &err); ASSERT(t);
    int64_t id; ASSERT(append_row(t, "a", 1, 1, &id, NULL, &err) == 0 && id == 41);
    table_close(t); ASSERT(fopen(sidecar, "rb") == NULL);
}

typedef struct { uint64_t deadline; int visited; } DeadlineScan;
static int wait_past_deadline(const Row *row, uint64_t off, void *ctx) {
    (void)row; (void)off;
    DeadlineScan *s = ctx; s->visited++;
    while (os_now_us() <= s->deadline) {}
    return 0;
}
static void test_scan_checks_deadline_between_blocks(void) {
    DbError err = {0}; Table *t = fresh(&err); ASSERT(t); table_set_sync(t, 0);
    ASSERT(table_append_rows(t, statement_of(40, 65536), 40, NULL, &err) == 0);
    ASSERT(table_read_lock(t) == 0);
    DeadlineScan s = {.deadline = os_now_us() + 10000}; int lost = 0;
    int rc = table_scan_deadline(t, wait_past_deadline, &s, &err, &lost, s.deadline);
    ASSERT(!lost && table_unlock(t) == 0);
    ASSERT(rc == -1 && err.kind == DB_ERROR_DEADLINE && s.visited > 0 && s.visited < 40);
    table_close(t);
}

int main(void) {
    test_dir_init("table");
    snprintf(path, sizeof path, "%s/task5_table.tbl", test_dir);
    RUN(test_format_marker_and_partial_creation);
    RUN(test_legacy_file_refused_unchanged);
    RUN(test_repair_interruption_preserves_id_floor);
    RUN(test_idfloor_validation_and_replay_failures);
    RUN(test_scan_checks_deadline_between_blocks);
    RUN(test_commit_record_follows_each_statement);
    RUN(test_failed_rollback_leaves_no_row_after_reopen_all_rows);
    RUN(test_failed_rollback_leaves_no_row_after_reopen_some_rows);
    RUN(test_big_statement_stopped_midway_is_cut_on_reopen);
    RUN(test_statement_without_commit_at_end_is_cut_and_earlier_kept);
    RUN(test_commit_count_mismatch_refuses_and_repair_cuts_statement);
    RUN(test_commit_without_rows_refused);
    RUN(test_id_floor_inside_unfinished_statement_refused);
    RUN(test_many_statements_reopen_and_visitor_sees_ordered_rows);
    RUN(test_open_visitor_gets_no_rows_of_unfinished_statement);
    RUN(test_sync_always_two_syncs_per_statement_and_none_when_off);
    RUN(test_commit_write_failure_rolls_back_statement);
    RUN(test_repair_writes_id_floor_that_survives_next_sessions);
    RUN(test_repair_of_last_record_does_not_reuse_its_id);
    RUN(test_repair_inside_a_statement_cuts_the_whole_statement);
    RUN(test_id_floor_inside_cut_range_is_carried_over);
    RUN(test_repair_ignores_corrupt_id_column_that_is_not_next_id);
    RUN(test_repair_keeps_ids_of_pending_rows_and_corrupt_row);
    RUN(test_repair_uses_commit_count_when_corrupt_row_header_is_unreadable);
    RUN(test_repair_backs_up_cut_bytes_and_skips_their_ids);
    RUN(test_repair_backup_failure_does_not_truncate);
    RUN(test_repair_without_later_valid_records_reports_none);
    RUN(test_failed_rollback_hides_unconfirmed_bytes);
    RUN(test_append_rows_batch_and_single_sync);
    RUN(test_block_payload_boundary_and_callback_failure);
    RUN(test_block_scan_open_callback_and_concurrency);
    RUN(test_append_reopen_scan);
    RUN(test_ids_continue_after_reopen);
    RUN(test_truncated_tail_recovered);
    RUN(test_partial_header_recovered);
    RUN(test_crc_mismatch_refuses);
    RUN(test_crc_mismatch_repair);
    RUN(test_complete_tail_crc_refuses);
    RUN(test_text_with_nul_roundtrip);
    RUN(test_text_too_long_error);
    RUN(test_empty_table_and_visitor_stop);
    RUN(test_partial_write_rolls_back);
    RUN(test_sync_failure_rolls_back);
    RUN(test_wire_format);
    RUN(test_invalid_length_refuses);
    RUN(test_bad_inputs_and_read_offsets);
    RUN(test_crc_valid_malformed_fields);
    RUN(test_id_exhaustion_after_reopen);
    RUN(test_record_size_limit);
    RUN(test_record_exact_size_boundary);
    RUN(test_concurrent_read_at);
    RUN(test_scan_yielding_lets_writer_in_and_keeps_snapshot);
    test_dir_clear();
    return test_finish();
}
