#ifndef MINI_REDIS_STORE_H
#define MINI_REDIS_STORE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
    const char *data;
    size_t length;
} Bytes;

typedef struct Entry Entry;

typedef struct {
    Entry **buckets;
    size_t capacity;
} Table;

typedef struct {
    Table current;
    Table next;
    size_t size;
    size_t rehash_bucket;
    Entry *expire_cursor;
    size_t expiring;
} Store;

bool store_init(Store *store);
void store_destroy(Store *store);
/* The store owns copies of key/value. A zero deadline means no TTL. */
bool store_set(Store *store, Bytes key, Bytes value, uint64_t deadline_ms);
/* The returned view is valid until the entry changes or is removed. */
bool store_get(Store *store, Bytes key, uint64_t now_ms, Bytes *value);
bool store_delete(Store *store, Bytes key, uint64_t now_ms);
bool store_expire_at(Store *store, Bytes key, uint64_t now_ms, uint64_t deadline_ms);
int64_t store_pttl(Store *store, Bytes key, uint64_t now_ms);
void store_maintain(Store *store, uint64_t now_ms);

#endif
