#include "bptree.h"

#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Order = maximum children. One spare slot holds an overflow before splitting.
 * Non-root leaves have 32..63 entries; internal nodes have 32..64 children. */
enum { BPT_ORDER = 64, BPT_MAX_KEYS = BPT_ORDER - 1,
       BPT_MIN_LEAF = BPT_ORDER / 2, BPT_MIN_INTERNAL = BPT_ORDER / 2 - 1 };

typedef struct BPTNode BPTNode;
struct BPTNode {
    int leaf;
    size_t n;
    int64_t keys[BPT_ORDER];
    union {
        uint64_t values[BPT_ORDER];
        BPTNode *children[BPT_ORDER + 1];
    } data;
    BPTNode *next;
};

struct BPTree {
    BPTNode *root;
    size_t height;
    size_t count;
    BPTNode *reserved;
};

#ifdef MINI_DBMS_TESTING
#include <stdatomic.h>
/* Atomic so Phase 3 worker threads can run with the injection point armed. */
static atomic_size_t fail_node_after = SIZE_MAX;
static atomic_size_t node_allocs;
void bpt_test_fail_node_after(size_t n) { atomic_store(&fail_node_after, n); }
size_t bpt_test_node_allocs(void) { return atomic_load(&node_allocs); }
#endif

static BPTNode *node_new(int leaf) {
#ifdef MINI_DBMS_TESTING
    size_t left = atomic_load(&fail_node_after);
    if (left != SIZE_MAX) {
        if (!left) { atomic_store(&fail_node_after, SIZE_MAX); return NULL; }
        atomic_store(&fail_node_after, left - 1);
    }
    atomic_fetch_add(&node_allocs, 1);
#endif
    BPTNode *node = calloc(1, sizeof *node);
    if (node) node->leaf = leaf;
    return node;
}

static void node_free(BPTNode *node) {
    if (!node) return;
    if (!node->leaf) {
        for (size_t i = 0; i <= node->n; i++) node_free(node->data.children[i]);
    }
    free(node);
}

/* Leaf lower_bound, internal upper_bound: separator = minimum of right subtree. */
static size_t key_position(const BPTNode *node, int64_t key) {
    size_t lo = 0, hi = node->n;
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        if (node->keys[mid] < key || (!node->leaf && node->keys[mid] == key)) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

BPTree *bpt_create(void) {
    return calloc(1, sizeof(BPTree));
}

int bpt_find(const BPTree *tree, int64_t key, uint64_t *value) {
    const BPTNode *node = tree ? tree->root : NULL;
    while (node) {
        size_t pos = key_position(node, key);
        if (!node->leaf) { node = node->data.children[pos]; continue; }
        if (pos == node->n || node->keys[pos] != key) return 0;
        if (value) *value = node->data.values[pos];
        return 1;
    }
    return 0;
}

/* Reserved nodes use next as a temporary allocation list, before becoming live. */
static BPTNode *take_node(BPTNode **reserved, int leaf) {
    BPTNode *node = *reserved;
    *reserved = node->next;
    node->next = NULL;
    node->leaf = leaf;
    return node;
}

static BPTNode *insert_node(BPTNode *node, int64_t key, uint64_t value,
                            BPTNode **reserved, int64_t *separator) {
    size_t pos = key_position(node, key);
    if (node->leaf) {
        memmove(node->keys + pos + 1, node->keys + pos, (node->n - pos) * sizeof *node->keys);
        memmove(node->data.values + pos + 1, node->data.values + pos,
                (node->n - pos) * sizeof *node->data.values);
        node->keys[pos] = key;
        node->data.values[pos] = value;
    } else {
        int64_t promoted;
        BPTNode *right = insert_node(node->data.children[pos], key, value, reserved, &promoted);
        if (!right) return NULL;
        memmove(node->keys + pos + 1, node->keys + pos, (node->n - pos) * sizeof *node->keys);
        memmove(node->data.children + pos + 2, node->data.children + pos + 1,
                (node->n - pos) * sizeof *node->data.children);
        node->keys[pos] = promoted;
        node->data.children[pos + 1] = right;
    }
    node->n++;
    if (node->n <= BPT_MAX_KEYS) return NULL;

    BPTNode *right = take_node(reserved, node->leaf);
    size_t mid = node->n / 2;
    if (node->leaf) {
        right->n = node->n - mid;
        memcpy(right->keys, node->keys + mid, right->n * sizeof *right->keys);
        memcpy(right->data.values, node->data.values + mid, right->n * sizeof *right->data.values);
        right->next = node->next;
        node->next = right;
        *separator = right->keys[0];
    } else {
        *separator = node->keys[mid];
        right->n = node->n - mid - 1;
        memcpy(right->keys, node->keys + mid + 1, right->n * sizeof *right->keys);
        memcpy(right->data.children, node->data.children + mid + 1,
               (right->n + 1) * sizeof *right->data.children);
    }
    node->n = mid;
    return right;
}

static void free_reserved(BPTree *tree) {
    while (tree->reserved) {
        BPTNode *next = tree->reserved->next;
        free(tree->reserved); tree->reserved = next;
    }
}

/* Top the reserved list up to `needed` nodes; on failure free it all. */
static int reserve_nodes(BPTree *tree, size_t needed) {
    size_t available = 0;
    for (BPTNode *p = tree->reserved; p; p = p->next) available++;
    for (size_t i = available; i < needed; i++) {
        BPTNode *fresh = node_new(0);
        if (!fresh) {
            free_reserved(tree);
            return -1;
        }
        fresh->next = tree->reserved; tree->reserved = fresh;
    }
    return 0;
}

int bpt_reserve_insert(BPTree *tree, int64_t key) {
    if (!tree || tree->count == SIZE_MAX) return -1;
    /* Only the consecutive full nodes ending at the leaf can split. Reserve all
     * siblings (and a new root if needed) before changing any key or link. */
    const BPTNode *node = tree->root;
    size_t needed = 0;
    while (node) {
        needed = node->n == BPT_MAX_KEYS ? needed + 1 : 0;
        size_t pos = key_position(node, key);
        if (node->leaf) {
            if (pos < node->n && node->keys[pos] == key) return -1;
            break;
        }
        node = node->data.children[pos];
    }
    if (needed == tree->height) needed++;
    return reserve_nodes(tree, needed);
}

/* Upper bound of nodes that n ascending inserts past the maximum key can create.
 * A node that has split needs 32 more additions before it can split again, so
 * splits per level are 1 + (additions - 1) / 32. Levels above the current root
 * each add one new root plus its own splits. */
static size_t range_nodes_needed(size_t height, size_t n) {
    size_t needed = 0, added = n;
    for (size_t level = 0; added; level++) {
        if (level < height) {
            added = 1 + (added - 1) / BPT_MIN_LEAF;
            needed += added;
        } else {
            size_t nodes = 1 + added / BPT_MIN_LEAF;
            needed += nodes;
            added = nodes - 1;
        }
    }
    return needed;
}

int bpt_reserve_insert_range(BPTree *tree, int64_t first_key, size_t n) {
    if (!tree || !n || tree->count > SIZE_MAX - n) return -1;
    /* Keys first_key .. first_key + n - 1 must fit and exceed the current maximum. */
    if (first_key >= 0 && (uint64_t)n - 1 > (uint64_t)INT64_MAX - (uint64_t)first_key) return -1;
    const BPTNode *node = tree->root;
    while (node && !node->leaf) node = node->data.children[node->n];
    if (node && node->keys[node->n - 1] >= first_key) return -1;
    return reserve_nodes(tree, range_nodes_needed(tree->height, n));
}

/* Insert without allocating or releasing the reserved list. */
int bpt_insert_reserved(BPTree *tree, int64_t key, uint64_t value) {
    if (!tree || tree->count == SIZE_MAX) return -1;
    if (!tree->root) {
        if (!tree->reserved) return -1;
        BPTNode *root = take_node(&tree->reserved, 1);
        root->keys[0] = key; root->data.values[0] = value; root->n = 1;
        tree->root = root; tree->height = 1; tree->count = 1;
        return 0;
    }
    int64_t separator;
    BPTNode *right = insert_node(tree->root, key, value, &tree->reserved, &separator);
    if (right) {
        BPTNode *root = take_node(&tree->reserved, 0);
        root->n = 1; root->keys[0] = separator;
        root->data.children[0] = tree->root; root->data.children[1] = right;
        tree->root = root; tree->height++;
    }
    tree->count++;
    return 0;
}

void bpt_release_reserved(BPTree *tree) {
    if (tree) free_reserved(tree);
}

int bpt_insert(BPTree *tree, int64_t key, uint64_t value) {
    if (bpt_reserve_insert(tree, key)) return -1;
    if (!tree->root) {
        BPTNode *root = take_node(&tree->reserved, 1);
        root->keys[0] = key; root->data.values[0] = value; root->n = 1;
        tree->root = root; tree->height = 1; tree->count = 1;
        free_reserved(tree);
        return 0;
    }
    int64_t separator;
    BPTNode *right = insert_node(tree->root, key, value, &tree->reserved, &separator);
    if (right) {
        BPTNode *root = take_node(&tree->reserved, 0);
        root->n = 1; root->keys[0] = separator;
        root->data.children[0] = tree->root; root->data.children[1] = right;
        tree->root = root; tree->height++;
    }
    tree->count++;
    free_reserved(tree);
    return 0;
}

/* Allocate a whole level before transferring ownership of any child to it. */
static BPTNode **level_new(size_t n, int leaf) {
    if (n > SIZE_MAX / sizeof(BPTNode *)) return NULL;
    BPTNode **level = malloc(n * sizeof *level);
    if (!level) return NULL;
    for (size_t i = 0; i < n; i++) {
        level[i] = node_new(leaf);
        if (!level[i]) {
            for (size_t j = 0; j < i; j++) free(level[j]);
            free(level);
            return NULL;
        }
    }
    return level;
}

static int64_t subtree_min(const BPTNode *node) {
    while (!node->leaf) node = node->data.children[0];
    return node->keys[0];
}

int bpt_bulk_load(BPTree *tree, const int64_t *keys, const uint64_t *values, size_t n) {
    if (!tree || tree->root || (n && (!keys || !values)) ||
        n > SIZE_MAX / sizeof *keys || n > SIZE_MAX / sizeof *values) return -1;
    if (!n) return 0;
    for (size_t i = 1; i < n; i++) if (keys[i - 1] >= keys[i]) return -1;

    size_t count = 1 + (n - 1) / BPT_MAX_KEYS;
    BPTNode **level = level_new(count, 1);
    if (!level) return -1;
    size_t off = 0;
    for (size_t i = 0; i < count; i++) {
        BPTNode *leaf = level[i];
        leaf->n = n / count + (i < n % count);
        memcpy(leaf->keys, keys + off, leaf->n * sizeof *keys);
        memcpy(leaf->data.values, values + off, leaf->n * sizeof *values);
        leaf->next = i + 1 < count ? level[i + 1] : NULL;
        off += leaf->n;
    }
    size_t height = 1;
    while (count > 1) {
        size_t parents = 1 + (count - 1) / BPT_ORDER;
        BPTNode **upper = level_new(parents, 0);
        if (!upper) {
            for (size_t i = 0; i < count; i++) node_free(level[i]);
            free(level);
            return -1;
        }
        off = 0;
        for (size_t i = 0; i < parents; i++) {
            BPTNode *parent = upper[i];
            size_t children = count / parents + (i < count % parents);
            parent->n = children - 1;
            for (size_t j = 0; j < children; j++) {
                parent->data.children[j] = level[off++];
                if (j) parent->keys[j - 1] = subtree_min(parent->data.children[j]);
            }
        }
        free(level); level = upper; count = parents; height++;
    }
    tree->root = level[0]; tree->height = height; tree->count = n;
    free(level);
    return 0;
}

typedef struct {
    const BPTree *tree;
    const BPTNode *previous_leaf;
    size_t count;
    char *why;
    size_t why_len;
} Check;

static int check_error(Check *check, const char *message) {
    if (check->why && check->why_len) snprintf(check->why, check->why_len, "%s", message);
    return -1;
}

/* Return each subtree's actual bounds, checking separators without key +/- 1
 * arithmetic so INT64_MIN and INT64_MAX remain ordinary supported keys. */
static int check_node(Check *check, const BPTNode *node, size_t depth,
                      int64_t *minimum, int64_t *maximum) {
    if (!node) return check_error(check, "missing child");
    if (depth > check->tree->height) return check_error(check, "node below declared height");
    if (node->leaf != 0 && node->leaf != 1) return check_error(check, "invalid node type");
    if (!node->n || node->n > BPT_MAX_KEYS) return check_error(check, "invalid key count");
    if (node != check->tree->root && node->n < (size_t)(node->leaf ? BPT_MIN_LEAF : BPT_MIN_INTERNAL))
        return check_error(check, "node below minimum occupancy");
    for (size_t i = 1; i < node->n; i++) {
        if (node->keys[i - 1] >= node->keys[i]) return check_error(check, "keys not strictly increasing");
    }
    if (node->leaf) {
        if (depth != check->tree->height) return check_error(check, "leaf heights differ");
        if (check->previous_leaf && check->previous_leaf->next != node)
            return check_error(check, "broken leaf link");
        if (check->count > SIZE_MAX - node->n) return check_error(check, "entry count overflow");
        check->count += node->n;
        check->previous_leaf = node;
        *minimum = node->keys[0]; *maximum = node->keys[node->n - 1];
        return 0;
    }
    if (node->next) return check_error(check, "internal node has leaf link");
    int64_t child_min, child_max, previous_max = 0;
    for (size_t i = 0; i <= node->n; i++) {
        if (check_node(check, node->data.children[i], depth + 1, &child_min, &child_max) != 0) return -1;
        if (!i) *minimum = child_min;
        else if (previous_max >= child_min || node->keys[i - 1] != child_min)
            return check_error(check, "invalid separator or overlapping subtrees");
        previous_max = child_max;
    }
    *maximum = previous_max;
    return 0;
}

int bpt_check(const BPTree *tree, char *why, size_t why_len) {
    Check check = {.tree = tree, .why = why, .why_len = why_len};
    if (why && why_len) why[0] = '\0';
    if (!tree) return check_error(&check, "null tree");
    if (!tree->root) {
        return tree->height || tree->count ? check_error(&check, "invalid empty tree") : 0;
    }
    /* Each internal level at least doubles the leaf count, bounding recursion. */
    if (!tree->height || tree->height > sizeof(size_t) * CHAR_BIT)
        return check_error(&check, "invalid tree height");
    int64_t minimum, maximum;
    if (check_node(&check, tree->root, 1, &minimum, &maximum) != 0) return -1;
    if (check.previous_leaf->next) return check_error(&check, "last leaf link is not null");
    if (check.count != tree->count) return check_error(&check, "entry count mismatch");
    return 0;
}

size_t bpt_height(const BPTree *tree) {
    return tree ? tree->height : 0;
}

void bpt_free(BPTree *tree) {
    if (!tree) return;
    free_reserved(tree);
    node_free(tree->root);
    free(tree);
}
