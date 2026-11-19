#include "test.h"
#include "test_dir.h"
#include "os.h"
#include <pthread.h>
#include <stdint.h>
#include <fcntl.h>
#include <unistd.h>

static OsFile *fresh(void) { remove(test_path("os-test.bin")); return os_open(test_path("os-test.bin"), 1); }
static void test_read_at_does_not_move(void) {
    OsFile *f = fresh(); char c; uint64_t off;
    ASSERT(f && os_append(f, "abcd", 4, &off) == 0);
    for (int i = 0; i < 100; i++) {
        ASSERT(os_read_at(f, &c, 1, 3) == 1 && c == 'd');
        ASSERT(os_read_at(f, &c, 1, 0) == 1 && c == 'a');
    }
    int fd = open(test_path("os-test.bin"), O_RDONLY | O_BINARY);
    ASSERT(fd >= 0 && lseek(fd, 2, SEEK_SET) == 2);
    ASSERT(os_pread(fd, &c, 1, 0) == 1 && c == 'a');
    ASSERT(lseek(fd, 0, SEEK_CUR) == 2);
    close(fd); os_close(f);
}
typedef struct { OsFile *f; int i, ok; } Reader;
static void *read_many(void *p) {
    Reader *r = p; r->ok = 1;
    for (int j = 0; j < 10000; j++) { char c; if (os_read_at(r->f, &c, 1, (uint64_t)r->i) != 1 || c != '0' + r->i) { r->ok = 0; break; } }
    return NULL;
}
static void test_concurrent_read_at(void) {
    OsFile *f = fresh(); pthread_t threads[8]; Reader r[8];
    ASSERT(f && os_append(f, "01234567", 8, NULL) == 0);
    for (int i = 0; i < 8; i++) { r[i] = (Reader){f, i, 0}; ASSERT(pthread_create(&threads[i], NULL, read_many, &r[i]) == 0); }
    for (int i = 0; i < 8; i++) { ASSERT(pthread_join(threads[i], NULL) == 0); ASSERT(r[i].ok); }
    os_close(f);
}
typedef struct { int fd, i, ok; } DirectReader;
static void *pread_many(void *ctx) {
    DirectReader *r = ctx; r->ok = 1;
    for (int i = 0; i < 1000; i++) {
        char c;
        if (os_pread(r->fd, &c, 1, (uint64_t)r->i) != 1 || c != '0' + r->i) { r->ok = 0; break; }
    }
    return NULL;
}
static void test_concurrent_pread_preserves_fd_cursor(void) {
    OsFile *f = fresh(); ASSERT(f && os_append(f, "01234567", 8, NULL) == 0);
    int fd = open(test_path("os-test.bin"), O_RDONLY | O_BINARY);
    ASSERT(fd >= 0 && lseek(fd, 3, SEEK_SET) == 3);
    pthread_t threads[8]; DirectReader readers[8];
    for (int i = 0; i < 8; i++) {
        readers[i] = (DirectReader){fd, i, 0};
        ASSERT(pthread_create(&threads[i], NULL, pread_many, &readers[i]) == 0);
    }
    for (int i = 0; i < 8; i++) ASSERT(pthread_join(threads[i], NULL) == 0 && readers[i].ok);
    ASSERT(lseek(fd, 0, SEEK_CUR) == 3);
    close(fd); os_close(f);
}
static void test_append_returns_offset(void) { OsFile *f = fresh(); uint64_t a, b; ASSERT(f); ASSERT(!os_append(f, "abc", 3, &a) && !os_append(f, "de", 2, &b)); ASSERT(a == 0 && b == 3 && os_size(f) == 5); ASSERT(!os_sync(f)); os_close(f); }
static void test_truncate(void) { OsFile *f = fresh(); ASSERT(f && !os_append(f, "abc", 3, NULL)); ASSERT(!os_truncate(f, 1) && os_size(f) == 1); os_close(f); }
static void test_now_us_monotonic(void) { uint64_t a = os_now_us(); for (int i = 0; i < 10000; i++) { uint64_t b = os_now_us(); ASSERT(b >= a); a = b; } }
static void test_lock_dir_twice_fails(void) {
    ASSERT(!os_lock_dir(test_dir));
    ASSERT(os_lock_dir(test_dir) == -1);
    char command[256]; snprintf(command, sizeof command, "build\\test_os.exe --lock-child %s", test_dir);
    ASSERT(system(command) == 0);
    os_unlock_dir(); ASSERT(!os_lock_dir(test_dir)); os_unlock_dir();
}
typedef struct { OsFile *f; int failures; } Appender;
static void *append_a_few(void *ctx) {
    Appender *a = ctx;
    for (int i = 0; i < 20; i++) if (os_append(a->f, "x", 1, NULL)) a->failures++;
    return NULL;
}
/* os_test_fail_append_after(n) fails exactly one append, even with threads appending at once. */
static void test_append_failure_injection_fires_exactly_once_across_threads(void) {
    for (int round = 0; round < 50; round++) {
        Appender a[4]; pthread_t threads[4]; char name[32];
        for (int i = 0; i < 4; i++) {
            snprintf(name, sizeof name, "os-inject-%d.bin", i);
            remove(test_path(name)); a[i] = (Appender){os_open(test_path(name), 1), 0}; ASSERT(a[i].f);
        }
        os_test_fail_append_after(10);
        for (int i = 0; i < 4; i++) ASSERT(pthread_create(&threads[i], NULL, append_a_few, &a[i]) == 0);
        for (int i = 0; i < 4; i++) ASSERT(pthread_join(threads[i], NULL) == 0);
        int total = 0; for (int i = 0; i < 4; i++) { total += a[i].failures; os_close(a[i].f); }
        ASSERT(total == 1);
    }
}
int main(int argc, char **argv) {
    if (argc == 3 && !strcmp(argv[1], "--lock-child")) { int rc = os_lock_dir(argv[2]); if (!rc) os_unlock_dir(); return rc == -1 ? 0 : 1; }
    if (os_init()) return 1;
    test_dir_init("os");
    RUN(test_concurrent_pread_preserves_fd_cursor);
    RUN(test_read_at_does_not_move); RUN(test_concurrent_read_at); RUN(test_append_returns_offset); RUN(test_truncate); RUN(test_now_us_monotonic); RUN(test_lock_dir_twice_fails);
    RUN(test_append_failure_injection_fires_exactly_once_across_threads);
    os_cleanup(); return test_finish();
}
