/*
 * store.h : 키-값 저장소 공개 인터페이스. 모든 시각 인자는 단조 ms, 단일 스레드에서만 호출한다.
 */

#ifndef MINI_REDIS_STORE_H
#define MINI_REDIS_STORE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* 길이를 함께 들고 다니는 바이트 조각. 끝에 널 문자가 없어도 되며 소유권은 없다(view). */
typedef struct {
    const char *data;
    size_t length;
} Bytes;

/* 저장 항목 하나(키 + 값 + 만료 정보). 내부 구조는 store.c 에만 공개한다. */
typedef struct Entry Entry;

/*
 * 만료 항목이 지워진 경로.
 * ON_ACCESS : 조회 시 만료(명령이 키에 접근하다 만료를 발견), BY_CYCLE : 주기 정리(store_maintain 이 커서에서 발견)
 */
typedef enum { STORE_EXPIRED_ON_ACCESS, STORE_EXPIRED_BY_CYCLE } StoreExpireCause;

/* 만료 항목을 지우기 직전에 불리는 알림 함수. key 는 지우기 전까지만 유효한 view 다. 시연 로그가 두 경로를 구분하는 데 쓴다. */
typedef void (*StoreExpireHook)(void *context, Bytes key, StoreExpireCause cause);

/* store_maintain 한 번의 결과. checked : 커서에서부터 검사한 항목 수(최대 32), removed : 그중 지운 수 */
typedef struct {
    size_t checked;
    size_t removed;
} StoreCycle;

/* store_foreach 가 살아 있는 항목마다 부르는 함수. false 를 돌려주면 순회를 멈춘다. deadline_ms 는 단조 시계 기준 만료 시각(0 이면 TTL 없음). */
typedef bool (*StoreVisitor)(void *context, Bytes key, Bytes value, uint64_t deadline_ms);

/*
 * 해시 테이블 하나. buckets 는 체인(연결 리스트) 머리 포인터 배열이고, capacity 는 버킷 개수다.
 */
typedef struct {
    Entry **buckets;
    size_t capacity;
} Table;

/*
 * 저장소 전체 상태.
 * current : 평소 쓰는 테이블, next : 확장(rehash) 중에만 있는 두 배 크기 테이블(없으면 capacity 0)
 * size : 저장된 항목 수, rehash_bucket : current 에서 next 로 옮기는 중인 버킷 위치
 * expire_cursor : 만료 시각이 있는 항목들의 원형 리스트에서 주기 정리가 볼 다음 항목
 * expiring : 만료 시각이 있는 항목 수
 * on_expire/expire_context : 만료 항목을 지울 때 부를 알림 함수와 그 인자(NULL 이면 부르지 않음). store_init 뒤에 호출자가 채운다.
 */
typedef struct {
    Table current;
    Table next;
    size_t size;
    size_t rehash_bucket;
    Entry *expire_cursor;
    size_t expiring;
    StoreExpireHook on_expire;
    void *expire_context;
} Store;

/* 실패하면 false 이고 저장소는 그대로다. 만료된 키는 모든 조회 함수에서 없는 키로 보인다(그 자리에서 지움). */
bool store_init(Store *store);
void store_destroy(Store *store);
/* 저장소가 키/값을 복사해서 소유한다. deadline_ms 가 0 이면 만료 시각 없음(TTL 없음). */
bool store_set(Store *store, Bytes key, Bytes value, uint64_t deadline_ms);
/* 돌려준 value 는 복사본이 아니라 항목 내부를 가리키는 view 다. 그 항목이 바뀌거나 지워지기 전까지만 유효하다. */
bool store_get(Store *store, Bytes key, uint64_t now_ms, Bytes *value);
bool store_delete(Store *store, Bytes key, uint64_t now_ms);
bool store_expire_at(Store *store, Bytes key, uint64_t now_ms, uint64_t deadline_ms);
int64_t store_pttl(Store *store, Bytes key, uint64_t now_ms);
StoreCycle store_maintain(Store *store, uint64_t now_ms);
/* 만료되지 않은 항목을 모두 방문한다(저장소를 바꾸지 않음). 방문 함수가 false 를 돌려주면 false. 스냅샷 저장이 쓴다. */
bool store_foreach(const Store *store, uint64_t now_ms, StoreVisitor visit, void *context);

#endif
