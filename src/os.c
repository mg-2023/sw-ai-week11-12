#include "os.h"
#include <stdio.h>
#include <stdlib.h>
#include <limits.h>
#include <errno.h>
#ifdef MINI_DBMS_TESTING
#include <stdatomic.h>
static atomic_uint read_calls;
static atomic_int fail_read;
void os_test_fail_read(void) { atomic_store(&fail_read, 1); }
void os_test_reset_reads(void) { atomic_store(&read_calls, 0); }
unsigned os_test_read_calls(void) { return atomic_load(&read_calls); }
#endif
#ifdef _WIN32
#include <winsock2.h>
#include <windows.h>
#include <psapi.h>
#include <io.h>
#include <fcntl.h>
#include <pthread.h>
struct OsFile { HANDLE handle; };
static HANDLE dir_lock = INVALID_HANDLE_VALUE;
/* One event per reading thread, never shared by concurrent requests. Every
 * operation completes before reuse; the TLS destructor closes worker events. */
static pthread_key_t read_event_key;
static pthread_once_t read_event_once = PTHREAD_ONCE_INIT;
static int read_event_key_ok;
static void close_read_event(void *event) { if (event) CloseHandle((HANDLE)event); }
static void init_read_event_key(void) {
    read_event_key_ok = pthread_key_create(&read_event_key, close_read_event) == 0;
}
static HANDLE read_event(void) {
    if (pthread_once(&read_event_once, init_read_event_key) || !read_event_key_ok) return NULL;
    HANDLE event = pthread_getspecific(read_event_key);
    if (!event) {
        event = CreateEventA(NULL, TRUE, FALSE, NULL);
        if (event && pthread_setspecific(read_event_key, event)) { CloseHandle(event); return NULL; }
    }
    return event;
}
int os_init(void) { WSADATA data; return WSAStartup(MAKEWORD(2, 2), &data) ? -1 : 0; }
void os_cleanup(void) {
    if (read_event_key_ok) {
        HANDLE event = pthread_getspecific(read_event_key);
        if (event) { pthread_setspecific(read_event_key, NULL); CloseHandle(event); }
    }
    WSACleanup();
}
int os_stdin_binary(void) { return _setmode(_fileno(stdin), _O_BINARY) == -1 ? -1 : 0; }
int os_is_directory(const char *path) {
    DWORD attrs = GetFileAttributesA(path);
    return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0;
}
int os_create_directory(const char *path) { return CreateDirectoryA(path, NULL) ? 0 : -1; }
uint64_t os_peak_memory_bytes(void) {
    PROCESS_MEMORY_COUNTERS counters = {0};
    if (!K32GetProcessMemoryInfo(GetCurrentProcess(), &counters, sizeof counters)) return UINT64_MAX;
    return (uint64_t)counters.PeakWorkingSetSize;
}
OsFile *os_open(const char *path, int create) {
    HANDLE h = CreateFileA(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           NULL, create ? OPEN_ALWAYS : OPEN_EXISTING, FILE_FLAG_OVERLAPPED, NULL);
    if (h == INVALID_HANDLE_VALUE) return NULL;
    OsFile *f = malloc(sizeof(*f));
    if (!f) { CloseHandle(h); return NULL; }
    f->handle = h; return f;
}
static int64_t read_handle(HANDLE h, void *buf, size_t n, uint64_t off) {
    if (n > INT_MAX) return -1;
    OVERLAPPED ov = {0}; DWORD got = 0;
    ov.Offset = (DWORD)off; ov.OffsetHigh = (DWORD)(off >> 32);
    ov.hEvent = read_event();
    if (!ov.hEvent) return -1;
    if (!ResetEvent(ov.hEvent)) return -1;
    BOOL ok = ReadFile(h, buf, (DWORD)n, &got, &ov);
    DWORD e = ok ? ERROR_SUCCESS : GetLastError();
    if (!ok && e == ERROR_IO_PENDING) { ok = GetOverlappedResult(h, &ov, &got, TRUE); e = ok ? ERROR_SUCCESS : GetLastError(); }
    return ok ? (int64_t)got : (e == ERROR_HANDLE_EOF ? 0 : -1);
}
static int64_t read_at(OsFile *f, void *buf, size_t n, uint64_t off) { return read_handle(f->handle, buf, n, off); }
int64_t os_pread(int fd_or_handle, void *buf, size_t n, uint64_t off) {
    /* A separate overlapped handle also preserves a synchronous CRT fd's cursor. */
    HANDLE h = ReOpenFile((HANDLE)_get_osfhandle(fd_or_handle), GENERIC_READ,
                         FILE_SHARE_READ | FILE_SHARE_WRITE, FILE_FLAG_OVERLAPPED);
    if (h == INVALID_HANDLE_VALUE) return -1;
    int64_t got = read_handle(h, buf, n, off); CloseHandle(h); return got;
}
uint64_t os_size(OsFile *f) { LARGE_INTEGER n; return GetFileSizeEx(f->handle, &n) ? (uint64_t)n.QuadPart : UINT64_MAX; }
static int truncate_file(OsFile *f, uint64_t n) { FILE_END_OF_FILE_INFO info; info.EndOfFile.QuadPart = (LONGLONG)n; return SetFileInformationByHandle(f->handle, FileEndOfFileInfo, &info, sizeof(info)) ? 0 : -1; }
static int sync_file(OsFile *f) { return FlushFileBuffers(f->handle) ? 0 : -1; }
static int write_at(OsFile *f, const void *buf, size_t n, uint64_t off) {
    if (n > INT_MAX) return -1;
    OVERLAPPED ov = {0}; DWORD wrote = 0;
    ov.Offset = (DWORD)off; ov.OffsetHigh = (DWORD)(off >> 32);
    ov.hEvent = CreateEventA(NULL, TRUE, FALSE, NULL);
    if (!ov.hEvent) return -1;
    BOOL ok = WriteFile(f->handle, buf, (DWORD)n, &wrote, &ov);
    if (!ok && GetLastError() == ERROR_IO_PENDING) ok = GetOverlappedResult(f->handle, &ov, &wrote, TRUE);
    CloseHandle(ov.hEvent); return ok && wrote == n ? 0 : -1;
}
void os_close(OsFile *f) { if (f) { CloseHandle(f->handle); free(f); } }
uint64_t os_now_us(void) { LARGE_INTEGER t, freq; QueryPerformanceCounter(&t); QueryPerformanceFrequency(&freq); return (uint64_t)(t.QuadPart / freq.QuadPart) * 1000000 + (uint64_t)(t.QuadPart % freq.QuadPart) * 1000000 / (uint64_t)freq.QuadPart; }
int os_lock_dir(const char *dir) {
    char path[4096]; if (dir_lock != INVALID_HANDLE_VALUE || snprintf(path, sizeof(path), "%s/.mini-dbms.lock", dir) >= (int)sizeof(path)) return -1;
    dir_lock = CreateFileA(path, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    return dir_lock == INVALID_HANDLE_VALUE ? -1 : 0;
}
void os_unlock_dir(void) { if (dir_lock != INVALID_HANDLE_VALUE) { CloseHandle(dir_lock); dir_lock = INVALID_HANDLE_VALUE; } }
#else
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/resource.h>
#include <time.h>
struct OsFile { int fd; };
static int dir_lock = -1;
int os_init(void) { return 0; }
void os_cleanup(void) {}
int os_stdin_binary(void) { return 0; }
int os_is_directory(const char *path) { struct stat s; return stat(path, &s) == 0 && S_ISDIR(s.st_mode); }
int os_create_directory(const char *path) { return mkdir(path, 0700); }
uint64_t os_peak_memory_bytes(void) {
    struct rusage usage;
    if (getrusage(RUSAGE_SELF, &usage)) return UINT64_MAX;
#ifdef __APPLE__
    return (uint64_t)usage.ru_maxrss;
#else
    return (uint64_t)usage.ru_maxrss * 1024;
#endif
}
OsFile *os_open(const char *path, int create) { int fd = open(path, O_RDWR | (create ? O_CREAT : 0), 0600); if (fd < 0) return NULL; OsFile *f = malloc(sizeof(*f)); if (!f) { close(fd); return NULL; } f->fd = fd; return f; }
int64_t os_pread(int fd, void *buf, size_t n, uint64_t off) { ssize_t got; do { got = pread(fd, buf, n, (off_t)off); } while (got < 0 && errno == EINTR); return got; }
static int64_t read_at(OsFile *f, void *buf, size_t n, uint64_t off) { return os_pread(f->fd, buf, n, off); }
uint64_t os_size(OsFile *f) { struct stat s; return fstat(f->fd, &s) ? UINT64_MAX : (uint64_t)s.st_size; }
static int truncate_file(OsFile *f, uint64_t n) { return ftruncate(f->fd, (off_t)n); }
static int sync_file(OsFile *f) { return fsync(f->fd); }
static int write_at(OsFile *f, const void *buf, size_t n, uint64_t off) { size_t done = 0; while (done < n) { ssize_t r = pwrite(f->fd, (const char *)buf + done, n - done, (off_t)(off + done)); if (r < 0 && errno == EINTR) continue; if (r <= 0) return -1; done += (size_t)r; } return 0; }
void os_close(OsFile *f) { if (f) { close(f->fd); free(f); } }
uint64_t os_now_us(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (uint64_t)t.tv_sec * 1000000 + (uint64_t)t.tv_nsec / 1000; }
int os_lock_dir(const char *dir) { char path[4096]; if (dir_lock >= 0 || snprintf(path, sizeof(path), "%s/.mini-dbms.lock", dir) >= (int)sizeof(path)) return -1; int fd = open(path, O_RDWR | O_CREAT, 0600); if (fd < 0) return -1; struct flock l = {0}; l.l_type = F_WRLCK; l.l_whence = SEEK_SET; if (fcntl(fd, F_SETLK, &l)) { close(fd); return -1; } dir_lock = fd; return 0; }
void os_unlock_dir(void) { if (dir_lock >= 0) { close(dir_lock); dir_lock = -1; } }
#endif
int64_t os_read_at(OsFile *f, void *buf, size_t n, uint64_t off) {
#ifdef MINI_DBMS_TESTING
    atomic_fetch_add(&read_calls, 1);
    if (atomic_exchange(&fail_read, 0)) return -1;
#endif
    return read_at(f, buf, n, off);
}
#ifdef MINI_DBMS_TESTING
/* Atomic so Phase 3 worker threads can run with injection points armed. */
static atomic_int fail_sync;
static atomic_uint fail_append_after;
static atomic_int fail_append;
static atomic_int fail_truncate;
static atomic_uint sync_calls;
void os_test_fail_sync(void) { atomic_store(&fail_sync, 1); }
void os_test_fail_append_after(unsigned n) { atomic_store(&fail_append_after, n); atomic_store(&fail_append, 1); }
void os_test_fail_append(void) { os_test_fail_append_after(0); }
void os_test_fail_truncate(void) { atomic_store(&fail_truncate, 1); }
void os_test_reset_syncs(void) { atomic_store(&sync_calls, 0); }
unsigned os_test_sync_calls(void) { return atomic_load(&sync_calls); }
#endif
int os_truncate(OsFile *f, uint64_t n) {
#ifdef MINI_DBMS_TESTING
    if (atomic_exchange(&fail_truncate, 0)) return -1;
#endif
    return truncate_file(f, n);
}
int os_sync(OsFile *f) {
#ifdef MINI_DBMS_TESTING
    atomic_fetch_add(&sync_calls, 1);
    if (atomic_exchange(&fail_sync, 0)) return -1;
#endif
    return sync_file(f);
}
int os_append(OsFile *f, const void *buf, size_t n, uint64_t *off_out) {
    uint64_t off = os_size(f); if (off == UINT64_MAX) return -1;
#ifdef MINI_DBMS_TESTING
    if (atomic_load(&fail_append)) {
        /* Compare-exchange the countdown; only the thread that sees 0 and clears the flag fails. */
        unsigned left = atomic_load(&fail_append_after);
        while (left && !atomic_compare_exchange_weak(&fail_append_after, &left, left - 1)) {}
        if (!left && atomic_exchange(&fail_append, 0)) {
            if (n > 1) (void)write_at(f, buf, n / 2, off);
            return -1;
        }
    }
#endif
    if (write_at(f, buf, n, off)) return -1;
    if (off_out) *off_out = off;
    return 0;
}

/* ---- sockets (the only place that knows Winsock from POSIX sockets) ---- */
#ifdef _WIN32
#define SOCK_NATIVE(s) ((SOCKET)(s))
typedef int sock_len_t;
#else
#include <sys/socket.h>
#include <netinet/in.h>
#include <poll.h>
typedef socklen_t sock_len_t;
#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif
#endif

/* Wait until s can be read (for_write 0) or written, or the deadline passes. 1 ready, 0 timeout, -1 error. */
static int sock_wait(SOCKET_T s, int for_write, uint64_t deadline_us) {
    uint64_t now = os_now_us();
    uint64_t left = deadline_us > now ? deadline_us - now : 0;
#ifdef _WIN32
    fd_set set; struct timeval tv;
    FD_ZERO(&set); FD_SET(SOCK_NATIVE(s), &set);
    tv.tv_sec = (long)(left / 1000000); tv.tv_usec = (long)(left % 1000000);
    int rc = select(0, for_write ? NULL : &set, for_write ? &set : NULL, NULL, &tv);
    return rc < 0 ? -1 : rc == 0 ? 0 : 1;
#else
    struct pollfd p = {.fd = (int)s, .events = for_write ? POLLOUT : POLLIN};
    int ms = left > 2000000000ull * 1000 ? 2000000000 : (int)((left + 999) / 1000), rc;
    do { rc = poll(&p, 1, ms); } while (rc < 0 && errno == EINTR);
    return rc < 0 ? -1 : rc == 0 ? 0 : 1;
#endif
}

/* Listen on 127.0.0.1:port (0 picks a free port, reported through port_out). */
SOCKET_T os_sock_listen(uint16_t port, int backlog, uint16_t *port_out) {
    struct sockaddr_in addr = {0}; sock_len_t len = sizeof addr;
#ifdef _WIN32
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return OS_INVALID_SOCKET;
#define LISTEN_FAIL do { closesocket(s); return OS_INVALID_SOCKET; } while (0)
#else
    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) return OS_INVALID_SOCKET;
#define LISTEN_FAIL do { close(s); return OS_INVALID_SOCKET; } while (0)
#endif
    addr.sin_family = AF_INET; addr.sin_port = htons(port); addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(s, (struct sockaddr *)&addr, sizeof addr) || listen(s, backlog)) LISTEN_FAIL;
    if (getsockname(s, (struct sockaddr *)&addr, &len)) LISTEN_FAIL;
#undef LISTEN_FAIL
    if (port_out) *port_out = ntohs(addr.sin_port);
    return (SOCKET_T)s;
}

/* Block until a client connects; OS_INVALID_SOCKET on error or a closed listener. */
SOCKET_T os_sock_accept(SOCKET_T listener) {
#ifdef _WIN32
    SOCKET s = accept(SOCK_NATIVE(listener), NULL, NULL);
    return s == INVALID_SOCKET ? OS_INVALID_SOCKET : (SOCKET_T)s;
#else
    int s;
    do { s = accept((int)listener, NULL, NULL); } while (s < 0 && errno == EINTR);
    return s < 0 ? OS_INVALID_SOCKET : (SOCKET_T)s;
#endif
}

/* Accept with a timeout, so a stop flag is noticed even if the listener is not closed. */
SOCKET_T os_sock_accept_wait(SOCKET_T listener, int wait_ms) {
    int ready = sock_wait(listener, 0, os_now_us() + (uint64_t)wait_ms * 1000u);
    if (ready < 0) return OS_INVALID_SOCKET;
    if (ready == 0) return (SOCKET_T)OS_SOCK_TIMEOUT;
    return os_sock_accept(listener);
}

/* Windows wakes a blocked accept by closing the socket; POSIX close() would not, so shut it down. */
int os_sock_interrupt_listener(SOCKET_T listener) {
#ifdef _WIN32
    closesocket(SOCK_NATIVE(listener));
    return 1;
#else
    shutdown((int)listener, SHUT_RDWR);
    return 0;
#endif
}

static void (*volatile interrupt_handler)(void);
#ifdef _WIN32
/* Console control events arrive on a new thread created by Windows. */
static BOOL WINAPI console_ctrl(DWORD type) {
    if (type != CTRL_C_EVENT && type != CTRL_BREAK_EVENT && type != CTRL_CLOSE_EVENT) return FALSE;
    if (interrupt_handler) interrupt_handler();
    return TRUE;
}
int os_set_interrupt_handler(void (*handler)(void)) {
    interrupt_handler = handler;
    return SetConsoleCtrlHandler(console_ctrl, TRUE) ? 0 : -1;
}
#else
#include <signal.h>
static void on_signal(int sig) { (void)sig; if (interrupt_handler) interrupt_handler(); }
int os_set_interrupt_handler(void (*handler)(void)) {
    interrupt_handler = handler;
    struct sigaction sa = {0};
    sa.sa_handler = on_signal;
    return sigaction(SIGINT, &sa, NULL) || sigaction(SIGTERM, &sa, NULL) ? -1 : 0;
}
#endif

/* Connect to 127.0.0.1:port (tests and local clients). */
SOCKET_T os_sock_connect_local(uint16_t port) {
    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET; addr.sin_port = htons(port); addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
#ifdef _WIN32
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return OS_INVALID_SOCKET;
    if (connect(s, (struct sockaddr *)&addr, sizeof addr)) { closesocket(s); return OS_INVALID_SOCKET; }
#else
    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) return OS_INVALID_SOCKET;
    if (connect(s, (struct sockaddr *)&addr, sizeof addr)) { close(s); return OS_INVALID_SOCKET; }
#endif
    return (SOCKET_T)s;
}

/* Receive up to n bytes, waiting no later than the deadline. */
int64_t os_sock_recv(SOCKET_T s, void *buf, size_t n, uint64_t deadline_us) {
    int ready = sock_wait(s, 0, deadline_us);
    if (ready < 0) return -1;
    if (ready == 0) return OS_SOCK_TIMEOUT;
#ifdef _WIN32
    int got = recv(SOCK_NATIVE(s), buf, n > (1u << 30) ? (1 << 30) : (int)n, 0);
    return got < 0 ? -1 : got;
#else
    ssize_t got;
    do { got = recv((int)s, buf, n, 0); } while (got < 0 && errno == EINTR);
    return got < 0 ? -1 : (int64_t)got;
#endif
}

/* Send up to n bytes, waiting no later than the deadline. */
int64_t os_sock_send(SOCKET_T s, const void *buf, size_t n, uint64_t deadline_us) {
    int ready = sock_wait(s, 1, deadline_us);
    if (ready < 0) return -1;
    if (ready == 0) return OS_SOCK_TIMEOUT;
#ifdef _WIN32
    int sent = send(SOCK_NATIVE(s), buf, n > (1u << 30) ? (1 << 30) : (int)n, 0);
    return sent < 0 ? -1 : sent;
#else
    ssize_t sent;
    do { sent = send((int)s, buf, n, MSG_NOSIGNAL); } while (sent < 0 && errno == EINTR);
    return sent < 0 ? -1 : (int64_t)sent;
#endif
}

/* Close after an error reply without letting unread request bytes reset the connection. */
void os_sock_close_graceful(SOCKET_T s, uint64_t deadline_us) {
    if (s == OS_INVALID_SOCKET) return;
#ifdef _WIN32
    shutdown(SOCK_NATIVE(s), SD_SEND);
#else
    shutdown((int)s, SHUT_WR);
#endif
    char sink[16384]; size_t total = 0;
    while (total < (size_t)4 << 20) {
        int64_t got = os_sock_recv(s, sink, sizeof sink, deadline_us);
        if (got <= 0) break;
        total += (size_t)got;
    }
    os_sock_close(s);
}

/* Close a socket; OS_INVALID_SOCKET is ignored. */
void os_sock_close(SOCKET_T s) {
    if (s == OS_INVALID_SOCKET) return;
#ifdef _WIN32
    closesocket(SOCK_NATIVE(s));
#else
    close((int)s);
#endif
}
