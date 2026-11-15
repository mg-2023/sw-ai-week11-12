/*
 * store.h
 *
 * 정의 : 키-값 저장소(Store)의 공개 인터페이스. 해시 테이블 + 만료 시각(TTL)을 한 모듈로 묶는다.
 * 책임 :
 *   - 맡는 것 : 키/값 저장, 조회, 삭제, 만료 시각 지정, 남은 시간 조회, 주기 정리 호출점
 *   - 맡지 않는 것 : 명령 해석(commands.c), RESP 파싱(resp.c), 소켓 · 이벤트 루프(server.c, net.c)
 *   - 시간은 직접 읽지 않는다. 호출자가 now_ms 를 넘겨 준다.
 * 위치 : commands.c 가 명령마다 store_* 를 부르고, server.c 가 주기적으로 store_maintain 을 부른다.
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
 */
typedef struct {
    Table current;
    Table next;
    size_t size;
    size_t rehash_bucket;
    Entry *expire_cursor;
    size_t expiring;
} Store;

/* 아래 함수들의 정의 · 설명 · 동작은 store.c 의 각 함수 위 주석을 본다. */
bool store_init(Store *store);
void store_destroy(Store *store);
/* 저장소가 키/값을 복사해서 소유한다. deadline_ms 가 0 이면 만료 시각 없음(TTL 없음). */
bool store_set(Store *store, Bytes key, Bytes value, uint64_t deadline_ms);
/* 돌려준 value 는 복사본이 아니라 항목 내부를 가리키는 view 다. 그 항목이 바뀌거나 지워지기 전까지만 유효하다. */
bool store_get(Store *store, Bytes key, uint64_t now_ms, Bytes *value);
bool store_delete(Store *store, Bytes key, uint64_t now_ms);
bool store_expire_at(Store *store, Bytes key, uint64_t now_ms, uint64_t deadline_ms);
int64_t store_pttl(Store *store, Bytes key, uint64_t now_ms);
void store_maintain(Store *store, uint64_t now_ms);

#endif
