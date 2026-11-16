/*
 * commands.h : 명령 실행 진입점과 Reply · Change · CommandContext.
 */

#ifndef MINI_REDIS_COMMANDS_H
#define MINI_REDIS_COMMANDS_H

#include "store.h"

/* TEXT : 이미 RESP 로 인코딩된 문자열, BULK : 값 본문($길이 + 본문), INTEGER : 정수(:숫자) */
typedef enum { REPLY_TEXT, REPLY_BULK, REPLY_INTEGER } ReplyType;

/*
 * 명령 실행 결과. 아직 바이트로 직렬화하지 않은 값이다.
 * bytes 는 복사본이 아니라 view 다(저장소 값이나 입력 버퍼를 가리킬 수 있음). 호출자가 다음 명령 전에 직렬화해야 한다.
 */
typedef struct {
    ReplyType type;
    Bytes bytes;
    int64_t number;
} Reply;

/*
 * 명령이 저장소를 실제로 바꾼 내용 하나.
 * SET : key 에 value 저장(deadline_ms 0 이면 TTL 없음), DEL : key 삭제, EXPIRE : key 의 만료 시각을 deadline_ms 로 변경
 * deadline_ms 는 단조 시계 기준 절대 시각이다. 파일에 쓸 때 벽시계 시각으로 바꾸는 일은 기록하는 쪽(persist.c)이 맡는다.
 */
typedef enum { CHANGE_SET, CHANGE_DEL, CHANGE_EXPIRE } ChangeType;
typedef struct {
    ChangeType type;
    Bytes key;
    Bytes value;
    uint64_t deadline_ms;
} Change;

/*
 * 명령 하나를 실행하는 데 필요한 것.
 * store : 저장소, now_ms : 이 명령의 현재 시각(단조 ms)
 * record_change : 상태를 바꿀 때마다 부를 함수(NULL 이면 기록 안 함, AOF 모드에서 채움)
 * save_snapshot : SAVE 명령이 부를 함수(NULL 이면 스냅샷 꺼짐, 스냅샷 모드에서 채움). 성공하면 true
 * hook_context : 두 함수에 넘길 값
 */
typedef struct {
    Store *store;
    uint64_t now_ms;
    void (*record_change)(void *context, const Change *change);
    bool (*save_snapshot)(void *context);
    void *hook_context;
} CommandContext;

/* 돌려준 Reply.bytes 는 다음 명령 전에 직렬화해야 한다. reply_text 에는 리터럴만 넘긴다. */
Reply execute_command(const CommandContext *context, const Bytes *args, size_t count);
Reply reply_text(const char *wire_text);

#endif
