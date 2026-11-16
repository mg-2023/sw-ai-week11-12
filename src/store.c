/*
 * store.c
 *
 * 정의 : 체이닝 해시 테이블 기반 키-값 저장소와 TTL(만료) 관리 구현.
 * 책임 :
 *   - 해시 테이블 : 충돌은 버킷마다 연결 리스트(체이닝)로 처리한다. 적재율 75% 에서 두 배로 늘린다.
 *   - 점진적 rehash : 확장을 한 번에 하지 않고 접근할 때마다 조금씩 옮겨 한 명령의 지연을 줄인다.
 *   - 조회 시 만료(lazy expiration) : 접근한 키가 이미 만료됐으면 그때 지운다.
 *   - 주기 정리(active expiration) : store_maintain 이 만료 시각이 있는 항목을 일부씩 훑어 지운다.
 *   - 맡지 않는 것 : 시계 읽기, 명령 해석, 응답 만들기, 락(단일 스레드라 필요 없음)
 * 위치 : commands.c 가 명령 처리 중에 부르고, server.c 의 이벤트 루프가 store_maintain 과 store_init/destroy 를 부른다.
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

/*
 * 정의 : 키 바이트열의 64비트 해시값을 계산하는 함수(FNV-1a).
 * 설명 : 해시 테이블은 키를 해시로 버킷 위치를 정한다. 같은 키는 항상 같은 값이 나와야 하고 키가 고르게 퍼져야 체인이 짧아진다.
 * 입력 : key : 해시할 키
 * 출력 : 64비트 해시값
 * 동작 :
 *   1. 시작값(offset basis)으로 초기화한다.
 *   2. 키의 각 바이트마다 XOR 한 뒤 소수(prime)를 곱한다.
 *   3. 최종 값을 돌려준다.
 */
static uint64_t hash_key(Bytes key) {
    uint64_t hash = UINT64_C(14695981039346656037);
    for (size_t i = 0; i < key.length; ++i) {
        hash ^= (unsigned char)key.data[i];
        hash *= UINT64_C(1099511628211);
    }
    return hash;
}

/*
 * 정의 : 해시값이 속한 버킷의 머리 포인터 자리(Entry 포인터의 주소)를 돌려주는 함수.
 * 설명 : 해시 테이블에서 해시를 용량으로 나눈 나머지가 버킷 번호다. 이중 포인터로 주면 호출자가 머리 삽입과 제거를 같은 방식으로 할 수 있다.
 * 입력 : table : 대상 테이블, hash : 키 해시
 * 출력 : 해당 버킷 머리 포인터의 주소
 * 동작 :
 *   1. hash % capacity 로 버킷 번호를 구한다.
 *   2. 그 버킷 슬롯의 주소를 돌려준다.
 */
static Entry **bucket(Table table, uint64_t hash) {
    return &table.buckets[hash % table.capacity];
}

/*
 * 정의 : 버킷 배열을 0 으로 채워 할당해 테이블을 초기화하는 함수.
 * 설명 : 해시 테이블 생성과 확장(두 배 크기 next 테이블)이 공통으로 쓴다. 실패해도 호출자가 기존 테이블로 계속 동작할 수 있게 실패를 값으로 알린다.
 * 입력 : table : 초기화할 테이블, capacity : 버킷 수
 * 출력 : 성공하면 true, 크기 계산이 넘치거나 할당에 실패하면 false(이때 capacity 는 0)
 * 동작 :
 *   1. 버킷 배열 크기가 size_t 범위를 넘는지 검사한다.
 *   2. calloc 으로 빈 버킷 배열을 만든다.
 *   3. 성공했을 때만 capacity 를 기록한다.
 */
static bool init_table(Table *table, size_t capacity) {
    if (capacity > SIZE_MAX / sizeof(*table->buckets)) {
        return false;
    }
    table->buckets = calloc(capacity, sizeof(*table->buckets));
    table->capacity = table->buckets ? capacity : 0;
    return table->buckets != NULL;
}

/*
 * 정의 : 빈 저장소를 만드는 함수.
 * 설명 : 서버 시작 시 한 번 부른다. 처음에는 작은 테이블(버킷 8개)로 시작해 적재율에 따라 자란다.
 * 입력 : store : 초기화할 저장소
 * 출력 : 성공하면 true, 메모리 할당 실패 시 false
 * 동작 :
 *   1. 저장소 전체를 0 으로 만든다.
 *   2. 버킷 8개짜리 current 테이블을 만든다.
 */
bool store_init(Store *store) {
    *store = (Store){0};
    return init_table(&store->current, 8);
}

/*
 * 정의 : 저장소가 가진 모든 항목과 테이블을 해제하는 함수.
 * 설명 : 종료 시 메모리를 정리한다. rehash 중이면 항목이 current 와 next 에 나뉘어 있으므로 두 테이블을 모두 비운다.
 * 입력 : store : 해제할 저장소
 * 출력 : 없음(저장소는 0 으로 초기화된다)
 * 동작 :
 *   1. current, next 두 테이블을 차례로 본다.
 *   2. 각 버킷 체인을 따라가며 항목을 하나씩 free 한다(만료 리스트는 같은 항목을 가리킬 뿐이라 따로 해제하지 않는다).
 *   3. 버킷 배열을 free 한다.
 *   4. 저장소를 0 으로 되돌린다.
 */
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
 * 정의 : 확장 중인 테이블에서 항목을 budget 단계만큼 current 에서 next 로 옮기는 함수(점진적 rehash).
 * 설명 : 해시 테이블을 두 배로 늘릴 때 모든 항목을 한 번에 옮기면 그 명령만 오래 걸린다. 단일 스레드 이벤트 루프에서는 그동안 모든 클라이언트가 멈추므로 조금씩 나눠 옮긴다.
 * 입력 : store : 저장소, budget : 최대 단계 수(한 단계 = 항목 하나 이동 또는 빈 버킷 하나 넘김)
 * 출력 : 없음. 확장 중이 아니면 아무 일도 하지 않는다.
 * 동작 :
 *   1. next 테이블이 없으면 바로 끝낸다.
 *   2. current 의 rehash_bucket 번 버킷에서 맨 앞 항목 하나를 떼어 next 의 해당 버킷 머리에 붙인다.
 *   3. 그 버킷에 항목이 남았으면 같은 버킷을 계속 처리한다.
 *   4. 비었으면 다음 버킷으로 넘어간다.
 *   5. 모든 버킷을 옮겼으면 옛 버킷 배열을 free 하고 next 를 current 로 바꾼다.
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

/*
 * 정의 : 한 테이블의 버킷 체인에서 키가 같은 항목을 찾는 함수.
 * 설명 : 충돌 체이닝에서는 같은 버킷에 여러 키가 들어 있으므로 체인을 따라가며 실제 키를 비교해야 한다. 항목이 아니라 그 항목을 가리키는 링크를 돌려주면 제거와 교체가 쉽다.
 * 입력 : table : 찾을 테이블, key : 찾을 키, hash : 키의 해시
 * 출력 : 항목을 가리키는 포인터의 주소(없으면 NULL)
 * 동작 :
 *   1. 해시로 버킷을 정한다.
 *   2. 체인을 처음부터 끝까지 따라간다.
 *   3. 해시, 키 길이, 키 바이트 순으로 비교한다.
 *   4. 모두 같으면 그 링크를 돌려주고, 끝까지 없으면 NULL 을 돌려준다.
 */
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

/*
 * 정의 : 저장소 전체에서 키의 링크를 찾는 함수. rehash 중인 상황도 처리한다.
 * 설명 : 점진적 rehash 중에는 항목이 current 와 next 어디에든 있을 수 있어서 두 테이블을 모두 봐야 한다.
 * 입력 : store : 저장소, key : 찾을 키, hash : 키의 해시
 * 출력 : 항목을 가리키는 포인터의 주소(없으면 NULL)
 * 동작 :
 *   1. next 테이블이 있으면 먼저 거기서 찾는다(새 항목은 next 에 들어간다).
 *   2. 없으면 current 에서 찾아 결과를 돌려준다.
 */
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
 * 정의 : 항목을 만료 리스트(원형 이중 연결 리스트)에서 떼어 내는 함수.
 * 설명 : 주기 정리가 훑는 리스트에는 만료 시각이 있는 항목만 있어야 한다. 항목이 지워지거나 TTL 이 바뀌면 리스트에서도 빼서 해제된 항목을 가리키지 않게 한다.
 * 입력 : store : 저장소, entry : 떼어 낼 항목
 * 출력 : 없음. TTL 이 없는 항목이면 아무것도 하지 않는다.
 * 동작 :
 *   1. deadline_ms 가 0 이면 리스트에 없으므로 끝낸다.
 *   2. 정리 커서가 이 항목을 가리키면 다음 항목으로 옮기고, 유일한 항목이었다면 NULL 로 만든다.
 *   3. 앞뒤 항목을 서로 이어 이 항목을 건너뛰게 한다.
 *   4. expiring 개수를 하나 줄인다.
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

/*
 * 정의 : 항목의 만료 시각을 바꾸고 만료 리스트에 반영하는 함수.
 * 설명 : TTL 을 새로 주거나 덮어쓰거나 없앨 때 만료 시각과 리스트 소속이 항상 맞아야 주기 정리와 조회 시 만료가 같은 기준으로 동작한다.
 * 입력 : store : 저장소, entry : 대상 항목, deadline_ms : 새 만료 시각(절대 ms, 0 이면 TTL 제거)
 * 출력 : 없음
 * 동작 :
 *   1. 기존에 리스트에 있었다면 먼저 뺀다.
 *   2. deadline_ms 를 기록한다. 0 이면 여기서 끝낸다(TTL 없음).
 *   3. 리스트가 비었으면 자기 자신만 있는 원형 리스트로 만들고 정리 커서로 둔다.
 *   4. 아니면 커서 바로 앞(원형 리스트의 끝)에 끼워 넣는다.
 *   5. expiring 개수를 하나 늘린다.
 */
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

/*
 * 정의 : 링크가 가리키는 항목을 체인과 만료 리스트에서 빼고 해제하는 함수.
 * 설명 : 삭제(DEL), 만료된 항목 정리(조회 시 만료, 주기 정리), 즉시 만료(EXPIRE 0 이하)가 모두 같은 방식으로 항목을 지운다.
 * 입력 : store : 저장소, link : 지울 항목을 가리키는 포인터의 주소(find_* 가 돌려준 값)
 * 출력 : 없음
 * 동작 :
 *   1. 링크를 항목의 다음 노드로 바꿔 체인에서 뺀다.
 *   2. 만료 리스트에서 뗀다.
 *   3. size 를 줄이고 메모리를 해제한다.
 */
static void remove_entry(Store *store, Entry **link) {
    Entry *entry = *link;
    /* 이중 포인터로 링크 자체를 고치므로 체인의 첫 노드든 중간 노드든 같은 코드로 빠진다(머리 노드 특수 처리 없음). */
    *link = entry->next;
    unlink_expiration(store, entry);
    --store->size;
    free(entry);
}

/*
 * 정의 : 만료 항목을 지우기 직전에 등록된 알림 함수를 부르는 함수.
 * 설명 : 조회 시 만료와 주기 정리는 같은 remove_entry 로 지우므로 결과만 보면 구분이 안 된다. 지우는 경로를 알림으로 넘겨 시연 로그가 두 경로를 나눠 기록하게 한다.
 * 입력 : store : 저장소, entry : 지울 항목(아직 해제 전), cause : 지우는 경로
 * 출력 : 없음. 알림 함수가 없으면 아무것도 하지 않는다.
 * 동작 :
 *   1. on_expire 가 있으면 항목의 키 view 와 경로를 넘겨 부른다.
 */
static void notify_expired(Store *store, const Entry *entry, StoreExpireCause cause) {
    if (store->on_expire) {
        store->on_expire(store->expire_context, (Bytes){entry->data, entry->key_length}, cause);
    }
}

/*
 * 정의 : 살아 있는(만료되지 않은) 항목만 찾아 주는 함수. 만료된 항목은 이때 지운다.
 * 설명 : 조회 시 만료(lazy expiration)의 핵심이다. 주기 정리가 아직 못 본 항목이라도 접근하는 순간 만료를 확인하므로 사용자는 만료된 값을 절대 보지 않는다. 모든 읽기 · 쓰기 명령이 이 함수를 거친다.
 * 입력 : store : 저장소, key : 찾을 키, now_ms : 현재 시각(ms)
 * 출력 : 살아 있는 항목의 링크, 없거나 만료돼 지웠으면 NULL
 * 동작 :
 *   1. rehash 를 2단계 진행한다(접근할 때 덤으로 확장을 조금 진행).
 *   2. 키를 찾는다.
 *   3. 찾았고 만료 시각이 now_ms 이하이면 알림(조회 시 만료)을 보내고 항목을 지운 뒤 NULL 을 돌려준다.
 *   4. 그 외에는 찾은 링크를 돌려준다.
 */
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

/*
 * 정의 : 키에 값을 저장하는 함수(SET). 이미 있으면 덮어쓴다.
 * 설명 : SET 명령의 저장 부분이다. 키와 값을 복사해 소유하므로 호출자의 입력 버퍼가 사라져도 안전하다. 덮어쓰면 TTL 도 새 값(deadline_ms)으로 바뀐다. 적재율이 75% 에 닿으면 테이블 확장을 시작한다.
 * 입력 : store : 저장소, key/value : 저장할 키와 값, deadline_ms : 만료 시각(절대 ms, 0 이면 TTL 없음)
 * 출력 : 성공하면 true, 크기 계산 넘침이나 메모리 할당 실패면 false(저장소는 그대로)
 * 동작 :
 *   1. 항목 크기를 계산하고 넘치는지 검사한다.
 *   2. 항목 하나를 할당해 해시, 키, 값을 채운다.
 *   3. rehash 를 2단계 진행하고 같은 키가 있는지 찾는다.
 *   4. 있으면 새 노드로 갈아 끼우고 옛 노드는 만료 리스트에서 뗀 뒤 해제한다.
 *   5. 없으면 필요할 때 next 테이블을 만들고, 대상 테이블 버킷 머리에 삽입한 뒤 size 를 늘린다.
 *   6. 만료 시각을 설정한다.
 */
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

/*
 * 정의 : 키의 값을 읽는 함수(GET).
 * 설명 : GET 명령의 조회 부분이다. find_live 를 거치므로 만료된 키는 없는 것으로 보인다. 값은 복사하지 않고 항목 내부를 가리키는 view 로 준다.
 * 입력 : store : 저장소, key : 조회할 키, now_ms : 현재 시각(ms), value : 결과를 받을 곳
 * 출력 : 키가 살아 있으면 true 와 value, 없거나 만료됐으면 false
 * 동작 :
 *   1. find_live 로 살아 있는 항목을 찾는다.
 *   2. 없으면 false 를 돌려준다.
 *   3. 항목 data 에서 키 뒤쪽(값 영역)을 가리키는 view 를 만들어 value 에 담는다.
 */
bool store_get(Store *store, Bytes key, uint64_t now_ms, Bytes *value) {
    Entry **link = find_live(store, key, now_ms);
    if (!link) {
        return false;
    }
    Entry *entry = *link;
    *value = (Bytes){entry->data + entry->key_length, entry->value_length};
    return true;
}

/*
 * 정의 : 키를 삭제하는 함수(DEL 한 개분).
 * 설명 : DEL 명령이 키마다 부른다. 이미 만료된 키는 find_live 가 없는 것으로 처리하므로 삭제 개수에 세지 않는다.
 * 입력 : store : 저장소, key : 삭제할 키, now_ms : 현재 시각(ms)
 * 출력 : 실제로 지웠으면 true, 없었거나 이미 만료됐으면 false
 * 동작 :
 *   1. find_live 로 살아 있는 항목을 찾는다.
 *   2. 없으면 false 를 돌려준다.
 *   3. 항목을 지우고 true 를 돌려준다.
 */
bool store_delete(Store *store, Bytes key, uint64_t now_ms) {
    Entry **link = find_live(store, key, now_ms);
    if (!link) {
        return false;
    }
    remove_entry(store, link);
    return true;
}

/*
 * 정의 : 키의 만료 시각을 지정하는 함수(EXPIRE, PEXPIRE).
 * 설명 : 캐시 항목이 일정 시간 뒤 스스로 사라지게 하는(무효화) 수단이다. 만료 시각이 이미 지났거나 지금이면 즉시 삭제한다.
 * 입력 : store : 저장소, key : 대상 키, now_ms : 현재 시각(ms), deadline_ms : 새 만료 시각(절대 ms)
 * 출력 : 키가 살아 있었으면 true, 없으면 false
 * 동작 :
 *   1. find_live 로 살아 있는 항목을 찾는다. 없으면 false.
 *   2. deadline_ms 가 now_ms 이하이면 즉시 지운다.
 *   3. 아니면 set_deadline 으로 만료 시각을 바꾼다.
 *   4. true 를 돌려준다.
 */
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

/*
 * 정의 : 키가 만료되기까지 남은 시간을 ms 로 돌려주는 함수(PTTL).
 * 설명 : TTL 이 제대로 걸렸는지, 캐시가 언제 무효화되는지 확인하는 용도다. Redis 규약대로 키 없음과 TTL 없음을 음수 값으로 구분한다.
 * 입력 : store : 저장소, key : 대상 키, now_ms : 현재 시각(ms)
 * 출력 : 남은 ms, TTL 이 없으면 -1, 키가 없거나 만료됐으면 -2
 * 동작 :
 *   1. find_live 로 살아 있는 항목을 찾는다. 없으면 -2.
 *   2. 만료 시각이 0 이면 -1 을 돌려준다.
 *   3. 그 외에는 만료 시각에서 now_ms 를 뺀 값을 돌려준다.
 */
int64_t store_pttl(Store *store, Bytes key, uint64_t now_ms) {
    Entry **link = find_live(store, key, now_ms);
    if (!link) {
        return -2;
    }
    uint64_t deadline = (*link)->deadline_ms;
    return deadline ? (int64_t)(deadline - now_ms) : -1;
}

/*
 * 정의 : 주기적으로 불려 만료된 항목을 일부 지우는 함수(주기 정리, active expiration).
 * 설명 : 조회 시 만료만으로는 아무도 다시 읽지 않는 만료 키가 메모리에 남는다. 그래서 이벤트 루프가 일정 간격으로 이 함수를 불러 청소한다. 한 번에 보는 개수를 제한해 한 번의 호출이 길어지지 않게 한다(단일 스레드 이벤트 루프의 응답 지연 보호).
 * 입력 : store : 저장소, now_ms : 현재 시각(ms)
 * 출력 : 이번 호출에서 검사한 항목 수와 지운 항목 수
 * 동작 :
 *   1. rehash 를 32단계 진행한다.
 *   2. 검사 개수(budget)를 min(만료 시각이 있는 항목 수, 32)로 정한다.
 *   3. 정리 커서가 가리키는 항목을 보고 커서를 다음으로 옮긴다.
 *   4. 만료됐으면 알림(주기 정리)을 보내고 키로 링크를 다시 찾아 항목을 지운다.
 *   5. budget 만큼 반복하고 검사 · 삭제 수를 돌려준다.
 */
StoreCycle store_maintain(Store *store, uint64_t now_ms) {
    rehash_step(store, 32);
    /* 한 번에 최대 32개까지만 검사한다. 만료 리스트는 원형이라 커서가 다음 호출에서 이어 돈다. */
    StoreCycle cycle = {.checked = store->expiring < 32 ? store->expiring : 32};
    for (size_t checked = 0; checked < cycle.checked; ++checked) {
        Entry *entry = store->expire_cursor;
        /* 지우기 전에 커서를 먼저 옮겨 둔다(지워지는 항목을 커서가 가리키지 않게). */
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

/*
 * 정의 : 만료되지 않은 모든 항목을 차례로 방문하는 함수.
 * 설명 : 스냅샷은 특정 시점의 키 · 값 · 만료 시각을 통째로 써야 한다. 저장소 내부 구조(두 테이블, 체인)를 밖에 드러내지 않고 항목만 넘긴다. 읽기만 하므로 rehash 나 만료 삭제를 하지 않는다.
 * 입력 : store : 저장소, now_ms : 현재 시각(이 시각에 만료된 항목은 건너뜀), visit : 방문 함수, context : 방문 함수에 넘길 값
 * 출력 : 끝까지 방문했으면 true, 방문 함수가 false 를 돌려주면 그 자리에서 false
 * 동작 :
 *   1. current, next 두 테이블의 버킷 체인을 차례로 따라간다.
 *   2. 만료 시각이 있고 now_ms 이하인 항목은 건너뛴다.
 *   3. 나머지는 키 · 값 view 와 만료 시각을 visit 에 넘긴다.
 */
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
