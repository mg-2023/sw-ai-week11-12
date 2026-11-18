#ifndef OS_H
#define OS_H
#include <stddef.h>
#include <stdint.h>
typedef struct OsFile OsFile;
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
#ifdef MINI_DBMS_TESTING
void os_test_fail_sync(void);
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
