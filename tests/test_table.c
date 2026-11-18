#include "test.h"
#include "table.h"
#include "os.h"
#include <limits.h>
#include <pthread.h>

static const char *path = "build/task5_table.tbl";
static const TableSchema schema = {
    .name = "task5_table", .cols = {{"id", TYPE_INT}, {"name", TYPE_TEXT}, {"age", TYPE_INT}}, .ncols = 3
};

static Table *fresh(DbError *err) {
    remove(path);
    return table_open("build", &schema, 0, err);
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
    Table *t = table_open("build", &schema, 0, &err);
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
    Table *t = table_open("build", &schema, 0, &err);
    ASSERT(t && append_row(t, "d", 1, 23, &id, &off, &err) == 0);
    ASSERT(id == 4 && off == end);
    table_close(t);
}

static void test_truncated_tail_recovered(void) {
    uint64_t offsets[3], end, size; DbError err = {0}; int64_t id;
    ASSERT(populate(offsets, &err) == 0 && file_size(&end) == 0 && truncate_to(end - 5) == 0);
    Table *t = table_open("build", &schema, 0, &err);
    ASSERT(t && file_size(&size) == 0 && size == offsets[2]);
    Scan s = {.ok = 1};
    ASSERT(table_scan(t, visit, &s, &err) == 0 && s.ok && s.count == 2);
    ASSERT(append_row(t, "c", 1, 22, &id, NULL, &err) == 0 && id == 3);
    table_close(t);
}

static void test_partial_header_recovered(void) {
    uint64_t offsets[3], size; DbError err = {0};
    for (uint64_t n = 1; n < 8; n++) {
        ASSERT(populate(offsets, &err) == 0 && truncate_to(offsets[2] + n) == 0);
        Table *t = table_open("build", &schema, 0, &err);
        ASSERT(t && file_size(&size) == 0 && size == offsets[2]);
        table_close(t);
    }
}

static void test_crc_mismatch_refuses(void) {
    uint64_t offsets[3], before, after; DbError err = {0}; char expected[32];
    ASSERT(populate(offsets, &err) == 0 && file_size(&before) == 0);
    ASSERT(flip_byte(offsets[1] + 20) == 0);
    Table *t = table_open("build", &schema, 0, &err);
    snprintf(expected, sizeof expected, "%llu", (unsigned long long)offsets[1]);
    ASSERT(t == NULL && strstr(err.message, "CRC") && strstr(err.message, expected));
    ASSERT(file_size(&after) == 0 && after == before);
}

static void test_crc_mismatch_repair(void) {
    uint64_t offsets[3], size; DbError err = {0}; int64_t id;
    ASSERT(populate(offsets, &err) == 0 && flip_byte(offsets[1] + 20) == 0);
    Table *t = table_open("build", &schema, 1, &err);
    ASSERT(t && file_size(&size) == 0 && size == offsets[1]);
    Scan s = {.ok = 1};
    ASSERT(table_scan(t, visit, &s, &err) == 0 && s.count == 1 && s.ok);
    ASSERT(append_row(t, "b", 1, 21, &id, NULL, &err) == 0 && id == 2);
    table_close(t);
}

static void test_complete_tail_crc_refuses(void) {
    uint64_t offsets[3], before, after; DbError err = {0};
    ASSERT(populate(offsets, &err) == 0 && file_size(&before) == 0 && flip_byte(offsets[2] + 20) == 0);
    ASSERT(table_open("build", &schema, 0, &err) == NULL && strstr(err.message, "CRC"));
    ASSERT(file_size(&after) == 0 && before == after);
}

static void test_text_with_nul_roundtrip(void) {
    char text[] = {'a', '\0', '\'', '\\', (char)0xff, 'z'}; DbError err = {0}; uint64_t off;
    Table *t = fresh(&err); Row row = {0};
    ASSERT(t && append_row(t, text, sizeof text, INT64_MIN, NULL, &off, &err) == 0);
    table_close(t); t = table_open("build", &schema, 0, &err);
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
    ASSERT(file_size(&size) == 0 && size == 0);
    ASSERT(append_row(t, text, 65536, INT64_MAX, &id, NULL, &err) == 0 && id == 1);
    Row row = {0}; ASSERT(table_read_at(t, 0, &row, &err) == 0);
    ASSERT(row.fields[1].len == 65536 && memcmp(row.fields[1].s, text, 65536) == 0 && row.fields[2].i == INT64_MAX);
    row_free(&row); free(text); table_close(t);
}

static void test_empty_table_and_visitor_stop(void) {
    DbError err = {0}; Table *t = fresh(&err); Scan s = {.ok = 1};
    ASSERT(t && table_scan(t, visit, &s, &err) == 0 && s.count == 0);
    ASSERT(append_row(t, NULL, 0, 20, NULL, NULL, &err) == 0);
    Row row = {0}; ASSERT(table_read_at(t, 0, &row, &err) == 0 && row.fields[1].len == 0);
    row_free(&row); table_close(t);
    uint64_t offsets[3]; ASSERT(populate(offsets, &err) == 0);
    t = table_open("build", &schema, 0, &err); s = (Scan){.ok = 1, .stop = 7};
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
    table_close(t); t = table_open("build", &schema, 0, &err); Scan s = {.ok = 1};
    ASSERT(t && table_scan(t, visit, &s, &err) == 0 && s.ok && s.count == 2);
    table_close(t);
}

static void test_sync_failure_rolls_back(void) {
    DbError err = {0}; uint64_t size; int64_t id = -1;
    Table *t = fresh(&err); ASSERT(t); os_test_fail_sync();
    ASSERT(append_row(t, "bad", 3, 0, &id, NULL, &err) == -1 && err.message[0] && id == -1);
    ASSERT(file_size(&size) == 0 && size == 0);
    table_close(t); t = table_open("build", &schema, 0, &err);
    ASSERT(t && append_row(t, "a", 1, 20, &id, NULL, &err) == 0 && id == 1);
    table_close(t);
}

/* Independent little-endian fixture; CRC32/IEEE for id=1, TEXT='a', INT=-2. */
static const unsigned char fixture[] = {
    21,0,0,0, 0x9c,0x0a,0x9c,0xc0,
    1,0,0,0,0,0,0,0, 1,0,0,0,'a', 0xfe,0xff,0xff,0xff,0xff,0xff,0xff,0xff
};
static int write_bytes(const unsigned char *bytes, size_t len) {
    FILE *f = fopen(path, "wb"); if (!f) return -1;
    int ok = fwrite(bytes, 1, len, f) == len;
    if (fclose(f)) ok = 0;
    return ok ? 0 : -1;
}

static void test_wire_format(void) {
    DbError err = {0}; unsigned char bytes[sizeof fixture];
    Table *t = fresh(&err); ASSERT(t && append_row(t, "a", 1, -2, NULL, NULL, &err) == 0);
    table_close(t);
    FILE *f = fopen(path, "rb"); ASSERT(f);
    ASSERT(fread(bytes, 1, sizeof bytes, f) == sizeof bytes && fgetc(f) == EOF);
    ASSERT(fclose(f) == 0 && memcmp(bytes, fixture, sizeof bytes) == 0);
    ASSERT(write_bytes(fixture, sizeof fixture) == 0);
    t = table_open("build", &schema, 0, &err); Row row = {0};
    ASSERT(t && table_read_at(t, 0, &row, &err) == 0 && row.id == 1 && row.fields[2].i == -2);
    row_free(&row); table_close(t);
}

static void test_invalid_length_refuses(void) {
    DbError err = {0}; uint64_t size;
    unsigned char bad[sizeof fixture]; memcpy(bad, fixture, sizeof bad); memset(bad, 0xff, 4);
    ASSERT(write_bytes(bad, sizeof bad) == 0);
    ASSERT(table_open("build", &schema, 0, &err) == NULL && strstr(err.message, "offset 0"));
    ASSERT(file_size(&size) == 0 && size == sizeof bad);
    Table *t = table_open("build", &schema, 1, &err);
    ASSERT(t && file_size(&size) == 0 && size == 0); table_close(t);
    memset(bad, 0, 4); ASSERT(write_bytes(bad, sizeof bad) == 0);
    ASSERT(table_open("build", &schema, 0, &err) == NULL);
}

static void test_bad_inputs_and_read_offsets(void) {
    DbError err = {0}; Table *t = fresh(&err); Row row = {0}; uint64_t size;
    ASSERT(t); Value wrong[] = {{.type = TYPE_INT}, {.type = TYPE_INT}};
    ASSERT(table_append(t, wrong, NULL, NULL, &err) == -1 && err.message[0]);
    ASSERT(append_row(t, NULL, 1, 0, NULL, NULL, &err) == -1);
    ASSERT(file_size(&size) == 0 && size == 0);
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
    memcpy(bad + 4, crc, sizeof crc); bad[16] = 2;
    DbError err = {0}; uint64_t size;
    ASSERT(write_bytes(bad, sizeof bad) == 0);
    ASSERT(table_open("build", &schema, 0, &err) == NULL && strstr(err.message, "fields"));
    ASSERT(file_size(&size) == 0 && size == sizeof bad);
    Table *t = table_open("build", &schema, 1, &err);
    ASSERT(t && file_size(&size) == 0 && size == 0); table_close(t);
}

static void test_id_exhaustion_after_reopen(void) {
    unsigned char max_id[sizeof fixture]; memcpy(max_id, fixture, sizeof max_id);
    const unsigned char crc[] = {0xd6, 0x52, 0xde, 0x54};
    memcpy(max_id + 4, crc, sizeof crc);
    memset(max_id + 8, 0xff, 7); max_id[15] = 0x7f;
    DbError err = {0}; uint64_t size; int64_t id = -1; Row row = {0};
    ASSERT(write_bytes(max_id, sizeof max_id) == 0);
    Table *t = table_open("build", &schema, 0, &err);
    ASSERT(t && table_read_at(t, 0, &row, &err) == 0 && row.id == INT64_MAX);
    row_free(&row);
    ASSERT(append_row(t, "a", 1, 20, &id, NULL, &err) == -1 && id == -1 && strstr(err.message, "id"));
    ASSERT(file_size(&size) == 0 && size == sizeof max_id); table_close(t);
}

static void test_record_size_limit(void) {
    TableSchema wide = {.name = "task5_table", .cols = {{"id", TYPE_INT}}, .ncols = 32};
    Value fields[31] = {0}; char *text = malloc(65536); ASSERT(text); memset(text, 'x', 65536);
    for (int i = 0; i < 31; i++) {
        wide.cols[i + 1].type = TYPE_TEXT;
        fields[i] = (Value){.type = TYPE_TEXT, .s = text, .len = 65536};
    }
    remove(path); DbError err = {0}; uint64_t size;
    Table *t = table_open("build", &wide, 0, &err); ASSERT(t);
    ASSERT(table_append(t, fields, NULL, NULL, &err) == -1 && err.message[0]);
    ASSERT(file_size(&size) == 0 && size == 0);
    table_close(t); free(text);
}

static void test_record_exact_size_boundary(void) {
    TableSchema wide = {.name = "task5_table", .cols = {{"id", TYPE_INT}}, .ncols = 17};
    Value fields[16] = {0}; char *text = malloc(65536); ASSERT(text); memset(text, 'x', 65536);
    for (int i = 0; i < 16; i++) {
        wide.cols[i + 1].type = TYPE_TEXT;
        fields[i] = (Value){.type = TYPE_TEXT, .s = text, .len = 65536};
    }
    /* 8-byte header + 8-byte id + 16 length prefixes + TEXT = exactly 1 MiB. */
    fields[15].len = 65456;
    remove(path); DbError err = {0}; uint64_t size; int64_t id = -1;
    Table *t = table_open("build", &wide, 0, &err); ASSERT(t);
    ASSERT(table_append(t, fields, &id, NULL, &err) == 0 && id == 1);
    ASSERT(file_size(&size) == 0 && size == 1024 * 1024);
    fields[15].len++;
    ASSERT(table_append(t, fields, &id, NULL, &err) == -1 && id == 1);
    ASSERT(file_size(&size) == 0 && size == 1024 * 1024);
    table_close(t); t = table_open("build", &wide, 0, &err); Row row = {0};
    ASSERT(t && table_read_at(t, 0, &row, &err) == 0 && row.n == 17 && row.fields[16].len == 65456);
    for (int i = 1; i < row.n; i++) ASSERT(memcmp(row.fields[i].s, text, row.fields[i].len) == 0);
    row_free(&row); table_close(t); free(text);
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
    Table *t = table_open("build", &schema, 0, &err); ASSERT(t);
    for (int i = 0; i < 8; i++) {
        readers[i] = (Reader){t, offsets[i % 3], i % 3 + 1, 0};
        ASSERT(pthread_create(&threads[i], NULL, read_many, &readers[i]) == 0);
    }
    for (int i = 0; i < 8; i++) ASSERT(pthread_join(threads[i], NULL) == 0 && readers[i].ok);
    table_close(t);
}

int main(void) {
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
    remove(path);
    return test_finish();
}
