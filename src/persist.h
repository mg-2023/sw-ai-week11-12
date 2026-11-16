/*
 * persist.h
 *
 * 정의 : 장애 복구용 영속성 모듈의 공개 인터페이스. RDB 방식의 스냅샷과 AOF(append-only file) 두 방식을 제공한다.
 * 책임 :
 *   - 스냅샷 : 특정 시점의 키 · 값 · 만료 시각을 파일 하나에 쓰고, 재시작할 때 읽어 저장소를 채운다.
 *   - AOF : 상태를 바꾼 연산(Change)을 실행 순서대로 파일 끝에 덧붙이고, 재시작할 때 처음부터 다시 실행(재생)한다.
 *   - 만료 시각은 파일에 벽시계 기준 절대 시각(Unix ms)으로 쓴다. 저장소의 단조 시계 값은 재부팅이나 재시작 뒤 의미가 없기 때문이다.
 *   - 맡지 않는 것 : 명령 해석(commands.c), 언제 저장할지 결정(server.c), 시계 읽기(호출자가 now_ms, unix_ms 를 넘김)
 * 위치 : server.c 가 시작할 때 snapshot_load 또는 aof_open 을 부르고, 명령이 상태를 바꿀 때 aof_append 를, SAVE 명령에서 snapshot_save 를 부른다.
 */

#ifndef MINI_REDIS_PERSIST_H
#define MINI_REDIS_PERSIST_H

#include "commands.h"

/*
 * AOF 디스크 동기화 정책.
 * ALWAYS : 레코드마다 write 뒤 fsync 까지 끝나야 응답한다. EVERYSEC : write 는 바로, fsync 는 약 1초마다. NO : fsync 를 운영체제에 맡긴다.
 */
typedef enum { FSYNC_ALWAYS, FSYNC_EVERYSEC, FSYNC_NO } FsyncPolicy;

/*
 * 불러오기 결과.
 * loaded : 저장소에 반영한 항목(스냅샷) 또는 레코드(AOF) 수, skipped_expired : 서버가 꺼져 있는 동안 만료돼 반영하지 않은 수
 * truncated_bytes : AOF 끝에서 잘라 낸 불완전한 레코드 바이트 수, error : 실패 이유
 */
typedef struct {
    size_t loaded;
    size_t skipped_expired;
    size_t truncated_bytes;
    char error[192];
} LoadReport;

/*
 * 열려 있는 AOF 하나.
 * fd : 덧붙이기 모드로 연 파일, policy : 동기화 정책, pending_sync : write 는 했지만 아직 fsync 하지 않은 데이터가 있는지
 * last_sync_ms : 마지막 fsync 시각(단조 ms), appended : 이번 실행에서 덧붙인 레코드 수
 * fail_at : 시험용 장애 주입. appended 가 이 번째가 되는 레코드의 쓰기를 실패로 처리한다(0 이면 꺼짐)
 * error : 마지막 실패 이유
 */
typedef struct {
    int fd;
    FsyncPolicy policy;
    bool pending_sync;
    uint64_t last_sync_ms;
    uint64_t appended;
    uint64_t fail_at;
    char error[192];
} Aof;

/* 레코드 하나를 덧붙인 결과. bytes : 쓴 바이트 수, synced : 이번에 fsync 까지 끝냈는지 */
typedef struct {
    size_t bytes;
    bool synced;
} AofWrite;

/* 시험용 장애 주입 : 0 이 아니면 스냅샷 임시 파일에 항목을 이 개수만큼 쓴 직후 프로세스를 즉시 끝낸다(쓰기 중 강제 종료 재현). */
extern size_t snapshot_crash_after_entries;

/* 함수별 정의 · 설명 · 동작은 persist.c 의 각 함수 위 주석을 본다. */
bool snapshot_save(const Store *store, const char *path, uint64_t now_ms, uint64_t unix_ms,
                   size_t *saved, char *error, size_t error_size);
bool snapshot_load(Store *store, const char *path, uint64_t now_ms, uint64_t unix_ms, LoadReport *report);
bool aof_open(Aof *aof, const char *path, FsyncPolicy policy, Store *store,
              uint64_t now_ms, uint64_t unix_ms, LoadReport *report);
bool aof_append(Aof *aof, const Change *change, uint64_t now_ms, uint64_t unix_ms, AofWrite *result);
bool aof_sync_if_due(Aof *aof, uint64_t now_ms, bool *synced);
void aof_close(Aof *aof);
bool persist_parse_policy(const char *text, FsyncPolicy *policy);
const char *persist_policy_name(FsyncPolicy policy);

#endif
