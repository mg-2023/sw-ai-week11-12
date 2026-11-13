#include "store.h"

#include <assert.h>
#include <stdlib.h>
#include <string.h>

struct Entry {
    Entry *next;
    Entry *expire_next;
    Entry *expire_prev;
    uint64_t hash;
    uint64_t deadline_ms;
    size_t key_length;
    size_t value_length;
    char data[]; /* Key followed by value, both length-delimited. */
};

static uint64_t hash_key(Bytes key) {
    uint64_t hash = UINT64_C(14695981039346656037);
    for (size_t i = 0; i < key.length; ++i) {
        hash ^= (unsigned char)key.data[i];
        hash *= UINT64_C(1099511628211);
    }
    return hash;
}

static Entry **bucket(Table table, uint64_t hash) {
    return &table.buckets[hash % table.capacity];
}

static bool init_table(Table *table, size_t capacity) {
    if (capacity > SIZE_MAX / sizeof(*table->buckets)) {
        return false;
    }
    table->buckets = calloc(capacity, sizeof(*table->buckets));
    table->capacity = table->buckets ? capacity : 0;
    return table->buckets != NULL;
}

bool store_init(Store *store) {
    *store = (Store){0};
    return init_table(&store->current, 8);
}

void store_destroy(Store *store) {
    Table tables[] = {store->current, store->next};
    for (size_t t = 0; t < 2; ++t) {
        for (size_t i = 0; i < tables[t].capacity; ++i) {
            Entry *entry = tables[t].buckets[i];
            while (entry) {
                Entry *next = entry->next;
                free(entry);
                entry = next;
            }
        }
        free(tables[t].buckets);
    }
    *store = (Store){0};
}

static void rehash_step(Store *store, size_t budget) {
    for (size_t step = 0; store->next.capacity && step < budget; ++step) {
        Entry **source = &store->current.buckets[store->rehash_bucket];
        Entry *entry = *source;
        if (entry) {
            *source = entry->next;
            Entry **target = bucket(store->next, entry->hash);
            entry->next = *target;
            *target = entry;
        }
        if (*source) {
            continue;
        }
        ++store->rehash_bucket;
        if (store->rehash_bucket == store->current.capacity) {
            free(store->current.buckets);
            store->current = store->next;
            store->next = (Table){0};
            store->rehash_bucket = 0;
        }
    }
}

static Entry **find_in_table(Table table, Bytes key, uint64_t hash) {
    for (Entry **link = bucket(table, hash); *link; link = &(*link)->next) {
        Entry *entry = *link;
        if (entry->hash == hash && entry->key_length == key.length &&
            memcmp(entry->data, key.data, key.length) == 0) {
            return link;
        }
    }
    return NULL;
}

static Entry **find_link(Store *store, Bytes key, uint64_t hash) {
    if (store->next.capacity) {
        Entry **link = find_in_table(store->next, key, hash);
        if (link) {
            return link;
        }
    }
    return find_in_table(store->current, key, hash);
}

static void unlink_expiration(Store *store, Entry *entry) {
    if (!entry->deadline_ms) {
        return;
    }
    if (store->expire_cursor == entry) {
        store->expire_cursor = store->expiring == 1 ? NULL : entry->expire_next;
    }
    entry->expire_prev->expire_next = entry->expire_next;
    entry->expire_next->expire_prev = entry->expire_prev;
    --store->expiring;
}

static void set_deadline(Store *store, Entry *entry, uint64_t deadline_ms) {
    unlink_expiration(store, entry);
    entry->deadline_ms = deadline_ms;
    if (!deadline_ms) {
        return;
    }
    Entry *first = store->expire_cursor;
    if (!first) {
        entry->expire_next = entry;
        entry->expire_prev = entry;
        store->expire_cursor = entry;
    } else {
        entry->expire_next = first;
        entry->expire_prev = first->expire_prev;
        first->expire_prev->expire_next = entry;
        first->expire_prev = entry;
    }
    ++store->expiring;
}

static void remove_entry(Store *store, Entry **link) {
    Entry *entry = *link;
    *link = entry->next;
    unlink_expiration(store, entry);
    --store->size;
    free(entry);
}

static Entry **find_live(Store *store, Bytes key, uint64_t now_ms) {
    rehash_step(store, 2);
    Entry **link = find_link(store, key, hash_key(key));
    if (link && (*link)->deadline_ms && (*link)->deadline_ms <= now_ms) {
        remove_entry(store, link);
        return NULL;
    }
    return link;
}

bool store_set(Store *store, Bytes key, Bytes value, uint64_t deadline_ms) {
    if (key.length > SIZE_MAX - sizeof(Entry) ||
        value.length > SIZE_MAX - sizeof(Entry) - key.length) {
        return false;
    }
    Entry *entry = malloc(sizeof(*entry) + key.length + value.length);
    if (!entry) {
        return false;
    }
    *entry = (Entry){.hash = hash_key(key), .key_length = key.length, .value_length = value.length};
    memcpy(entry->data, key.data, key.length);
    memcpy(entry->data + key.length, value.data, value.length);

    rehash_step(store, 2);
    Entry **link = find_link(store, key, entry->hash);
    if (link) {
        Entry *previous = *link;
        entry->next = previous->next;
        *link = entry;
        unlink_expiration(store, previous);
        free(previous);
    } else {
        size_t capacity = store->current.capacity;
        if (!store->next.capacity && store->size >= capacity - capacity / 4 && capacity <= SIZE_MAX / 2) {
            /* An allocation failure leaves the current table usable. */
            init_table(&store->next, capacity * 2);
        }
        Table target = store->next.capacity ? store->next : store->current;
        Entry **head = bucket(target, entry->hash);
        entry->next = *head;
        *head = entry;
        ++store->size;
    }
    set_deadline(store, entry, deadline_ms);
    return true;
}

bool store_get(Store *store, Bytes key, uint64_t now_ms, Bytes *value) {
    Entry **link = find_live(store, key, now_ms);
    if (!link) {
        return false;
    }
    Entry *entry = *link;
    *value = (Bytes){entry->data + entry->key_length, entry->value_length};
    return true;
}

bool store_delete(Store *store, Bytes key, uint64_t now_ms) {
    Entry **link = find_live(store, key, now_ms);
    if (!link) {
        return false;
    }
    remove_entry(store, link);
    return true;
}

bool store_expire_at(Store *store, Bytes key, uint64_t now_ms, uint64_t deadline_ms) {
    Entry **link = find_live(store, key, now_ms);
    if (!link) {
        return false;
    }
    if (deadline_ms <= now_ms) {
        remove_entry(store, link);
    } else {
        set_deadline(store, *link, deadline_ms);
    }
    return true;
}

int64_t store_pttl(Store *store, Bytes key, uint64_t now_ms) {
    Entry **link = find_live(store, key, now_ms);
    if (!link) {
        return -2;
    }
    uint64_t deadline = (*link)->deadline_ms;
    return deadline ? (int64_t)(deadline - now_ms) : -1;
}

void store_maintain(Store *store, uint64_t now_ms) {
    rehash_step(store, 32);
    size_t budget = store->expiring < 32 ? store->expiring : 32;
    for (size_t checked = 0; checked < budget; ++checked) {
        Entry *entry = store->expire_cursor;
        store->expire_cursor = entry->expire_next;
        if (entry->deadline_ms <= now_ms) {
            Bytes key = {entry->data, entry->key_length};
            Entry **link = find_link(store, key, entry->hash);
            assert(link && *link == entry); /* The expiration list only holds indexed entries. */
            remove_entry(store, link);
        }
    }
}
