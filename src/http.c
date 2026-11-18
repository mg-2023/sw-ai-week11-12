#include "http.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ASCII case-insensitive compare of len bytes. */
static int ieq(const char *a, const char *b, size_t len) {
    for (size_t i = 0; i < len; i++) {
        char x = a[i], y = b[i];
        if (x >= 'A' && x <= 'Z') x = (char)(x + 32);
        if (y >= 'A' && y <= 'Z') y = (char)(y + 32);
        if (x != y) return 0;
    }
    return 1;
}

/* Index of the first CRLF CRLF whose end is within the header limit, or -1. */
static long find_header_end(const char *buf, size_t n) {
    size_t limit = n < HTTP_MAX_HEADER ? n : HTTP_MAX_HEADER;
    for (size_t i = 0; i + 4 <= limit; i++)
        if (buf[i] == '\r' && buf[i + 1] == '\n' && buf[i + 2] == '\r' && buf[i + 3] == '\n') return (long)i;
    return -1;
}

/* 1 if buf[0..n) holds an LF that no CR precedes. */
static int has_bare_lf(const char *buf, size_t n) {
    for (size_t i = 0; i < n; i++)
        if (buf[i] == '\n' && (i == 0 || buf[i - 1] != '\r')) return 1;
    return 0;
}

/* METHOD SP path SP HTTP/1.x ; 0 ok, -1 malformed. */
static int parse_request_line(const char *line, size_t len, HttpRequest *req) {
    const char *sp1 = memchr(line, ' ', len);
    if (!sp1 || sp1 == line || (size_t)(sp1 - line) >= sizeof req->method) return -1;
    const char *path = sp1 + 1;
    const char *sp2 = memchr(path, ' ', len - (size_t)(path - line));
    if (!sp2 || sp2 == path || (size_t)(sp2 - path) >= sizeof req->path) return -1;
    const char *ver = sp2 + 1;
    size_t ver_len = len - (size_t)(ver - line);
    if (ver_len != 8 || (memcmp(ver, "HTTP/1.1", 8) && memcmp(ver, "HTTP/1.0", 8))) return -1;
    for (const char *c = line; c < sp1; c++) if (*c < 'A' || *c > 'Z') return -1;
    for (const char *c = path; c < sp2; c++) if ((unsigned char)*c <= 0x20 || *c == 0x7f) return -1;
    memcpy(req->method, line, (size_t)(sp1 - line)); req->method[sp1 - line] = '\0';
    memcpy(req->path, path, (size_t)(sp2 - path)); req->path[sp2 - path] = '\0';
    return 0;
}

/* Digits only. Returns the value, or UINT64_MAX when empty, not numeric, or larger than 18 digits. */
static uint64_t parse_length(const char *v, size_t len) {
    while (len && (*v == ' ' || *v == '\t')) { v++; len--; }
    while (len && (v[len - 1] == ' ' || v[len - 1] == '\t')) len--;
    if (!len) return UINT64_MAX;
    uint64_t value = 0;
    for (size_t i = 0; i < len; i++) {
        if (v[i] < '0' || v[i] > '9') return UINT64_MAX;
        if (i >= 18) return UINT64_MAX - 1;   /* too long : treated as huge */
        value = value * 10 + (uint64_t)(v[i] - '0');
    }
    return value;
}

int http_parse(const char *buf, size_t n, HttpRequest *req) {
    long end = find_header_end(buf, n);
    if (has_bare_lf(buf, end < 0 ? (n < HTTP_MAX_HEADER ? n : HTTP_MAX_HEADER) : (size_t)end + 4)) return 400;
    if (end < 0) return n >= HTTP_MAX_HEADER ? 400 : HTTP_NEED_MORE;
    size_t header_len = (size_t)end + 4;
    const char *p = buf, *stop = buf + end;
    HttpRequest tmp = {0};

    const char *eol = memchr(p, '\r', (size_t)(stop - p) + 1);
    if (!eol || eol[1] != '\n' || parse_request_line(p, (size_t)(eol - p), &tmp)) return 400;
    p = eol + 2;

    int have_length = 0; uint64_t length = 0;
    while (p < stop + 2) {
        eol = memchr(p, '\r', (size_t)(stop + 2 - p));
        if (!eol || eol == p) break;
        if (eol[1] != '\n') return 400;
        const char *colon = memchr(p, ':', (size_t)(eol - p));
        if (!colon || colon == p) return 400;
        for (const char *c = p; c < colon; c++) if ((unsigned char)*c <= 0x20) return 400;
        size_t name_len = (size_t)(colon - p);
        if (name_len == 14 && ieq(p, "content-length", 14)) {
            if (have_length) return 400;
            have_length = 1;
            length = parse_length(colon + 1, (size_t)(eol - colon - 1));
            if (length == UINT64_MAX) return 400;
        } else if (name_len == 17 && ieq(p, "transfer-encoding", 17)) {
            return 400;
        }
        p = eol + 2;
    }

    int is_post = !strcmp(tmp.method, "POST");
    if (is_post && !have_length) return 400;
    if (!is_post && have_length && length != 0) return 400;
    if (length > HTTP_MAX_BODY) return 413;
    if (n < header_len + (size_t)length) return HTTP_NEED_MORE;

    tmp.body = malloc((size_t)length + 1);
    if (!tmp.body) return 500;
    memcpy(tmp.body, buf + header_len, (size_t)length);
    tmp.body[length] = '\0';
    tmp.body_len = (size_t)length;
    tmp.extra_bytes = n - header_len - (size_t)length;
    *req = tmp;
    return 0;
}

void http_request_free(HttpRequest *req) {
    if (!req) return;
    free(req->body);
    req->body = NULL; req->body_len = 0;
}

int http_read_request(SOCKET_T s, HttpRequest *req, uint64_t deadline_us) {
    size_t cap = 4096, n = 0, max_cap = HTTP_MAX_HEADER + HTTP_MAX_BODY;
    char *buf = malloc(cap);
    int status = 500;
    if (!buf) return 500;
    for (;;) {
        int rc = http_parse(buf, n, req);
        if (rc != HTTP_NEED_MORE) { status = rc; break; }
        if (n == cap) {
            if (cap >= max_cap) { status = 400; break; }
            size_t next = cap * 2 > max_cap ? max_cap : cap * 2;
            char *bigger = realloc(buf, next);
            if (!bigger) { status = 500; break; }
            buf = bigger; cap = next;
        }
        int64_t got = os_sock_recv(s, buf + n, cap - n, deadline_us);
        if (got == OS_SOCK_TIMEOUT) { status = 408; break; }
        if (got <= 0) { status = 400; break; }
        n += (size_t)got;
    }
    free(buf);
    return status;
}

/* Reason phrase for the few statuses this server sends. */
static const char *reason(int status) {
    switch (status) {
    case 200: return "OK";
    case 400: return "Bad Request";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 408: return "Request Timeout";
    case 413: return "Payload Too Large";
    case 500: return "Internal Server Error";
    case 503: return "Service Unavailable";
    default: return "Error";
    }
}

int http_send(SOCKET_T s, int status, const char *json, size_t len, uint64_t deadline_us) {
    char head[256];
    int head_len = snprintf(head, sizeof head,
        "HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n",
        status, reason(status), len);
    if (head_len < 0 || (size_t)head_len >= sizeof head) return -1;
    size_t total = (size_t)head_len + len, sent = 0;
    char *out = malloc(total);   /* one buffer : one send, no small-packet delay */
    if (!out) return -1;
    memcpy(out, head, (size_t)head_len);
    if (len) memcpy(out + head_len, json, len);
    while (sent < total) {
        int64_t k = os_sock_send(s, out + sent, total - sent, deadline_us);
        if (k <= 0) { free(out); return -1; }
        sent += (size_t)k;
    }
    free(out);
    return 0;
}
