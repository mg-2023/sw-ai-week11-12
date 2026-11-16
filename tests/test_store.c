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

/* 만료 알림을 받은 횟수를 경로별로 세는 기록 (조회 시 만료와 주기 정리를 구분하는 시험용) */
typedef struct {
    int on_access;
    int by_cycle;
    char last_key[32];
} ExpireCount;

static void count_expired(void *context, Bytes key, StoreExpireCause cause) {
    ExpireCount *count = context;
    if (cause == STORE_EXPIRED_ON_ACCESS) {
        ++count->on_access;
    } else {
        ++count->by_cycle;
    }
    snprintf(count->last_key, sizeof(count->last_key), "%.*s", (int)key.length, key.data);
}

/* 시각을 직접 넘겨 두 경로를 따로 확인한다 : 조회한 키는 조회 시 만료로만, 아무도 조회하지 않은 키는 주기 정리로만 지워진다 */
static void test_expire_paths_are_distinguished(void) {
    Store store;
    Bytes value;
    ExpireCount count = {0};
    assert(store_init(&store));
    store.on_expire = count_expired;
    store.expire_context = &count;
    assert(store_set(&store, BYTES("read-me"), BYTES("v"), 100));
    assert(store_set(&store, BYTES("nobody"), BYTES("v"), 100));

    /* 시각 150 : 주기 정리를 부르지 않은 채 조회하면 그 키만 조회 시 만료로 지워진다 */
    assert(!store_get(&store, BYTES("read-me"), 150, &value));
    assert(count.on_access == 1 && count.by_cycle == 0 && strcmp(count.last_key, "read-me") == 0);
    assert(store.size == 1 && store.expiring == 1);

    /* 조회하지 않은 키는 만료 시각이 지나도 주기 정리 전까지 메모리에 남는다 */
    StoreCycle cycle = store_maintain(&store, 150);
    assert(cycle.checked == 1 && cycle.removed == 1);
    assert(count.on_access == 1 && count.by_cycle == 1 && strcmp(count.last_key, "nobody") == 0);
    assert(store.size == 0 && store.expiring == 0);

    /* DEL 은 만료가 아니므로 알림이 없다 (TTL 이 남은 키의 무효화) */
    assert(store_set(&store, BYTES("cache"), BYTES("v"), 30000));
    assert(store_delete(&store, BYTES("cache"), 200));
    assert(!store_get(&store, BYTES("cache"), 200, &value));
    assert(count.on_access == 1 && count.by_cycle == 1 && store.size == 0 && store.expiring == 0);
    store_destroy(&store);
}

/* 주기 정리는 커서에서부터 한 번에 최대 32개만 검사하고, 다음 호출은 멈춘 자리에서 이어 간다 */
static void test_cycle_checks_at_most_32_from_cursor(void) {
    Store store;
    char buffer[32];
    assert(store_init(&store));
    for (int i = 0; i < 40; ++i) {
        assert(store_set(&store, numbered_key(buffer, i), BYTES("v"), i < 20 ? 100 : 5000));
    }
    StoreCycle first = store_maintain(&store, 200);
    assert(first.checked == 32 && first.removed == 20 && store.expiring == 20);
    StoreCycle second = store_maintain(&store, 200);
    assert(second.checked == 20 && second.removed == 0);
    store_destroy(&store);
}

/* 순회는 만료된 항목을 건너뛰고 저장소를 바꾸지 않는다 (스냅샷 저장이 쓴다) */
static bool count_live(void *context, Bytes key, Bytes value, uint64_t deadline_ms) {
    (void)key;
    (void)value;
    (void)deadline_ms;
    ++*(int *)context;
    return true;
}

static void test_foreach_skips_expired(void) {
    Store store;
    int live = 0;
    assert(store_init(&store));
    assert(store_set(&store, BYTES("a"), BYTES("1"), 0));
    assert(store_set(&store, BYTES("b"), BYTES("2"), 50));
    assert(store_set(&store, BYTES("c"), BYTES("3"), 500));
    assert(store_foreach(&store, 100, count_live, &live));
    assert(live == 2 && store.size == 3);
    store_destroy(&store);
}

int main(void) {
    test_binary_and_collision();
    test_expiration();
    test_incremental_resize();
    test_bounded_active_expiration();
    test_expire_paths_are_distinguished();
    test_cycle_checks_at_most_32_from_cursor();
    test_foreach_skips_expired();
    puts("7 store unit scenarios passed");
    return 0;
}
