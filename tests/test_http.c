#include "test.h"
#include "http.h"
#include "os.h"
#include "result.h"
#include <stdint.h>

/* ---- http_parse ---- */
static void test_parse_post_query(void) {
    const char *raw = "POST /query HTTP/1.1\r\nHost: x\r\ncontent-LENGTH: 11\r\n\r\nSELECT 1;xx";
    HttpRequest r = {0};
    ASSERT(http_parse(raw, strlen(raw), &r) == 0);
    ASSERT(!strcmp(r.method, "POST") && !strcmp(r.path, "/query"));
    ASSERT(r.body_len == 11 && !memcmp(r.body, "SELECT 1;xx", 11) && r.body[11] == '\0');
    http_request_free(&r);
}
static void test_parse_get_health(void) {
    const char *raw = "GET /health HTTP/1.1\r\nHost: x\r\n\r\n";
    HttpRequest r = {0};
    ASSERT(http_parse(raw, strlen(raw), &r) == 0);
    ASSERT(!strcmp(r.method, "GET") && !strcmp(r.path, "/health") && r.body_len == 0);
    http_request_free(&r);
}
static void test_missing_content_length_400(void) {
    const char *raw = "POST /query HTTP/1.1\r\nHost: x\r\n\r\nSELECT 1;";
    HttpRequest r = {0};
    ASSERT(http_parse(raw, strlen(raw), &r) == 400);
}
static void test_body_too_large_413(void) {
    const char *raw = "POST /query HTTP/1.1\r\nContent-Length: 1048577\r\n\r\n";
    HttpRequest r = {0};
    ASSERT(http_parse(raw, strlen(raw), &r) == 413);
    raw = "POST /query HTTP/1.1\r\nContent-Length: 1048576\r\n\r\nabc";
    ASSERT(http_parse(raw, strlen(raw), &r) == HTTP_NEED_MORE);
}
static void test_partial_header_needs_more(void) {
    const char *raw = "POST /query HTTP/1.1\r\nContent-Len";
    HttpRequest r = {0};
    ASSERT(http_parse(raw, strlen(raw), &r) == HTTP_NEED_MORE);
    ASSERT(http_parse("", 0, &r) == HTTP_NEED_MORE);
}
static void test_partial_body_needs_more(void) {
    const char *raw = "POST /query HTTP/1.1\r\nContent-Length: 10\r\n\r\nabc";
    HttpRequest r = {0};
    ASSERT(http_parse(raw, strlen(raw), &r) == HTTP_NEED_MORE);
}
static void test_malformed_requests_400(void) {
    HttpRequest r = {0};
    const char *bad[] = {
        "POST /query\r\nContent-Length: 0\r\n\r\n",
        "POST /query HTTP/2.0\r\nContent-Length: 0\r\n\r\n",
        "POST /query HTTP/1.1\r\nContent-Length: abc\r\n\r\n",
        "POST /query HTTP/1.1\r\nContent-Length: -1\r\n\r\n",
        "POST /query HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nab",
        "POST /query HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n",
        "POST /query HTTP/1.1\r\nBadHeaderLine\r\n\r\n",
        "GETTOOLONGMETHOD /x HTTP/1.1\r\n\r\n",
        "GET /health HTTP/1.1\r\nContent-Length: 3\r\n\r\nabc",
    };
    for (size_t i = 0; i < sizeof bad / sizeof bad[0]; i++) {
        int rc = http_parse(bad[i], strlen(bad[i]), &r);
        if (rc != 400) { fprintf(stderr, "case %zu returned %d\n", i, rc); }
        ASSERT(rc == 400);
    }
}
static void test_header_without_end_over_limit_400(void) {
    char big[HTTP_MAX_HEADER + 64]; HttpRequest r = {0};
    memset(big, 'a', sizeof big);
    memcpy(big, "GET /", 5);
    ASSERT(http_parse(big, sizeof big, &r) == 400);
}

/* ---- JSON ---- */
static Value int_value(int64_t v) { Value x = {0}; x.type = TYPE_INT; x.i = v; return x; }
static Value text_value(const char *bytes, uint32_t len) {
    Value x = {0}; x.type = TYPE_TEXT; x.s = malloc(len ? len : 1); x.len = len;
    if (len) memcpy(x.s, bytes, len);
    return x;
}
static char *dup_str(const char *s) { size_t n = strlen(s) + 1; char *p = malloc(n); memcpy(p, s, n); return p; }

/* A result with one SELECT of columns (id, name) and the given name bytes. */
static void select_result(Result *out, const char *name, uint32_t name_len) {
    *out = (Result){.ok = 1, .failed_index = SIZE_MAX};
    out->items = calloc(1, sizeof *out->items); out->n = 1; out->committed = 1;
    StmtResult *s = &out->items[0];
    s->is_select = 1; s->ncols = 2; s->columns = calloc(2, sizeof *s->columns);
    s->columns[0] = dup_str("id"); s->columns[1] = dup_str("name");
    s->rows = calloc(2, sizeof *s->rows); s->nrows = 1;
    s->rows[0] = int_value(7); s->rows[1] = text_value(name, name_len);
    s->plan = PLAN_INDEX; s->rows_examined = 1; s->elapsed_us = 21;
}
static void test_json_select_shape(void) {
    Result r; char *json; size_t len;
    select_result(&r, "user_7", 6); r.elapsed_us = 99;
    ASSERT(result_to_json(&r, 3, &json, &len) == 0);
    ASSERT(len == strlen(json));
    ASSERT(!strcmp(json, "{\"ok\":true,\"results\":[{\"columns\":[\"id\",\"name\"],\"rows\":[[7,\"user_7\"]],"
                         "\"plan\":\"index\",\"rows_examined\":1,\"inserted_ids\":[]}],\"elapsed_us\":99,\"worker\":3}"));
    ASSERT(result_http_status(&r) == 200);
    free(json); result_free(&r);
}
static void test_json_insert_shape(void) {
    Result r = {.ok = 1, .failed_index = SIZE_MAX}; char *json; size_t len;
    r.items = calloc(1, sizeof *r.items); r.n = 1; r.committed = 1;
    r.items[0].inserted_ids = malloc(2 * sizeof(int64_t));
    r.items[0].inserted_ids[0] = 4; r.items[0].inserted_ids[1] = 5; r.items[0].ninserted = 2;
    ASSERT(result_to_json(&r, 0, &json, &len) == 0);
    ASSERT(strstr(json, "\"columns\":[],\"rows\":[],\"plan\":\"none\",\"rows_examined\":0,\"inserted_ids\":[4,5]"));
    free(json); result_free(&r);
}
static void test_json_escape(void) {
    /* NUL, quote, backslash, control chars, invalid UTF-8, valid UTF-8 */
    static const char raw[] = "a\0b\"c\\d\n\x01\x1f" "e\xff" "f\xc3\x28" "g\xe2\x82" "h\xed\xa0\x80" "i\xc0\xaf" "j\xea\xb0\x80";
    Result r; char *json; size_t len;
    select_result(&r, raw, (uint32_t)(sizeof raw - 1));
    ASSERT(result_to_json(&r, 0, &json, &len) == 0);
    ASSERT(strstr(json, "a\\u0000b\\\"c\\\\d\\u000a\\u0001\\u001fe\\ufffdf\\ufffd(g\\ufffd\\ufffdh"
                        "\\ufffd\\ufffd\\ufffdi\\ufffd\\ufffdj\xea\xb0\x80\""));
    for (size_t i = 0; i < len; i++) ASSERT((unsigned char)json[i] >= 0x20);
    free(json); result_free(&r);
}
static void test_json_empty_text_and_utf8_passthrough(void) {
    Result r; char *json; size_t len;
    select_result(&r, "", 0);
    ASSERT(result_to_json(&r, 0, &json, &len) == 0);
    ASSERT(strstr(json, "[[7,\"\"]]"));
    free(json); result_free(&r);
    select_result(&r, "\xed\x95\x9c\xea\xb8\x80\xf0\x9f\x98\x80", 10);
    ASSERT(result_to_json(&r, 0, &json, &len) == 0);
    ASSERT(strstr(json, "\"\xed\x95\x9c\xea\xb8\x80\xf0\x9f\x98\x80\""));
    free(json); result_free(&r);
}
static void test_error_json_has_line_col_committed(void) {
    Result r = {.ok = 0, .failed_index = 1, .committed = 1}; char *json; size_t len;
    r.items = calloc(1, sizeof *r.items); r.n = 1;
    r.items[0].inserted_ids = malloc(sizeof(int64_t)); r.items[0].inserted_ids[0] = 1; r.items[0].ninserted = 1;
    r.err.kind = DB_ERROR_SQL; r.err.line = 3; r.err.col = 14;
    snprintf(r.err.message, sizeof r.err.message, "expected \"VALUES\"");
    ASSERT(result_to_json(&r, 2, &json, &len) == 0);
    ASSERT(!strcmp(json, "{\"ok\":false,\"error\":{\"statement\":1,\"line\":3,\"col\":14,"
                         "\"message\":\"expected \\\"VALUES\\\"\"},\"committed\":1}"));
    ASSERT(result_http_status(&r) == 400);
    free(json);
    r.err.kind = DB_ERROR_INTERNAL; r.err.line = 0; r.err.col = 0;
    ASSERT(result_http_status(&r) == 500);
    ASSERT(result_to_json(&r, 2, &json, &len) == 0);
    ASSERT(strstr(json, "\"line\":0,\"col\":0") && strstr(json, "\"committed\":1}"));
    free(json); result_free(&r);
}

/* ---- sockets ---- */
typedef struct { SOCKET_T listener, client, server; } Pair;
static int make_pair(Pair *p) {
    uint16_t port = 0;
    p->listener = os_sock_listen(0, 4, &port);
    if (p->listener == OS_INVALID_SOCKET || !port) return -1;
    p->client = os_sock_connect_local(port);
    if (p->client == OS_INVALID_SOCKET) return -1;
    p->server = os_sock_accept(p->listener);
    return p->server == OS_INVALID_SOCKET ? -1 : 0;
}
static void close_pair(Pair *p) { os_sock_close(p->client); os_sock_close(p->server); os_sock_close(p->listener); }
static int send_all(SOCKET_T s, const char *data, size_t n) {
    return os_sock_send(s, data, n, os_now_us() + 2000000) == (int64_t)n ? 0 : -1;
}

#define send_lit(s, lit) send_all((s), (lit), sizeof(lit) - 1)

static void test_read_request_over_socket(void) {
    Pair p; HttpRequest r = {0};
    ASSERT(make_pair(&p) == 0);
    ASSERT(send_lit(p.client, "POST /query HTTP/1.1\r\nContent-Le") == 0);
    ASSERT(send_lit(p.client, "ngth: 8\r\n\r\nSELE") == 0);
    ASSERT(send_lit(p.client, "CT 1;") == 0);
    ASSERT(http_read_request(p.server, &r, os_now_us() + 2000000) == 0);
    ASSERT(!strcmp(r.path, "/query") && r.body_len == 8 && !memcmp(r.body, "SELECT 1", 8));
    http_request_free(&r); close_pair(&p);
}
static void test_read_request_timeout_408(void) {
    Pair p; HttpRequest r = {0}; uint64_t t0;
    ASSERT(make_pair(&p) == 0);
    ASSERT(send_lit(p.client, "POST /query HTTP/1.1\r\n") == 0);
    t0 = os_now_us();
    ASSERT(http_read_request(p.server, &r, t0 + 200000) == 408);
    ASSERT(os_now_us() - t0 < 1500000);
    close_pair(&p);
}
static void test_read_request_closed_early_400(void) {
    Pair p; HttpRequest r = {0};
    ASSERT(make_pair(&p) == 0);
    ASSERT(send_lit(p.client, "POST /query HTTP/1.1\r\n") == 0);
    os_sock_close(p.client); p.client = OS_INVALID_SOCKET;
    ASSERT(http_read_request(p.server, &r, os_now_us() + 2000000) == 400);
    close_pair(&p);
}
static void test_read_request_413_before_body(void) {
    Pair p; HttpRequest r = {0};
    ASSERT(make_pair(&p) == 0);
    ASSERT(send_lit(p.client, "POST /query HTTP/1.1\r\nContent-Length: 2000000\r\n\r\n") == 0);
    ASSERT(http_read_request(p.server, &r, os_now_us() + 2000000) == 413);
    close_pair(&p);
}
static void test_send_roundtrip(void) {
    Pair p; char buf[512]; size_t got = 0; const char *body = "{\"ok\":true}";
    ASSERT(make_pair(&p) == 0);
    ASSERT(http_send(p.server, 200, body, strlen(body), os_now_us() + 2000000) == 0);
    os_sock_close(p.server); p.server = OS_INVALID_SOCKET;
    for (;;) {
        int64_t n = os_sock_recv(p.client, buf + got, sizeof buf - 1 - got, os_now_us() + 2000000);
        if (n <= 0) break;
        got += (size_t)n;
    }
    buf[got] = '\0';
    ASSERT(!strncmp(buf, "HTTP/1.1 200 OK\r\n", 17));
    ASSERT(strstr(buf, "Content-Type: application/json\r\n") && strstr(buf, "Content-Length: 11\r\n"));
    ASSERT(strstr(buf, "Connection: close\r\n"));
    ASSERT(!strcmp(buf + got - 11, body));
    close_pair(&p);
}

int main(void) {
    if (os_init()) return 1;
    RUN(test_parse_post_query); RUN(test_parse_get_health); RUN(test_missing_content_length_400);
    RUN(test_body_too_large_413); RUN(test_partial_header_needs_more); RUN(test_partial_body_needs_more);
    RUN(test_malformed_requests_400); RUN(test_header_without_end_over_limit_400);
    RUN(test_json_select_shape); RUN(test_json_insert_shape); RUN(test_json_escape);
    RUN(test_json_empty_text_and_utf8_passthrough); RUN(test_error_json_has_line_col_committed);
    RUN(test_read_request_over_socket); RUN(test_read_request_timeout_408);
    RUN(test_read_request_closed_early_400); RUN(test_read_request_413_before_body);
    RUN(test_send_roundtrip);
    os_cleanup(); return test_finish();
}
