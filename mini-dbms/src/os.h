#ifndef OS_H
#define OS_H
#include <stddef.h>
#include <stdint.h>
typedef struct OsFile OsFile;
/* Replace dst atomically with a closed, already synced src, then persist the directory entry. */
int os_replace_sync(const char *src, const char *dst);
int os_init(void);
void os_cleanup(void);
int os_stdin_binary(void);
int os_is_directory(const char *path);
/* Create a new directory only; fails if the path already exists. */
int os_create_directory(const char *path);
/* Process lifetime peak resident/working-set bytes; UINT64_MAX on failure. */
uint64_t os_peak_memory_bytes(void);
int64_t os_pread(int fd_or_handle, void *buf, size_t n, uint64_t off);
OsFile *os_open(const char *path, int create);
int os_append(OsFile *, const void *, size_t, uint64_t *off_out);
int64_t os_read_at(OsFile *, void *, size_t, uint64_t off);
int os_truncate(OsFile *, uint64_t size);
int os_sync(OsFile *);
uint64_t os_size(OsFile *);
void os_close(OsFile *);
uint64_t os_now_us(void);
int os_lock_dir(const char *dir);
void os_unlock_dir(void);
/* Sockets. SOCKET_T holds a Winsock SOCKET or a POSIX fd; -1 is invalid. All
 * waits end at deadline_us (os_now_us clock). recv/send return bytes moved
 * (recv 0 = peer closed), OS_SOCK_TIMEOUT on timeout, -1 on error. */
typedef intptr_t SOCKET_T;
#define OS_INVALID_SOCKET ((SOCKET_T)-1)
#define OS_SOCK_TIMEOUT ((int64_t)-2)
SOCKET_T os_sock_listen(uint16_t port, int backlog, uint16_t *port_out);  /* 127.0.0.1 only, port 0 = any */
SOCKET_T os_sock_accept(SOCKET_T listener);
/* Accept, waiting at most wait_ms: the client, OS_SOCK_TIMEOUT (cast) on timeout,
 * OS_INVALID_SOCKET on error or a closed listener. */
SOCKET_T os_sock_accept_wait(SOCKET_T listener, int wait_ms);
/* Wake a thread blocked in accept from another thread or an interrupt handler.
 * Returns 1 if the listener was closed (the caller must not close it again),
 * 0 if it was only shut down (the caller still closes it). */
int os_sock_interrupt_listener(SOCKET_T listener);
/* Call handler on Ctrl+C / Ctrl+Break / console close (Windows) or SIGINT / SIGTERM
 * (POSIX). The handler must only set flags and call os_sock_interrupt_listener. 0 = ok. */
int os_set_interrupt_handler(void (*handler)(void));
/* Call once shutdown is finished. On Windows a console-close handler that returns lets the system
 * end the process at once, so it waits (at most 4 s) for this call; Ctrl+C / Ctrl+Break do not wait. */
void os_interrupt_done(void);
SOCKET_T os_sock_connect_local(uint16_t port);
int64_t os_sock_recv(SOCKET_T s, void *buf, size_t n, uint64_t deadline_us);
int64_t os_sock_send(SOCKET_T s, const void *buf, size_t n, uint64_t deadline_us);
void os_sock_close(SOCKET_T s);
/* Rejector: half-close and make nonblocking; poll all draining sockets together.
 * done[i] is set on EOF/error; no call waits for a peer. */
int os_sock_begin_drain(SOCKET_T s);
int os_sock_drain_ready(const SOCKET_T *sockets, size_t n, unsigned char *done);
/* Close after an error reply: send FIN, then read and discard what the peer still sends
 * (until it closes, deadline_us, or 4 MiB), so unread request bytes do not turn the close
 * into a reset that erases our reply at the client. */
void os_sock_close_graceful(SOCKET_T s, uint64_t deadline_us);
#ifdef MINI_DBMS_TESTING
void os_test_fail_sync(void);
void os_test_fail_sync_after(unsigned n); /* the sync after n more successful ones fails */
void os_test_fail_append(void);
void os_test_fail_append_after(unsigned n);
void os_test_fail_truncate(void);
void os_test_reset_syncs(void);
unsigned os_test_sync_calls(void);
void os_test_fail_read(void);
void os_test_reset_reads(void);
unsigned os_test_read_calls(void);
#endif
#endif
