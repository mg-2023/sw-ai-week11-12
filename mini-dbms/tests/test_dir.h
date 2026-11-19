#ifndef TEST_DIR_H
#define TEST_DIR_H
/* A private data folder per test process: build/t-<tag>-<pid>-<time>.
 * Two test runs in one work tree never share files. Removed at exit. */
#include "os.h"
#include <dirent.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef _WIN32
#include <direct.h>
#include <process.h>
#define test_rmdir _rmdir
#define test_getpid _getpid
#else
#include <unistd.h>
#define test_rmdir rmdir
#define test_getpid getpid
#endif

static char test_dir[128];

/* Path of a file inside the private folder (four rotating buffers). */
static const char *test_path(const char *name) {
    static char bufs[4][256]; static unsigned next;
    char *b = bufs[next++ % 4];
    snprintf(b, 256, "%s/%s", test_dir, name);
    return b;
}

/* Delete every file in the private folder (the folder stays). */
static void test_dir_clear(void) {
    if (!test_dir[0]) return;
    DIR *d = opendir(test_dir);
    if (d) {
        struct dirent *e;
        while ((e = readdir(d))) {
            if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
            remove(test_path(e->d_name));
        }
        closedir(d);
    }
}

/* Delete the files, then the folder itself. */
static void test_dir_remove(void) {
    if (!test_dir[0]) return;
    test_dir_clear();
    test_rmdir(test_dir);
    test_dir[0] = '\0';
}

static void test_dir_init(const char *tag) {
    snprintf(test_dir, sizeof test_dir, "build/t-%s-%ld-%llu", tag, (long)test_getpid(), (unsigned long long)time(NULL));
    if (os_create_directory(test_dir)) { fprintf(stderr, "cannot create %s\n", test_dir); exit(2); }
    atexit(test_dir_remove);
}
#endif
