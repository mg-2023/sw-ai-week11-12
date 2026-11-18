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
int os_truncate(OsFile *f, uint64_t n) { FILE_END_OF_FILE_INFO info; info.EndOfFile.QuadPart = (LONGLONG)n; return SetFileInformationByHandle(f->handle, FileEndOfFileInfo, &info, sizeof(info)) ? 0 : -1; }
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
#include <time.h>
struct OsFile { int fd; };
static int dir_lock = -1;
int os_init(void) { return 0; }
void os_cleanup(void) {}
int os_stdin_binary(void) { return 0; }
int os_is_directory(const char *path) { struct stat s; return stat(path, &s) == 0 && S_ISDIR(s.st_mode); }
OsFile *os_open(const char *path, int create) { int fd = open(path, O_RDWR | (create ? O_CREAT : 0), 0600); if (fd < 0) return NULL; OsFile *f = malloc(sizeof(*f)); if (!f) { close(fd); return NULL; } f->fd = fd; return f; }
int64_t os_pread(int fd, void *buf, size_t n, uint64_t off) { ssize_t got; do { got = pread(fd, buf, n, (off_t)off); } while (got < 0 && errno == EINTR); return got; }
static int64_t read_at(OsFile *f, void *buf, size_t n, uint64_t off) { return os_pread(f->fd, buf, n, off); }
uint64_t os_size(OsFile *f) { struct stat s; return fstat(f->fd, &s) ? UINT64_MAX : (uint64_t)s.st_size; }
int os_truncate(OsFile *f, uint64_t n) { return ftruncate(f->fd, (off_t)n); }
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
static int fail_sync;
static unsigned fail_append_after;
static int fail_append;
void os_test_fail_sync(void) { fail_sync = 1; }
void os_test_fail_append_after(unsigned n) { fail_append = 1; fail_append_after = n; }
void os_test_fail_append(void) { os_test_fail_append_after(0); }
#endif
int os_sync(OsFile *f) {
#ifdef MINI_DBMS_TESTING
    if (fail_sync) { fail_sync = 0; return -1; }
#endif
    return sync_file(f);
}
int os_append(OsFile *f, const void *buf, size_t n, uint64_t *off_out) {
    uint64_t off = os_size(f); if (off == UINT64_MAX) return -1;
#ifdef MINI_DBMS_TESTING
    if (fail_append) {
        if (fail_append_after) fail_append_after--;
        else { fail_append = 0; if (n > 1) (void)write_at(f, buf, n / 2, off); return -1; }
    }
#endif
    if (write_at(f, buf, n, off)) return -1;
    if (off_out) *off_out = off;
    return 0;
}
