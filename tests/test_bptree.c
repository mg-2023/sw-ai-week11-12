#include "test.h"
#include "bptree.h"
#include <pthread.h>

static uint64_t value_for(int64_t key) {
    return (uint64_t)key * UINT64_C(6364136223846793005) + UINT64_C(1442695040888963407);
}

static int valid(const BPTree *tree) {
    char why[256] = "not cleared";
    int rc = bpt_check(tree, why, sizeof why);
    if (rc != 0) fprintf(stderr, "bpt_check: %s\n", why);
    return rc == 0 && why[0] == '\0';
}

static void test_insert_find_sequential_100k(void) {
    BPTree *tree = bpt_create();
    ASSERT(tree != NULL);
    for (int64_t k = 0; k < 100000; k++) ASSERT(bpt_insert(tree, k, value_for(k)) == 0);
    ASSERT(valid(tree));
    for (int64_t k = 0; k < 100000; k++) {
        uint64_t value = 0;
        ASSERT(bpt_find(tree, k, &value) == 1 && value == value_for(k));
    }
    bpt_free(tree);
}

static void test_insert_random_100k_check(void) {
    const size_t n = 100000;
    int64_t *keys = malloc(n * sizeof *keys);
    BPTree *tree = bpt_create();
    uint32_t state = 42;
    ASSERT(keys != NULL && tree != NULL);
    for (size_t i = 0; i < n; i++) keys[i] = (int64_t)i - 50000;
    for (size_t i = n - 1; i > 0; i--) {
        state = state * UINT32_C(1664525) + UINT32_C(1013904223);
        size_t j = state % (i + 1);
        int64_t tmp = keys[i]; keys[i] = keys[j]; keys[j] = tmp;
    }
    for (size_t i = 0; i < n; i++) {
        ASSERT(bpt_insert(tree, keys[i], value_for(keys[i])) == 0);
        if ((i + 1) % 10000 == 0) ASSERT(valid(tree));
    }
    for (int64_t k = -50000; k < 50000; k++) {
        uint64_t value = 0;
        ASSERT(bpt_find(tree, k, &value) == 1 && value == value_for(k));
    }
    free(keys);
    bpt_free(tree);
}

static void test_duplicate_rejected(void) {
    BPTree *tree = bpt_create();
    ASSERT(tree != NULL);
    for (int64_t k = 0; k < 5000; k++) ASSERT(bpt_insert(tree, k, value_for(k)) == 0);
    size_t height = bpt_height(tree);
    for (int64_t k = 0; k < 5000; k++) {
        uint64_t value = 0;
        ASSERT(bpt_insert(tree, k, 0) == -1);
        ASSERT(bpt_find(tree, k, &value) == 1 && value == value_for(k));
    }
    ASSERT(valid(tree) && bpt_height(tree) == height);
    bpt_free(tree);
}

static void test_missing_key(void) {
    BPTree *tree = bpt_create();
    uint64_t value = UINT64_MAX;
    ASSERT(tree != NULL && bpt_find(tree, 0, &value) == 0 && value == UINT64_MAX);
    for (int64_t k = -1000; k <= 1000; k += 2) ASSERT(bpt_insert(tree, k, value_for(k)) == 0);
    for (int64_t k = -999; k < 1000; k += 2) ASSERT(bpt_find(tree, k, &value) == 0);
    ASSERT(bpt_find(tree, INT64_MIN, &value) == 0 && bpt_find(tree, INT64_MAX, &value) == 0);
    ASSERT(value == UINT64_MAX && valid(tree));
    bpt_free(tree);
}

static void test_bulk_equals_incremental(void) {
    const size_t n = 100000;
    int64_t *keys = malloc(n * sizeof *keys);
    uint64_t *values = malloc(n * sizeof *values);
    BPTree *bulk = bpt_create(), *incremental = bpt_create();
    ASSERT(keys != NULL && values != NULL && bulk != NULL && incremental != NULL);
    for (size_t i = 0; i < n; i++) {
        keys[i] = (int64_t)i * 2 - 100000;
        values[i] = value_for(keys[i]);
        ASSERT(bpt_insert(incremental, keys[i], values[i]) == 0);
    }
    ASSERT(bpt_bulk_load(bulk, keys, values, n) == 0);
    ASSERT(valid(bulk) && valid(incremental));
    for (size_t i = 0; i < n; i++) {
        uint64_t a = 0, b = 0;
        ASSERT(bpt_find(bulk, keys[i], &a) == 1 && bpt_find(incremental, keys[i], &b) == 1);
        ASSERT(a == values[i] && a == b);
        ASSERT(bpt_find(bulk, keys[i] + 1, &a) == 0);
    }
    free(keys); free(values);
    bpt_free(bulk); bpt_free(incremental);
}

static void test_height_1m_bulk(void) {
    const size_t n = 1000000;
    int64_t *keys = malloc(n * sizeof *keys);
    uint64_t *values = malloc(n * sizeof *values);
    BPTree *tree = bpt_create();
    ASSERT(keys != NULL && values != NULL && tree != NULL);
    for (size_t i = 0; i < n; i++) { keys[i] = (int64_t)i; values[i] = value_for(keys[i]); }
    ASSERT(bpt_bulk_load(tree, keys, values, n) == 0 && valid(tree));
    ASSERT(bpt_height(tree) > 1 && bpt_height(tree) <= 4);
    for (size_t i = 0; i < n; i++) {
        uint64_t value = 0;
        ASSERT(bpt_find(tree, keys[i], &value) == 1 && value == values[i]);
    }
    free(keys); free(values); bpt_free(tree);
}

static void test_empty_and_singleton(void) {
    BPTree *tree = bpt_create();
    uint64_t value = 1;
    ASSERT(tree != NULL && bpt_height(tree) == 0 && valid(tree));
    ASSERT(bpt_bulk_load(tree, NULL, NULL, 0) == 0 && bpt_height(tree) == 0);
    ASSERT(bpt_insert(tree, 0, 0) == 0 && bpt_height(tree) == 1);
    ASSERT(bpt_find(tree, 0, &value) == 1 && value == 0 && valid(tree));
    ASSERT(bpt_check(tree, NULL, 0) == 0);
    bpt_free(tree); bpt_free(NULL);
}

static void test_signed_key_and_offset_bounds(void) {
    const int64_t keys[] = {INT64_MIN, INT64_MIN + 1, -1, 0, 1, INT64_MAX - 1, INT64_MAX};
    const uint64_t values[] = {UINT64_MAX, 0, UINT64_C(1) << 63, 42, UINT64_MAX - 1, 1, 7};
    BPTree *bulk = bpt_create(), *tree = bpt_create();
    ASSERT(bulk != NULL && tree != NULL);
    ASSERT(bpt_bulk_load(bulk, keys, values, 7) == 0);
    for (size_t i = 7; i > 0; i--) ASSERT(bpt_insert(tree, keys[i - 1], values[i - 1]) == 0);
    for (size_t i = 0; i < 7; i++) {
        uint64_t a = 0, b = 0;
        ASSERT(bpt_find(tree, keys[i], &a) == 1 && bpt_find(bulk, keys[i], &b) == 1);
        ASSERT(a == values[i] && b == values[i]);
    }
    ASSERT(valid(tree) && valid(bulk));
    bpt_free(tree); bpt_free(bulk);
}

static void test_descending_and_split_boundaries(void) {
    BPTree *tree = bpt_create();
    ASSERT(tree != NULL);
    for (int64_t k = 20000; k >= 0; k--) {
        ASSERT(bpt_insert(tree, k, value_for(k)) == 0);
        if (k >= 19930 || k % 32 == 0) ASSERT(valid(tree));
    }
    for (int64_t k = 0; k <= 20000; k++) {
        uint64_t value = 0;
        ASSERT(bpt_find(tree, k, &value) == 1 && value == value_for(k));
    }
    bpt_free(tree);
}

static void test_bulk_occupancy_boundaries(void) {
    /* Around leaf capacity, root fanout and the next internal level. */
    const size_t sizes[] = {1, 31, 32, 62, 63, 64, 65, 125, 126, 127,
                            3968, 4031, 4032, 4033, 4096, 258048, 258049};
    const size_t max = sizes[sizeof sizes / sizeof sizes[0] - 1];
    int64_t *keys = malloc(max * sizeof *keys);
    uint64_t *values = malloc(max * sizeof *values);
    ASSERT(keys != NULL && values != NULL);
    for (size_t i = 0; i < max; i++) { keys[i] = (int64_t)i; values[i] = value_for(keys[i]); }
    for (size_t s = 0; s < sizeof sizes / sizeof sizes[0]; s++) {
        BPTree *tree = bpt_create();
        size_t n = sizes[s];
        ASSERT(tree != NULL && bpt_bulk_load(tree, keys, values, n) == 0 && valid(tree));
        ASSERT(bpt_height(tree) == (n <= 63 ? 1u : n <= 4032 ? 2u : n <= 258048 ? 3u : 4u));
        for (size_t i = 0; i < n; i++) {
            uint64_t value = 0;
            ASSERT(bpt_find(tree, keys[i], &value) == 1 && value == values[i]);
        }
        bpt_free(tree);
    }
    free(keys); free(values);
}

static void test_bulk_invalid_input_preserves_tree(void) {
    int64_t keys[] = {1, 3, 3, 4};
    uint64_t values[] = {10, 30, 31, 40};
    BPTree *tree = bpt_create();
    ASSERT(tree != NULL && bpt_bulk_load(tree, keys, values, 4) == -1);
    ASSERT(bpt_height(tree) == 0 && valid(tree));
    keys[2] = 2;
    ASSERT(bpt_bulk_load(tree, keys, values, 4) == -1 && valid(tree));
    ASSERT(bpt_bulk_load(tree, NULL, values, 4) == -1);
    ASSERT(bpt_bulk_load(tree, keys, NULL, 4) == -1 && bpt_height(tree) == 0);
    keys[2] = 4; keys[3] = 5;
    ASSERT(bpt_bulk_load(tree, keys, values, 4) == 0 && valid(tree));
    ASSERT(bpt_bulk_load(tree, keys, values, 4) == -1);
    ASSERT(bpt_bulk_load(tree, NULL, NULL, 0) == -1);
    for (size_t i = 0; i < 4; i++) {
        uint64_t value = 0;
        ASSERT(bpt_find(tree, keys[i], &value) == 1 && value == values[i]);
    }
    ASSERT(valid(tree));
    bpt_free(tree);
}

static void test_insert_after_bulk_load(void) {
    const size_t n = 10000;
    int64_t *keys = malloc(n * sizeof *keys);
    uint64_t *values = malloc(n * sizeof *values);
    BPTree *tree = bpt_create();
    ASSERT(keys != NULL && values != NULL && tree != NULL);
    for (size_t i = 0; i < n; i++) { keys[i] = (int64_t)i * 2; values[i] = value_for(keys[i]); }
    ASSERT(bpt_bulk_load(tree, keys, values, n) == 0);
    for (int64_t k = 19999; k >= -10000; k--) {
        if (k < 0 || k % 2) ASSERT(bpt_insert(tree, k, value_for(k)) == 0);
        if (k % 1000 == 0) ASSERT(valid(tree));
    }
    for (int64_t k = -10000; k < 20000; k++) {
        uint64_t value = 0;
        ASSERT(bpt_find(tree, k, &value) == 1 && value == value_for(k));
    }
    ASSERT(valid(tree));
    free(keys); free(values); bpt_free(tree);
}

static void test_reserved_insert_needs_no_allocation(void) {
    BPTree *tree = bpt_create(), *empty = bpt_create(); ASSERT(tree && empty);
    for (int64_t k = 0; k < 63; k++) ASSERT(bpt_insert(tree, k, value_for(k)) == 0);
    ASSERT(bpt_reserve_insert(tree, 63) == 0 && valid(tree));
    ASSERT(bpt_find(tree, 63, NULL) == 0);
    bpt_test_fail_node_after(0);
    ASSERT(bpt_insert(tree, 63, value_for(63)) == 0 && valid(tree));
    uint64_t value = 0;
    ASSERT(bpt_find(tree, 63, &value) == 1 && value == value_for(63));
    ASSERT(bpt_reserve_insert(empty, 1) == -1); /* Fault not consumed by insert. */
    ASSERT(valid(empty) && bpt_height(empty) == 0);
    ASSERT(bpt_reserve_insert(tree, 63) == -1 && valid(tree));
    ASSERT(bpt_reserve_insert(empty, 1) == 0);
    bpt_free(empty); /* Unused reservation is owned and freed by the tree. */
    bpt_free(tree);
}

/* Reserve a range after `count` keys, insert it, and prove nothing was allocated. */
static int range_case(size_t count, size_t n, int bulk) {
    BPTree *tree = bpt_create(); if (!tree) return 0;
    if (bulk) {
        int64_t *keys = malloc(count * sizeof *keys); uint64_t *values = malloc(count * sizeof *values);
        if (!keys || !values) return 0;
        for (size_t i = 0; i < count; i++) { keys[i] = (int64_t)i + 1; values[i] = value_for((int64_t)i + 1); }
        int rc = bpt_bulk_load(tree, keys, values, count); free(keys); free(values);
        if (rc) return 0;
    } else {
        for (size_t i = 0; i < count; i++) if (bpt_insert(tree, (int64_t)i + 1, value_for((int64_t)i + 1))) return 0;
    }
    if (bpt_reserve_insert_range(tree, (int64_t)count + 1, n)) return 0;
    size_t allocs = bpt_test_node_allocs();
    for (size_t i = 0; i < n; i++) {
        int64_t key = (int64_t)(count + i) + 1;
        if (bpt_insert_reserved(tree, key, value_for(key))) return 0;
    }
    int ok = bpt_test_node_allocs() == allocs && valid(tree);
    bpt_release_reserved(tree);
    for (size_t i = 0; ok && i < count + n; i++) {
        uint64_t value; ok = bpt_find(tree, (int64_t)i + 1, &value) && value == value_for((int64_t)i + 1);
    }
    bpt_free(tree);
    return ok;
}

static void test_reserved_range_needs_no_allocation(void) {
    size_t counts[] = {0, 1, 31, 62, 63, 64, 100, 1000, 3968, 3969, 4000, 20000};
    size_t sizes[] = {1, 2, 31, 32, 33, 63, 64, 65, 1000, 5000, 20000};
    for (size_t c = 0; c < sizeof counts / sizeof *counts; c++) {
        for (size_t n = 0; n < sizeof sizes / sizeof *sizes; n++) {
            for (int bulk = 0; bulk <= (counts[c] > 0); bulk++) {
                if (!range_case(counts[c], sizes[n], bulk)) {
                    fprintf(stderr, "range case count=%zu n=%zu bulk=%d\n", counts[c], sizes[n], bulk);
                    ASSERT(0);
                }
            }
        }
    }
}

static void test_reserved_range_rejects_bad_ranges_and_frees_on_failure(void) {
    BPTree *tree = bpt_create(); ASSERT(tree);
    for (int64_t k = 1; k <= 100; k++) ASSERT(bpt_insert(tree, k, value_for(k)) == 0);
    ASSERT(bpt_reserve_insert_range(tree, 100, 3) == -1); /* Not past the maximum key. */
    ASSERT(bpt_reserve_insert_range(tree, 101, 0) == -1);
    ASSERT(bpt_reserve_insert_range(tree, INT64_MAX, 2) == -1); /* Would overflow. */
    bpt_test_fail_node_after(1);
    ASSERT(bpt_reserve_insert_range(tree, 101, 1000) == -1 && valid(tree)); /* Fails midway, all freed. */
    ASSERT(bpt_reserve_insert_range(tree, 101, 1000) == 0);
    bpt_release_reserved(tree); bpt_release_reserved(NULL);
    ASSERT(valid(tree) && bpt_find(tree, 101, NULL) == 0);
    bpt_free(tree);
}

/* A split that finds no reserved node must return an error, not crash on NULL. */
static void test_insert_reserved_without_nodes_returns_error(void) {
    BPTree *tree = bpt_create(); ASSERT(tree);
    for (int64_t k = 0; k < 63; k++) ASSERT(bpt_insert(tree, k, 1) == 0); /* one full leaf */
    ASSERT(bpt_insert_reserved(tree, 63, 1) == -1);                        /* needs a sibling, none reserved */
    uint64_t v;
    ASSERT(valid(tree) && bpt_find(tree, 63, &v) == 0 && bpt_find(tree, 62, &v) == 1);
    ASSERT(bpt_reserve_insert_range(tree, 63, 1) == 0 && bpt_insert_reserved(tree, 63, 7) == 0);
    ASSERT(valid(tree) && bpt_find(tree, 63, &v) == 1 && v == 7);
    bpt_release_reserved(tree); bpt_free(tree);
    BPTree *empty = bpt_create(); ASSERT(empty);
    ASSERT(bpt_insert_reserved(empty, 1, 1) == -1); /* empty tree, nothing reserved */
    bpt_free(empty);
}

static void *insert_in_private_tree(void *ctx) {
    int *failures = ctx; BPTree *tree = bpt_create();
    for (int64_t k = 0; tree && k < 3; k++) if (bpt_insert(tree, k, 1)) (*failures)++;
    bpt_free(tree);
    return NULL;
}

/* The one-shot failure injection fires exactly once even when threads allocate at the same time. */
static void test_node_failure_injection_fires_exactly_once_across_threads(void) {
    for (int round = 0; round < 50; round++) {
        int failures[8] = {0}; pthread_t threads[8];
        bpt_test_fail_node_after(5);
        for (int i = 0; i < 8; i++) ASSERT(pthread_create(&threads[i], NULL, insert_in_private_tree, &failures[i]) == 0);
        for (int i = 0; i < 8; i++) ASSERT(pthread_join(threads[i], NULL) == 0);
        int total = 0; for (int i = 0; i < 8; i++) total += failures[i];
        ASSERT(total == 1);
    }
}

int main(void) {
    RUN(test_insert_reserved_without_nodes_returns_error);
    RUN(test_node_failure_injection_fires_exactly_once_across_threads);
    RUN(test_reserved_range_needs_no_allocation);
    RUN(test_reserved_range_rejects_bad_ranges_and_frees_on_failure);
    RUN(test_reserved_insert_needs_no_allocation);
    RUN(test_insert_find_sequential_100k);
    RUN(test_insert_random_100k_check);
    RUN(test_duplicate_rejected);
    RUN(test_missing_key);
    RUN(test_bulk_equals_incremental);
    RUN(test_height_1m_bulk);
    RUN(test_empty_and_singleton);
    RUN(test_signed_key_and_offset_bounds);
    RUN(test_descending_and_split_boundaries);
    RUN(test_bulk_occupancy_boundaries);
    RUN(test_bulk_invalid_input_preserves_tree);
    RUN(test_insert_after_bulk_load);
    return test_finish();
}
