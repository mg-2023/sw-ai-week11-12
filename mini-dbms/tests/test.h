#ifndef TEST_H
#define TEST_H
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static int test_passed, test_failed;
#define ASSERT(c) do { if (!(c)) { fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #c); test_failed++; return; } } while (0)
#define RUN(fn) do { int before = test_failed; fn(); if (before == test_failed) { test_passed++; printf("PASS %s\n", #fn); } else printf("FAIL %s\n", #fn); } while (0)
static int test_finish(void) { printf("%d passed, %d failed\n", test_passed, test_failed); return test_failed ? 1 : 0; }
#endif
