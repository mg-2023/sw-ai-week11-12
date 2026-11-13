#include "store.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

#define BYTES(literal) ((Bytes){literal, sizeof(literal) - 1})

static void expect_value(Store *store, Bytes key, uint64_t now, Bytes expected) {
    Bytes value;
    assert(store_get(store, key, now, &value));
    assert(value.length == expected.length);
    assert(memcmp(value.data, expected.data, value.length) == 0);
}

static void test_binary_and_collision(void) {
    Store store;
    assert(store_init(&store));
    // FNV-1a puts these two keys in the same initial bucket.
    assert(store_set(&store, BYTES("a"), BYTES("left"), 0));
    assert(store_set(&store, BYTES("i"), BYTES("right"), 0));
    assert(store_set(&store, BYTES("a\0"), BYTES("v\0\r\n"), 0));
    assert(store_set(&store, BYTES(""), BYTES(""), 0));
    assert(store.size == 4);
    expect_value(&store, BYTES("a"), 10, BYTES("left"));
    expect_value(&store, BYTES("a\0"), 10, BYTES("v\0\r\n"));
    expect_value(&store, BYTES(""), 10, BYTES(""));
    assert(store_delete(&store, BYTES("a"), 10));
    assert(!store_delete(&store, BYTES("a"), 10));
    expect_value(&store, BYTES("i"), 10, BYTES("right"));
    assert(store_set(&store, BYTES("i"), BYTES("new"), 0));
    expect_value(&store, BYTES("i"), 10, BYTES("new"));
    assert(store.size == 3);
    store_destroy(&store);
}

static void test_expiration(void) {
    Store store;
    Bytes value;
    assert(store_init(&store));
    assert(store_set(&store, BYTES("key"), BYTES("one"), 105));
    expect_value(&store, BYTES("key"), 104, BYTES("one"));
    assert(store_pttl(&store, BYTES("key"), 104) == 1);
    assert(!store_get(&store, BYTES("key"), 105, &value));
    assert(store.size == 0 && store.expiring == 0);
    assert(store_pttl(&store, BYTES("key"), 105) == -2);
    assert(store_set(&store, BYTES("key"), BYTES("two"), 110));
    assert(store_set(&store, BYTES("key"), BYTES("three"), 0));
    assert(store_pttl(&store, BYTES("key"), 111) == -1);
    assert(store_expire_at(&store, BYTES("key"), 111, 115));
    assert(store_expire_at(&store, BYTES("key"), 112, 120));
    expect_value(&store, BYTES("key"), 115, BYTES("three"));
    assert(store_expire_at(&store, BYTES("key"), 116, 116));
    assert(!store_get(&store, BYTES("key"), 116, &value));
    assert(!store_expire_at(&store, BYTES("key"), 116, 125));
    store_destroy(&store);
}

static Bytes numbered_key(char *buffer, int number) {
    int length = snprintf(buffer, 32, "key-%d", number);
    assert(length > 0 && length < 32);
    return (Bytes){buffer, (size_t)length};
}

static void test_incremental_resize(void) {
    Store store;
    char buffer[32];
    assert(store_init(&store));
    for (int i = 0; i < 7; ++i) {
        Bytes key = numbered_key(buffer, i);
        assert(store_set(&store, key, key, 0));
    }
    assert(store.current.capacity == 8 && store.next.capacity == 16);
    assert(store.rehash_bucket == 0);
    Bytes key = numbered_key(buffer, 0);
    expect_value(&store, key, 1, key);
    assert(store.next.capacity && store.rehash_bucket <= 2);
    assert(store_delete(&store, numbered_key(buffer, 5), 1));
    assert(store_set(&store, numbered_key(buffer, 6), BYTES("changed"), 0));
    for (int i = 7; i < 500; ++i) {
        key = numbered_key(buffer, i);
        assert(store_set(&store, key, key, 0));
    }
    for (int i = 0; i < 500; ++i) {
        key = numbered_key(buffer, i);
        if (i != 5) {
            expect_value(&store, key, 1, i == 6 ? BYTES("changed") : key);
        }
    }
    while (store.next.capacity) {
        store_maintain(&store, 1);
    }
    assert(store.size == 499 && store.current.capacity > 8);
    store_destroy(&store);
}

static void test_bounded_active_expiration(void) {
    Store store;
    char buffer[32];
    assert(store_init(&store));
    for (int i = 0; i < 100; ++i) {
        Bytes key = numbered_key(buffer, i);
        assert(store_set(&store, key, key, i < 10 ? 1000 : 100));
    }
    assert(store_set(&store, BYTES("permanent"), BYTES("kept"), 0));
    store_maintain(&store, 100);
    assert(store.expiring >= 68 && store.expiring < 100);
    for (int i = 0; i < 10; ++i) {
        store_maintain(&store, 100);
    }
    assert(store.expiring == 10 && store.size == 11);
    store_maintain(&store, 1000);
    assert(store.expiring == 0 && store.size == 1 && !store.expire_cursor);
    expect_value(&store, BYTES("permanent"), 1000, BYTES("kept"));
    store_destroy(&store);
}

int main(void) {
    test_binary_and_collision();
    test_expiration();
    test_incremental_resize();
    test_bounded_active_expiration();
    puts("4 store unit scenarios passed");
    return 0;
}
