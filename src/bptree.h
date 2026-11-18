#ifndef BPTREE_H
#define BPTREE_H

#include <stddef.h>
#include <stdint.h>

typedef struct BPTree BPTree;

BPTree *bpt_create(void);
/* Reserve nodes for this key without publishing it. Until the next mutation,
 * bpt_insert of the same key will need no allocation. Caller serializes writes.
 * 0 on success, -1 on duplicate/allocation failure; logical contents unchanged.
 */
int bpt_reserve_insert(BPTree *, int64_t key);
/* 0 on success, -1 on duplicate key or allocation failure; failure leaves the tree intact. */
int bpt_insert(BPTree *, int64_t key, uint64_t value);
/* 1 if found, 0 otherwise. A miss leaves *value unchanged. */
int bpt_find(const BPTree *, int64_t key, uint64_t *value);
/* Strictly increasing keys, empty tree only. 0 on success, -1 on failure (tree intact). */
int bpt_bulk_load(BPTree *, const int64_t *keys, const uint64_t *values, size_t n);
/* 0 if valid, -1 with a diagnostic otherwise; why may be NULL when why_len is zero. */
int bpt_check(const BPTree *, char *why, size_t why_len);
/* Number of node levels: empty = 0, a single leaf = 1. */
size_t bpt_height(const BPTree *);
void bpt_free(BPTree *);

#ifdef MINI_DBMS_TESTING
/* One-shot node-allocation failure after n successful node allocations. */
void bpt_test_fail_node_after(size_t n);
#endif

#endif
