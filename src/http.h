#ifndef MINI_DBMS_HTTP_H
#define MINI_DBMS_HTTP_H

#include "os.h"
#include <stddef.h>
#include <stdint.h>

#define HTTP_MAX_HEADER 8192u
#define HTTP_MAX_BODY (1024u * 1024u)
#define HTTP_NEED_MORE (-1)

typedef struct { char method[8]; char path[128]; char *body; size_t body_len; size_t extra_bytes; } HttpRequest;

/* Parse one request from buf. 0 = complete (body is a NUL-terminated copy,
 * free with http_request_free), HTTP_NEED_MORE = incomplete, otherwise the
 * status to send (400 malformed, 413 body over HTTP_MAX_BODY). POST needs
 * Content-Length; GET and others must not send a body. Bytes after the body
 * are ignored but counted in extra_bytes, so the server can close gracefully
 * (Connection: close, one request per connection). A line ended by LF alone is 400. */
int http_parse(const char *buf, size_t n, HttpRequest *req);
void http_request_free(HttpRequest *req);

/* Read from s until a request is complete. 0 = ok, else status to send:
 * 400 malformed or closed early, 408 deadline passed, 413 body too large. */
int http_read_request(SOCKET_T s, HttpRequest *req, uint64_t deadline_us);
/* Send a JSON response with Connection: close. 0 = sent, -1 = failed or late. */
int http_send(SOCKET_T s, int status, const char *json, size_t len, uint64_t deadline_us);

#endif
