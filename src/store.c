/*
 * store.c : 체이닝 해시 테이블 + 점진적 rehash + TTL(조회 시 만료 · 주기 정리).
 * 시계는 읽지 않고 호출자가 넘긴 단조 ms 로 판정한다. 단일 스레드 전용(락 없음).
 */

#include "store.h"

#include <assert.h>
#include <stdlib.h>
#include <string.h>

/*
 * 저장 항목 하나. 한 노드가 두 연결 리스트에 동시에 들어간다.
 * next : 같은 버킷 안의 충돌 체인, expire_next/expire_prev : 만료 시각이 있는 항목의 원형 이중 연결 리스트
 * hash : 키 해시를 저장해 두어 비교와 rehash 때 다시 계산하지 않는다
 * deadline_ms : 만료 시각(절대 ms), 0 이면 TTL 없음
 */
struct Entry {
    Entry *next;
    Entry *expire_next;
    Entry *expire_prev;
    uint64_t hash;
    uint64_t deadline_ms;
    size_t key_length;
    size_t value_length;
    char data[]; /* 키 바로 뒤에 값이 이어지는 가변 길이 영역. 각각 key_length, value_length 로 구분한다. */
};

/* FNV-1a 64비트. */
static uint64_t hash_key(Bytes key) {
    uint64_t hash = UINT64_C(14695981039346656037);
    for (size_t i = 0; i < key.length; ++i) {
        hash ^= (unsigned char)key.data[i];
        hash *= UINT64_C(1099511628211);
    }
    return hash;
}

/* 버킷 머리 포인터의 주소를 돌려줘 머리 삽입과 제거를 같은 방식으로 하게 한다. */
static Entry **bucket(Table table, uint64_t hash) {
    return &table.buckets[hash % table.capacity];
}

/* 실패하면 capacity 0 : 호출자는 기존 테이블로 계속 동작할 수 있다. */
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

/* rehash 중이면 항목이 두 테이블에 나뉘어 있다. 만료 리스트는 같은 노드를 가리킬 뿐이라 따로 해제하지 않는다. */
void store_destroy(Store *store) {
    /* next 가 없으면 capacity 가 0 이라 안쪽 for 문이 돌지 않고 free(NULL) 만 일어난다. */
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

/*
 * 점진적 rehash : 한 번에 다 옮기면 그 명령 동안 모든 연결이 멈춘다(단일 스레드).
 * 한 단계 = 항목 하나 이동 또는 빈 버킷 하나 넘김. 다 옮기면 next 가 current 가 된다.
 */
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
        /* 아직 이 버킷에 항목이 남아 있으면 버킷 번호를 올리지 않고 다음 단계에서 이어서 옮긴다. */
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

/* 같은 버킷에 여러 키가 있으므로 실제 키를 비교한다. 항목이 아니라 링크를 돌려줘 제거 · 교체를 쉽게 한다. */
static Entry **find_in_table(Table table, Bytes key, uint64_t hash) {
    for (Entry **link = bucket(table, hash); *link; link = &(*link)->next) {
        Entry *entry = *link;
        /* 싼 비교부터 한다: 해시 -> 길이 -> 바이트(memcmp). 앞에서 다르면 뒤는 보지 않는다. */
        if (entry->hash == hash && entry->key_length == key.length &&
            memcmp(entry->data, key.data, key.length) == 0) {
            return link;
        }
    }
    return NULL;
}

/* rehash 중에는 항목이 current 와 next 어디에든 있다. 새 항목은 next 에 들어가므로 next 를 먼저 본다. */
static Entry **find_link(Store *store, Bytes key, uint64_t hash) {
    if (store->next.capacity) {
        Entry **link = find_in_table(store->next, key, hash);
        if (link) {
            return link;
        }
    }
    return find_in_table(store->current, key, hash);
}

/*
 * 커서가 이 항목이면 먼저 다음으로 옮긴다 : 해제된 항목을 커서가 가리키면 다음 주기 정리가 해제된 메모리를 읽는다.
 */
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

/* 만료 시각과 만료 리스트 소속이 항상 맞아야 조회 시 만료와 주기 정리가 같은 기준으로 동작한다. 새 항목은 커서 바로 앞(원형의 끝)에 넣는다. */
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

/* DEL · 조회 시 만료 · 주기 정리 · 즉시 EXPIRE 가 모두 이 함수로 지운다. */
static void remove_entry(Store *store, Entry **link) {
    Entry *entry = *link;
    /* 이중 포인터로 링크 자체를 고치므로 체인의 첫 노드든 중간 노드든 같은 코드로 빠진다(머리 노드 특수 처리 없음). */
    *link = entry->next;
    unlink_expiration(store, entry);
    --store->size;
    free(entry);
}

/* 두 만료 경로는 같은 remove_entry 로 지우므로 결과만으로는 구분이 안 된다. 경로를 알림으로 넘긴다. */
static void notify_expired(Store *store, const Entry *entry, StoreExpireCause cause) {
    if (store->on_expire) {
        store->on_expire(store->expire_context, (Bytes){entry->data, entry->key_length}, cause);
    }
}

/* 조회 시 만료 : 주기 정리가 아직 못 본 만료 항목도 접근하는 순간 지워 사용자는 만료된 값을 보지 않는다. */
static Entry **find_live(Store *store, Bytes key, uint64_t now_ms) {
    rehash_step(store, 2);
    Entry **link = find_link(store, key, hash_key(key));
    /* lazy expiration: deadline_ms 가 0 이면 TTL 없음이라 건너뛰고, 현재 시각 이하이면 만료된 것으로 본다. */
    if (link && (*link)->deadline_ms && (*link)->deadline_ms <= now_ms) {
        notify_expired(store, *link, STORE_EXPIRED_ON_ACCESS);
        remove_entry(store, link);
        return NULL;
    }
    return link;
}

/* 키 · 값을 복사해 소유한다(호출자 버퍼는 바로 버려도 된다). 덮어쓰면 TTL 도 새 값이고, 만료 여부는 보지 않는다. */
bool store_set(Store *store, Bytes key, Bytes value, uint64_t deadline_ms) {
    if (key.length > SIZE_MAX - sizeof(Entry) ||
        value.length > SIZE_MAX - sizeof(Entry) - key.length) {
        return false;
    }
    /* 키와 값을 한 번의 할당으로 붙여 저장한다(data[] 뒤에 키, 그 뒤에 값). */
    Entry *entry = malloc(sizeof(*entry) + key.length + value.length);
    if (!entry) {
        return false;
    }
    *entry = (Entry){.hash = hash_key(key), .key_length = key.length, .value_length = value.length};
    memcpy(entry->data, key.data, key.length);
    memcpy(entry->data + key.length, value.data, value.length);

    rehash_step(store, 2);
    /* 이미 있는 키면 같은 자리의 노드를 새 노드로 바꾼다. 체인 연결(next)을 물려받아 위치는 그대로다. */
    Entry **link = find_link(store, key, entry->hash);
    if (link) {
        Entry *previous = *link;
        entry->next = previous->next;
        *link = entry;
        unlink_expiration(store, previous);
        free(previous);
    } else {
        /* 적재율 75%(size >= capacity - capacity/4)에 닿고 아직 확장 중이 아니면 두 배 크기 next 테이블을 만든다. */
        size_t capacity = store->current.capacity;
        if (!store->next.capacity && store->size >= capacity - capacity / 4 && capacity <= SIZE_MAX / 2) {
            /* 할당에 실패해도 current 테이블은 그대로 쓸 수 있으므로 반환값은 무시한다(체인이 길어질 뿐). */
            init_table(&store->next, capacity * 2);
        }
        /* 확장 중이면 새 항목은 next 에 넣는다. 그래야 current 가 점점 비어 rehash 가 끝난다. */
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

/* 키 하나를 삭제하는 함수(DEL). 이미 만료된 키는 지운 수에 세지 않는다. */
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

/*
 * 주기 정리 : 아무도 읽지 않는 만료 키를 회수한다. 한 번에 최대 32개만 검사해 호출이 길어지지 않게 하고,
 * 커서는 원형 리스트를 따라 다음 호출에서 이어 돈다.
 */
StoreCycle store_maintain(Store *store, uint64_t now_ms) {
    rehash_step(store, 32);
    /* 한 번에 최대 32개까지만 검사한다. 만료 리스트는 원형이라 커서가 다음 호출에서 이어 돈다. */
    StoreCycle cycle = {.checked = store->expiring < 32 ? store->expiring : 32};
    for (size_t checked = 0; checked < cycle.checked; ++checked) {
        Entry *entry = store->expire_cursor;
        /* 해제한 뒤에는 entry->expire_next 를 읽을 수 없으므로 지우기 전에 커서를 다음 항목으로 옮긴다. */
        store->expire_cursor = entry->expire_next;
        if (entry->deadline_ms <= now_ms) {
            Bytes key = {entry->data, entry->key_length};
            Entry **link = find_link(store, key, entry->hash);
            assert(link && *link == entry); /* 만료 리스트에는 테이블에 들어 있는 항목만 있다. */
            notify_expired(store, entry, STORE_EXPIRED_BY_CYCLE);
            remove_entry(store, link);
            ++cycle.removed;
        }
    }
    return cycle;
}

bool store_foreach(const Store *store, uint64_t now_ms, StoreVisitor visit, void *context) {
    const Table tables[] = {store->current, store->next};
    for (size_t t = 0; t < 2; ++t) {
        for (size_t i = 0; i < tables[t].capacity; ++i) {
            for (const Entry *entry = tables[t].buckets[i]; entry; entry = entry->next) {
                if (entry->deadline_ms && entry->deadline_ms <= now_ms) {
                    continue;
                }
                Bytes key = {entry->data, entry->key_length};
                Bytes value = {entry->data + entry->key_length, entry->value_length};
                if (!visit(context, key, value, entry->deadline_ms)) {
                    return false;
                }
            }
        }
    }
    return true;
}
