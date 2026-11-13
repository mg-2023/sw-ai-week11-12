#include "net.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define REPORT "{\"orders\":12,\"total_cents\":4200}"
#define CACHE_KEY "$13\r\nsample-report\r\n"

enum { REPORT_MAX = 1024, HTTP_HEADER_MAX = 8192 };
static const char cache_get[] = "*2\r\n$3\r\nGET\r\n" CACHE_KEY;

static bool read_exact(Socket fd, char *data, size_t length) {
    while (length) {
        int received = net_recv(fd, data, length);
        if (received <= 0) {
            return false;
        }
        data += received;
        length -= (size_t)received;
    }
    return true;
}

static bool read_line(Socket fd, char *line, size_t capacity) {
    for (size_t i = 0; i + 1 < capacity; ++i) {
        if (!read_exact(fd, &line[i], 1)) {
            return false;
        }
        if (i > 0 && line[i] == '\n' && line[i - 1] == '\r') {
            line[i - 1] = '\0';
            return true;
        }
    }
    return false;
}

static void send_http(Socket fd, const char *status, const char *cache, const char *body) {
    char header[256];
    int length = snprintf(header, sizeof(header),
                          "HTTP/1.1 %s\r\nContent-Type: application/json\r\nContent-Length: %zu\r\n"
                          "Connection: close\r\nCache-Control: no-store\r\nX-Cache: %s\r\n\r\n",
                          status, strlen(body), cache);
    if (length > 0 && (size_t)length < sizeof(header) && net_send_all(fd, header, (size_t)length)) {
        net_send_all(fd, body, strlen(body));
    }
}

static bool cache_fetch(Socket redis, char *report, const char **cache) {
    char line[64];
    if (!net_send_all(redis, cache_get, sizeof(cache_get) - 1) || !read_line(redis, line, sizeof(line))) {
        return false;
    }
    if (strcmp(line, "$-1") == 0) {
        net_sleep_ms(50); /* Simulate the same upstream work as the uncached path. */
        char request[256];
        int length = snprintf(request, sizeof(request), "*5\r\n$3\r\nSET\r\n" CACHE_KEY
                              "$%zu\r\n" REPORT "\r\n$2\r\nEX\r\n$2\r\n30\r\n", sizeof(REPORT) - 1);
        if (length <= 0 || (size_t)length >= sizeof(request) ||
            !net_send_all(redis, request, (size_t)length) || !read_line(redis, line, sizeof(line)) ||
            strcmp(line, "+OK") != 0) {
            return false;
        }
        memcpy(report, REPORT, sizeof(REPORT));
        *cache = "miss";
        return true;
    }

    uint16_t length;
    char ending[2];
    if (line[0] != '$' || !net_parse_port(line + 1, &length) || length >= REPORT_MAX ||
        !read_exact(redis, report, length) || !read_exact(redis, ending, sizeof(ending)) ||
        memcmp(ending, "\r\n", 2) != 0 || memchr(report, '\0', length)) {
        return false;
    }
    report[length] = '\0';
    *cache = "hit";
    return true;
}

static bool read_request(Socket fd, char *request) {
    size_t used = 0;
    uint64_t deadline = net_now_ms() + 2000;
    while (used < HTTP_HEADER_MAX - 1 && net_now_ms() < deadline) {
        int received = net_recv(fd, request + used, HTTP_HEADER_MAX - 1 - used);
        if (received <= 0) {
            return false;
        }
        used += (size_t)received;
        request[used] = '\0';
        if (strstr(request, "\r\n\r\n")) {
            *strstr(request, "\r\n") = '\0';
            return true;
        }
    }
    return false;
}

static void serve_report(Socket fd, uint16_t redis_port) {
    char request[HTTP_HEADER_MAX];
    if (!net_timeout(fd, 2000) || !read_request(fd, request)) {
        return;
    }
    if (strcmp(request, "GET /v1/report?cache=off HTTP/1.1") == 0) {
        net_sleep_ms(50);
        send_http(fd, "200 OK", "bypass", REPORT);
        return;
    }
    if (strcmp(request, "GET /v1/report HTTP/1.1") != 0) {
        send_http(fd, "404 Not Found", "bypass", "{\"error\":\"route not found\"}");
        return;
    }

    Socket redis = net_connect("127.0.0.1", redis_port);
    const char *cache = NULL;
    char report[REPORT_MAX];
    bool success = redis != INVALID_FD && net_timeout(redis, 2000) && cache_fetch(redis, report, &cache);
    if (redis != INVALID_FD) {
        net_close(redis);
    }
    if (success) {
        send_http(fd, "200 OK", cache, report);
    } else {
        send_http(fd, "502 Bad Gateway", "error", "{\"error\":\"Mini Redis request failed\"}");
    }
}

int main(int argc, char **argv) {
    uint16_t port = 8001;
    uint16_t redis_port = 6379;
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--port") == 0 && i + 1 < argc && net_parse_port(argv[i + 1], &port)) {
            ++i;
        } else if (strcmp(argv[i], "--redis-port") == 0 && i + 1 < argc &&
                   net_parse_port(argv[i + 1], &redis_port) && redis_port != 0) {
            ++i;
        } else {
            fprintf(stderr, "Usage: %s [--port PORT] [--redis-port PORT]\n", argv[0]);
            return EXIT_FAILURE;
        }
    }
    if (!net_init()) {
        return EXIT_FAILURE;
    }
    Socket listener = net_listen("127.0.0.1", port, &port);
    if (listener == INVALID_FD) {
        fputs("Could not listen for report API requests\n", stderr);
        net_cleanup();
        return EXIT_FAILURE;
    }
    printf("Report API listening on 127.0.0.1:%u\n", (unsigned)port);
    fflush(stdout);
    for (;;) {
        Socket client = net_accept(listener);
        if (client != INVALID_FD) {
            serve_report(client, redis_port);
            net_close(client);
        } else if (!net_retryable()) {
            break;
        }
    }
    net_close(listener);
    net_cleanup();
    return EXIT_FAILURE;
}
