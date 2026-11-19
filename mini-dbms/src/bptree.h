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
/* Reserve nodes for n ascending keys first_key .. first_key + n - 1, all greater
 * than every key in the tree (ids only grow). bpt_insert_reserved then inserts
 * each of them with no allocation. 0 on success, -1 on a bad range or allocation
 * failure (reservation freed, tree intact). Caller serializes writes.
 */
int bpt_reserve_insert_range(BPTree *, int64_t first_key, size_t n);
/* Insert using only reserved nodes; the reservation is kept until
 * bpt_release_reserved. Valid only inside a bpt_reserve_insert_range range. */
int bpt_insert_reserved(BPTree *, int64_t key, uint64_t value);
/* Free unused reserved nodes (after a rollback or a finished batch). */
void bpt_release_reserved(BPTree *);
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
/* Number of node allocations so far (to prove an insert allocated nothing). */
size_t bpt_test_node_allocs(void);
#endif

#endif
