/*
 * persist.h
 *
 * 정의 : 장애 복구용 영속성 모듈의 공개 인터페이스. RDB 방식의 스냅샷을 제공한다.
 * 책임 :
 *   - 스냅샷 : 특정 시점의 키 · 값 · 만료 시각을 파일 하나에 쓰고, 재시작할 때 읽어 저장소를 채운다.
 *   - 만료 시각은 파일에 벽시계 기준 절대 시각(Unix ms)으로 쓴다. 저장소의 단조 시계 값은 재부팅이나 재시작 뒤 의미가 없기 때문이다.
 *   - 맡지 않는 것 : 명령 해석(commands.c), 언제 저장할지 결정(server.c), 시계 읽기(호출자가 now_ms, unix_ms 를 넘김)
 * 위치 : server.c 가 시작할 때 snapshot_load 를, SAVE 명령에서 snapshot_save 를 부른다.
 */

#ifndef MINI_REDIS_PERSIST_H
#define MINI_REDIS_PERSIST_H

#include "store.h"

/*
 * 불러오기 결과.
 * loaded : 저장소에 반영한 항목 수, skipped_expired : 서버가 꺼져 있는 동안 만료돼 반영하지 않은 수, error : 실패 이유
 */
typedef struct {
    size_t loaded;
    size_t skipped_expired;
    char error[192];
} LoadReport;

/* 시험용 장애 주입 : 0 이 아니면 스냅샷 임시 파일에 항목을 이 개수만큼 쓴 직후 프로세스를 즉시 끝낸다(쓰기 중 강제 종료 재현). */
extern size_t snapshot_crash_after_entries;

/* 함수별 정의 · 설명 · 동작은 persist.c 의 각 함수 위 주석을 본다. */
bool snapshot_save(const Store *store, const char *path, uint64_t now_ms, uint64_t unix_ms,
                   size_t *saved, char *error, size_t error_size);
bool snapshot_load(Store *store, const char *path, uint64_t now_ms, uint64_t unix_ms, LoadReport *report);

#endif
