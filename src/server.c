#include "server.h"
#include "db.h"
#include "http.h"
#include "os.h"
#include "threadpool.h"

#include <inttypes.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define READ_US 2000000u    /* headers and body must arrive within 2 s of accept */
#define SEND_US 2000000u    /* sending the response */
#define ACCEPT_POLL_MS 200  /* backstop so a stop flag is noticed even if the wake-up is missed */

#define REJECT_CAP 256u
typedef struct {
    pthread_t thread;
    pthread_mutex_t mutex;
    pthread_cond_t changed;
    SOCKET_T queue[REJECT_CAP];
    size_t head, count;
    int stopping;
} Rejector;

typedef struct {
    Db *db;
    ThreadPool *pool;
    Rejector *rejector;
    uint64_t total_us;
    int workers, queue_cap;
    atomic_uint_least64_t processed, rejected;
} Server;

typedef struct { SOCKET_T sock; uint64_t accepted_us; } Conn;

/* The interrupt handler can only reach globals. */
static Server *g_server;
static SOCKET_T g_listener = OS_INVALID_SOCKET;
static atomic_int g_stop, g_woken;

/* Runs on Ctrl+C: set the stop flag and wake accept by closing the listener (once). */
static void on_interrupt(void) {
    atomic_store(&g_stop, 1);
    if (!atomic_exchange(&g_woken, 1)) os_sock_interrupt_listener(g_listener);
}

/* Send {"ok":false,"error":{"message":...}}; message is a plain constant with nothing to escape. */
static void send_error(SOCKET_T s, int status, const char *message) {
    char body[256];
    int n = snprintf(body, sizeof body, "{\"ok\":false,\"error\":{\"message\":\"%s\"}}", message);
    http_send(s, status, body, (size_t)n, os_now_us() + SEND_US);
}

static void send_deadline(SOCKET_T s) {
    const char body[] = "{\"ok\":false,\"error\":{\"statement\":0,\"line\":0,\"col\":0,"
        "\"message\":\"deadline exceeded after 0 statements; earlier statements are committed\"},\"committed\":0}";
    http_send(s, 503, body, sizeof body - 1, os_now_us() + SEND_US);
}

/* GET /stats: table rows, pool and counters, INSERT lock wait. Reads only atomics and the wait-sample mutex. */
static void send_stats(Server *srv, SOCKET_T s) {
    int tables = db_table_count(srv->db);
    size_t cap = 1024 + (size_t)tables * 160, used = 0;
    char *b = malloc(cap);
    if (!b) { send_error(s, 500, "out of memory"); return; }
    uint64_t p99, max, samples;
    db_insert_lock_wait(srv->db, &p99, &max, &samples);
    used += (size_t)snprintf(b + used, cap - used, "{\"ok\":true,\"tables\":{");
    for (int i = 0; i < tables; i++) {
        used += (size_t)snprintf(b + used, cap - used, "%s\"%s\":{\"rows\":%" PRIu64 "}", i ? "," : "",
                                 db_table_name(srv->db, i), db_table_rows_at(srv->db, i));
    }
    used += (size_t)snprintf(b + used, cap - used,
        "},\"workers\":%d,\"busy\":%d,\"queued\":%d,\"queue_capacity\":%d,"
        "\"processed\":%" PRIu64 ",\"rejected\":%" PRIu64 ","
        "\"insert_lock_wait_us\":{\"p99\":%" PRIu64 ",\"max\":%" PRIu64 ",\"samples\":%" PRIu64 "}}",
        srv->workers, tp_busy(srv->pool), tp_queued(srv->pool), srv->queue_cap,
        (uint64_t)atomic_load(&srv->processed), (uint64_t)atomic_load(&srv->rejected), p99, max, samples);
    atomic_fetch_add(&srv->processed, 1);
    http_send(s, 200, b, used, os_now_us() + SEND_US);
    free(b);
}

/* POST /query: run the SQL through db_execute_sql; 200, 400 (SQL error) or 500 (internal error). */
static void run_query(Server *srv, SOCKET_T s, const HttpRequest *req, int worker_id, uint64_t deadline_us) {
    if (strlen(req->body) != req->body_len) { send_error(s, 400, "SQL contains a NUL byte"); return; }
    Result result = {0};
    db_execute_sql(srv->db, req->body, deadline_us, &result);
    int status = result_http_status(&result);
    char *json = NULL; size_t len = 0;
    if (result_to_json(&result, worker_id, &json, &len)) {
        result_free(&result);
        send_error(s, 500, "out of memory building the response");
        return;
    }
    result_free(&result);
    atomic_fetch_add(&srv->processed, 1);   /* counted before the reply, so a client that saw it sees it in /stats */
    http_send(s, status, json, len, os_now_us() + SEND_US);
    free(json);
}

/* One connection = one request. Runs on a worker thread. */
static void handle_connection(void *arg, int worker_id) {
    Conn *conn = arg; Server *srv = g_server; SOCKET_T s = conn->sock;
    int drain = 0;   /* error reply: the request may be unread, so close gracefully */
    if (os_now_us() >= conn->accepted_us + srv->total_us) {              /* waited in the queue past the deadline */
        atomic_fetch_add(&srv->rejected, 1);
        send_deadline(s);
        drain = 1;
        goto done;
    }
    HttpRequest req = {0};
    uint64_t read_us = srv->total_us < READ_US ? srv->total_us : READ_US;
    int status = http_read_request(s, &req, conn->accepted_us + read_us);
    if (status) {
        if (status == 408 && os_now_us() >= conn->accepted_us + srv->total_us) status = 503;
        if (status == 503) send_deadline(s);
        else send_error(s, status, status == 408 ? "request timed out" : status == 413 ? "request body too large" :
                              status == 500 ? "server error reading the request" : "malformed HTTP request");
        drain = 1;
        goto done;
    }
    if (os_now_us() >= conn->accepted_us + srv->total_us) {              /* too late to start executing */
        atomic_fetch_add(&srv->rejected, 1);
        send_deadline(s);
        drain = 1;
    } else if (strcmp(req.path, "/query") == 0) {
        if (strcmp(req.method, "POST") == 0) run_query(srv, s, &req, worker_id, conn->accepted_us + srv->total_us);
        else send_error(s, 405, "use POST for /query");
    } else if (strcmp(req.path, "/health") == 0 || strcmp(req.path, "/stats") == 0) {
        if (strcmp(req.method, "GET") != 0) send_error(s, 405, "use GET for this path");
        else if (req.path[1] == 'h') {
            atomic_fetch_add(&srv->processed, 1);
            http_send(s, 200, "{\"ok\":true}", 11, os_now_us() + SEND_US);
        } else send_stats(srv, s);
    } else send_error(s, 404, "unknown path");
    if (req.extra_bytes) drain = 1;   /* the client sent more than Content-Length: do not reset over it */
    http_request_free(&req);
done:
    if (drain && !atomic_load(&g_stop)) os_sock_close_graceful(s, os_now_us() + 300000u);
    else os_sock_close(s);
    free(conn);
}

/* Send in FIFO order; drain every half-closed socket in one nonblocking select. */
static void *reject_loop(void *arg) {
    Rejector *r = arg;
    typedef struct { SOCKET_T sock; uint64_t expires; } Drain;
    Drain *draining = NULL; size_t n = 0, capacity = 0;
    for (;;) {
        pthread_mutex_lock(&r->mutex);
        if (r->stopping || atomic_load(&g_stop)) {
            while (r->count) {
                os_sock_close(r->queue[r->head]); r->head = (r->head + 1) % REJECT_CAP; r->count--;
            }
            pthread_mutex_unlock(&r->mutex);
            for (size_t i = 0; i < n; i++) os_sock_close(draining[i].sock);
            free(draining);
            return NULL;
        }
        SOCKET_T s = OS_INVALID_SOCKET;
        if (r->count) {
            s = r->queue[r->head]; r->head = (r->head + 1) % REJECT_CAP; r->count--;
        }
        pthread_mutex_unlock(&r->mutex);
        if (s != OS_INVALID_SOCKET) {
            const char body[] = "{\"ok\":false,\"error\":{\"message\":\"server busy: request queue is full\"}}";
            http_send(s, 503, body, sizeof body - 1, os_now_us() + 200000u);
            if (n == capacity) {
                size_t next = capacity ? capacity * 2 : REJECT_CAP;
                Drain *grown = next > SIZE_MAX / sizeof *grown ? NULL : realloc(draining, next * sizeof *grown);
                if (grown) { draining = grown; capacity = next; }
            }
            if (n == capacity || os_sock_begin_drain(s)) os_sock_close(s);
            else draining[n++] = (Drain){s, os_now_us() + 200000u};
        }
        uint64_t now = os_now_us();
        size_t kept = 0;
        for (size_t base = 0; base < n; base += REJECT_CAP) {
            SOCKET_T sockets[REJECT_CAP]; unsigned char done[REJECT_CAP];
            size_t count = n - base < REJECT_CAP ? n - base : REJECT_CAP;
            for (size_t i = 0; i < count; i++) sockets[i] = draining[base + i].sock;
            int bad = os_sock_drain_ready(sockets, count, done);
            for (size_t i = 0; i < count; i++) {
                Drain d = draining[base + i];
                if (bad || done[i] || now >= d.expires) os_sock_close(d.sock);
                else draining[kept++] = d;
            }
        }
        n = kept;
        pthread_mutex_lock(&r->mutex);
        if (!r->stopping && !atomic_load(&g_stop) && !r->count) {
            if (!n) pthread_cond_wait(&r->changed, &r->mutex);
            else {
                struct timespec until; clock_gettime(CLOCK_REALTIME, &until);
                until.tv_nsec += 5000000;
                if (until.tv_nsec >= 1000000000) { until.tv_sec++; until.tv_nsec -= 1000000000; }
                pthread_cond_timedwait(&r->changed, &r->mutex, &until);
            }
        }
        pthread_mutex_unlock(&r->mutex);
    }
}

static Rejector *reject_create(void) {
    Rejector *r = calloc(1, sizeof *r);
    if (!r) return NULL;
    if (pthread_mutex_init(&r->mutex, NULL)) { free(r); return NULL; }
    if (pthread_cond_init(&r->changed, NULL)) { pthread_mutex_destroy(&r->mutex); free(r); return NULL; }
    if (pthread_create(&r->thread, NULL, reject_loop, r)) {
        pthread_cond_destroy(&r->changed); pthread_mutex_destroy(&r->mutex); free(r); return NULL;
    }
    return r;
}

static int reject_submit(Rejector *r, SOCKET_T s) {
    pthread_mutex_lock(&r->mutex);
    int bad = r->stopping || atomic_load(&g_stop) || r->count == REJECT_CAP;
    if (!bad) { r->queue[(r->head + r->count++) % REJECT_CAP] = s; pthread_cond_signal(&r->changed); }
    pthread_mutex_unlock(&r->mutex);
    return bad;
}

static void reject_destroy(Rejector *r) {
    if (!r) return;
    pthread_mutex_lock(&r->mutex); r->stopping = 1; pthread_cond_signal(&r->changed); pthread_mutex_unlock(&r->mutex);
    pthread_join(r->thread, NULL);
    pthread_cond_destroy(&r->changed); pthread_mutex_destroy(&r->mutex); free(r);
}

/* Accept loop: hand each connection to the pool; when the queue is full pass it to the rejector at once.
 * Returns 1 if it stopped because accept kept failing (not because of a stop request), else 0. */
static int accept_loop(Server *srv) {
    int errors = 0;
    while (!atomic_load(&g_stop)) {
        SOCKET_T c = os_sock_accept_wait(g_listener, ACCEPT_POLL_MS);
        if (c == (SOCKET_T)OS_SOCK_TIMEOUT) continue;
        if (c == OS_INVALID_SOCKET) {
            if (atomic_load(&g_stop)) break;
            if (++errors > 100) {
                fputs("error: accept failed over 100 times in a row; stopping the server\n", stderr);
                return 1;
            }
            continue;
        }
        errors = 0;
        Conn *conn = malloc(sizeof *conn);
        if (conn) { conn->sock = c; conn->accepted_us = os_now_us(); }
        if (!conn || tp_submit(srv->pool, conn)) {
            atomic_fetch_add(&srv->rejected, 1);
            /* If even the rejector is full, drop the connection (reset) rather than wait. */
            if (!conn || reject_submit(srv->rejector, c)) os_sock_close(c);
            free(conn);
        }
    }
    return 0;
}

/* Same shape as the CLI usage error: message on stdout, usage text on stderr, exit code 1. */
static int usage(void) {
    puts("error at 0:0: invalid command or arguments");
    fputs("usage: mini-dbms serve [--port 8100] [--threads 4] [--queue 64] [--total-timeout-ms 5000] [--data DIR] [--sync always|none]\n", stderr);
    return 1;
}

/* Strict decimal in [min, max]. */
static int number(const char *text, long min, long max, long *out) {
    if (!*text) return -1;
    long v = 0;
    for (const char *p = text; *p; p++) {
        if (*p < '0' || *p > '9' || v > max) return -1;
        v = v * 10 + (*p - '0');
    }
    if (v < min || v > max) return -1;
    *out = v;
    return 0;
}

int server_main(int argc, char **argv) {
    long port = 8100, threads = 4, queue = 64, total_ms = 5000;
    const char *dir = "data";
    DbOptions options = {.sync_always = 1};
    unsigned seen = 0;
    for (int i = 2; i < argc; i++) {
        unsigned flag; long *value = NULL, min = 0, max = 0;
        if (strcmp(argv[i], "--port") == 0) { flag = 1; value = &port; min = 0; max = 65535; }
        else if (strcmp(argv[i], "--threads") == 0) { flag = 2; value = &threads; min = 1; max = 256; }
        else if (strcmp(argv[i], "--queue") == 0) { flag = 4; value = &queue; min = 1; max = 100000; }
        else if (strcmp(argv[i], "--data") == 0) flag = 8;
        else if (strcmp(argv[i], "--sync") == 0) flag = 16;
        else if (strcmp(argv[i], "--total-timeout-ms") == 0) { flag = 32; value = &total_ms; min = 1; max = 3600000; }
        else return usage();
        if ((seen & flag) || ++i >= argc) return usage();
        seen |= flag;
        if (value) { if (number(argv[i], min, max, value)) return usage(); }
        else if (flag == 8) { dir = argv[i]; if (!*dir) return usage(); }
        else if (strcmp(argv[i], "always") == 0) options.sync_always = 1;
        else if (strcmp(argv[i], "none") == 0) options.sync_always = 0;
        else return usage();
    }

    if (os_init()) { fputs("error: cannot initialize the OS layer\n", stderr); return 1; }
    DbError err = {0};
    Db *db = db_open(dir, options, &err);
    if (!db) { fprintf(stderr, "error: %s\n", err.message); os_cleanup(); return 1; }
    Server srv = {.db = db, .workers = (int)threads, .queue_cap = (int)queue, .total_us = (uint64_t)total_ms * 1000u};
    g_server = &srv;
    srv.pool = tp_create((int)threads, (int)queue, handle_connection);
    srv.rejector = reject_create();
    uint16_t bound = 0;
    g_listener = os_sock_listen((uint16_t)port, 128, &bound);
    if (!srv.pool || !srv.rejector || g_listener == OS_INVALID_SOCKET || os_set_interrupt_handler(on_interrupt)) {
        fprintf(stderr, "error: cannot %s\n", !srv.pool || !srv.rejector ? "start the thread pool" :
                g_listener == OS_INVALID_SOCKET ? "listen on that port (is it in use?)" : "install the interrupt handler");
        if (g_listener != OS_INVALID_SOCKET) os_sock_close(g_listener);
        tp_destroy(srv.pool); reject_destroy(srv.rejector); db_close(db); os_cleanup();
        return 1;
    }
    printf("listening 127.0.0.1:%u\n", (unsigned)bound);
    fflush(stdout);
    fprintf(stderr, "mini-dbms serving %s: %ld workers, queue %ld, sync %s; Ctrl+C stops\n",
            dir, threads, queue, options.sync_always ? "always" : "none");

    int accept_failed = accept_loop(&srv);

    /* Stop: no new connections; queued requests still get answered; then close the files. */
    if (!atomic_exchange(&g_woken, 1)) os_sock_close(g_listener);   /* else the interrupt handler woke or closed it */
    reject_destroy(srv.rejector);
    tp_shutdown(srv.pool);
    tp_destroy(srv.pool);
    db_close(db);
    fprintf(stderr, "mini-dbms stopped: processed %" PRIu64 ", rejected %" PRIu64 "\n",
            (uint64_t)atomic_load(&srv.processed), (uint64_t)atomic_load(&srv.rejected));
    g_server = NULL;
    os_cleanup();
    os_interrupt_done();   /* lets a console-close handler return: the process may end now */
    return accept_failed ? 1 : 0;
}
