/*
 * commands.c
 *
 * 정의 : 명령 이름(SET, GET, DEL, EXPIRE, PEXPIRE, PTTL, PING, SAVE)을 해석해 저장소 연산으로 바꾸는 구현.
 * 책임 :
 *   - 인자 개수와 형식을 검사하고 Redis 와 같은 형태의 오류 응답을 만든다.
 *   - 저장소 호출에 현재 시각(now_ms)을 넘겨 만료 판정을 한 명령 안에서 같은 기준으로 한다.
 *   - 저장소를 실제로 바꾼 경우에만 record_change 로 Change 를 알린다(AOF 기록용). 바꾸지 못한 명령(없는 키 DEL 등)은 알리지 않는다.
 *   - 맡지 않는 것 : 소켓 입출력, 바이트 직렬화, 시계 읽기, 해시 테이블 내부 동작, 파일 입출력
 * 위치 : server.c 가 요청 하나를 파싱할 때마다 execute_command 를 한 번 부른다. 이벤트 루프가 단일 스레드라 한 명령은 끝까지 실행되며 중간에 다른 명령이 끼지 않는다(명령 단위 원자성).
 */

#include "commands.h"
#include "resp.h"

#include <string.h>

/*
 * 정의 : 이미 RESP 형식인 문자열("+OK\r\n" 등)을 Reply 로 감싸는 함수.
 * 설명 : 상태 응답, 오류 응답, nil 응답은 고정 문자열이라 직렬화 없이 그대로 보낼 수 있다. 문자열을 복사하지 않으므로 호출 뒤에도 살아 있는 문자열(리터럴)이어야 한다.
 * 입력 : wire_text : CRLF 로 끝나는 RESP 응답 문자열
 * 출력 : REPLY_TEXT 응답
 * 동작 :
 *   1. 문자열과 길이를 bytes 에 담는다.
 *   2. type 을 REPLY_TEXT 로 해서 돌려준다.
 */
Reply reply_text(const char *wire_text) {
    return (Reply){.type = REPLY_TEXT, .bytes = {wire_text, strlen(wire_text)}};
}

/*
 * 정의 : 정수를 Reply 로 만드는 함수.
 * 설명 : DEL 의 삭제 개수, EXPIRE 의 성공 여부, PTTL 의 남은 시간 응답에 쓴다.
 * 입력 : value : 응답할 정수
 * 출력 : REPLY_INTEGER 응답
 * 동작 :
 *   1. type 과 number 를 채워 돌려준다.
 */
static Reply integer_reply(int64_t value) {
    return (Reply){.type = REPLY_INTEGER, .number = value};
}

/*
 * 정의 : 바이트열을 bulk string 응답으로 만드는 함수.
 * 설명 : GET 으로 읽은 값과 PING 인자 에코처럼 길이가 정해진 임의 바이트를 돌려줄 때 쓴다. 값은 복사하지 않는다.
 * 입력 : value : 응답 본문(view)
 * 출력 : REPLY_BULK 응답
 * 동작 :
 *   1. type 과 bytes 를 채워 돌려준다.
 */
static Reply bulk_reply(Bytes value) {
    return (Reply){.type = REPLY_BULK, .bytes = value};
}

/*
 * 정의 : 저장소를 바꾼 내용을 기록 함수에 알리는 함수.
 * 설명 : AOF 는 상태를 바꾼 연산만 실행 순서대로 남긴다. 기록 함수가 없으면(영속성 꺼짐, AOF 아닌 모드) 아무것도 하지 않는다.
 * 입력 : context : 명령 실행 문맥, type/key/value/deadline_ms : 바뀐 내용
 * 출력 : 없음
 * 동작 :
 *   1. record_change 가 없으면 끝낸다.
 *   2. Change 를 채워 record_change 를 부른다.
 */
static void record(const CommandContext *context, ChangeType type, Bytes key, Bytes value, uint64_t deadline_ms) {
    if (context->record_change) {
        Change change = {.type = type, .key = key, .value = value, .deadline_ms = deadline_ms};
        context->record_change(context->hook_context, &change);
    }
}

/*
 * 정의 : TTL 인자(상대 시간)를 만료 시각(절대 ms)으로 바꾸는 함수.
 * 설명 : SET EX/PX 와 EXPIRE/PEXPIRE 가 공유한다. 저장소는 절대 시각만 알고 비교하므로 명령 시점에 "지금 + TTL" 을 계산해 넘긴다.
 * 입력 : argument : TTL 문자열, now_ms : 현재 시각, unit : 단위(초면 1000, 밀리초면 1), allow_immediate : 0 이하 TTL 을 허용할지, result : 결과를 받을 곳
 * 출력 : 성공하면 true, 정수가 아니거나 계산이 넘치면 false, 0 이하이면 allow_immediate 값
 * 동작 :
 *   1. 인자를 정수로 파싱한다. 실패하면 false.
 *   2. 0 이하이면 만료 시각을 now_ms 로 두고 allow_immediate 를 돌려준다(EXPIRE 는 즉시 삭제, SET 은 오류).
 *   3. TTL * unit + now_ms 가 넘치지 않는지 검사한다.
 *   4. 만료 시각을 계산해 result 에 담고 true.
 */
static bool deadline(Bytes argument, uint64_t now_ms, uint64_t unit,
                     bool allow_immediate, uint64_t *result) {
    int64_t ttl;
    if (!resp_integer(argument, &ttl)) {
        return false;
    }
    if (ttl <= 0) {
        *result = now_ms;
        return allow_immediate;
    }
    if ((uint64_t)ttl > ((uint64_t)INT64_MAX - now_ms) / unit) {
        return false;
    }
    *result = now_ms + (uint64_t)ttl * unit;
    return true;
}

/*
 * 정의 : SET key value [EX 초 | PX 밀리초] 를 실행하는 함수.
 * 설명 : 캐시 어사이드에서 캐시를 채우는 명령이다. EX/PX 로 TTL 을 같이 걸어 두면 일정 시간 뒤 항목이 만료되어 낡은 캐시가 자동으로 무효화된다. 같은 키에 다시 SET 하면 값과 TTL 이 모두 새로 바뀐다.
 * 입력 : context : 명령 실행 문맥(저장소, 현재 시각, 기록 함수), args/count : 명령 인자(args[0] 은 SET)
 * 출력 : 성공이면 +OK, 인자 오류 · 옵션 오류 · 메모리 부족이면 해당 오류 응답
 * 동작 :
 *   1. 인자가 5개면 args[3] 이 EX 인지 PX 인지 확인하고 TTL 을 만료 시각으로 바꾼다.
 *   2. 인자가 3개가 아니면 인자 개수 오류.
 *   3. store_set 으로 저장한다(만료 시각 0 이면 TTL 없음).
 *   4. 저장에 실패하면 OOM 오류. 성공하면 SET 변경을 기록하고 +OK.
 */
static Reply command_set(const CommandContext *context, const Bytes *args, size_t count) {
    Store *store = context->store;
    uint64_t now_ms = context->now_ms;
    uint64_t expires_at = 0;
    if (count == 5) {
        bool seconds = resp_equals(args[3], "EX");
        if (!seconds && !resp_equals(args[3], "PX")) {
            return reply_text("-ERR syntax error\r\n");
        }
        if (!deadline(args[4], now_ms, seconds ? 1000 : 1, false, &expires_at)) {
            return reply_text("-ERR invalid expire time in 'set' command\r\n");
        }
    } else if (count != 3) {
        return reply_text("-ERR wrong number of arguments for 'set' command\r\n");
    }
    if (!store_set(store, args[1], args[2], expires_at)) {
        return reply_text("-OOM unable to allocate key/value\r\n");
    }
    record(context, CHANGE_SET, args[1], args[2], expires_at);
    return reply_text("+OK\r\n");
}

/*
 * 정의 : 명령 하나를 이름으로 골라 실행하고 응답 값을 돌려주는 함수.
 * 설명 : 서버가 요청을 한 개씩 순서대로 처리하는 진입점이다. 단일 스레드 이벤트 루프에서 이 함수가 끝나야 다음 명령이 시작되므로 락 없이도 명령이 원자적이다. 응답의 bytes 는 저장소 값을 가리킬 수 있어서 호출자가 다음 명령 전에 직렬화해야 한다.
 * 입력 : context : 명령 실행 문맥(저장소, 현재 시각, 기록 · 스냅샷 함수), args/count : 명령 이름과 인자(count 는 1 이상)
 * 출력 : Reply(상태, 오류, nil, 정수, bulk 중 하나)
 * 동작 :
 *   1. args[0] 을 대소문자 구분 없이 명령 이름과 비교한다.
 *   2. 명령별로 인자 개수를 검사하고 형식이 틀리면 오류 응답을 돌려준다.
 *   3. 저장소 함수를 호출하고 결과를 응답으로 바꾼다(GET 은 없으면 nil, DEL 은 지운 개수, EXPIRE 는 1 또는 0, PTTL 은 남은 ms 또는 -1, -2).
 *   4. 실제로 바뀐 경우에만 변경을 기록한다(DEL 은 지운 키마다, EXPIRE 는 성공했을 때 즉시 삭제면 DEL, 아니면 EXPIRE).
 *   5. PING 은 인자가 없으면 +PONG, 하나면 그 인자를 그대로 돌려준다.
 *   6. SAVE 는 스냅샷 함수가 있으면 불러 성공 시 +OK, 실패 시 오류, 없으면 꺼짐 오류.
 *   7. 알 수 없는 이름이면 unknown command 오류.
 */
Reply execute_command(const CommandContext *context, const Bytes *args, size_t count) {
    Store *store = context->store;
    uint64_t now_ms = context->now_ms;
    if (resp_equals(args[0], "SET")) {
        return command_set(context, args, count);
    }
    if (resp_equals(args[0], "GET")) {
        if (count != 2) {
            return reply_text("-ERR wrong number of arguments for 'get' command\r\n");
        }
        Bytes value;
        /* 키가 없거나 만료됐으면 nil 응답($-1). 캐시 어사이드에서는 이것이 "캐시 미스" 신호가 된다. */
        return store_get(store, args[1], now_ms, &value) ? bulk_reply(value) : reply_text("$-1\r\n");
    }
    if (resp_equals(args[0], "DEL")) {
        if (count < 2) {
            return reply_text("-ERR wrong number of arguments for 'del' command\r\n");
        }
        int64_t removed = 0;
        for (size_t i = 1; i < count; ++i) {
            /* 여러 키를 한 번에 지우고, 실제로 지워진 개수만 센다. */
            if (store_delete(store, args[i], now_ms)) {
                ++removed;
                record(context, CHANGE_DEL, args[i], (Bytes){0}, 0);
            }
        }
        return integer_reply(removed);
    }
    if (resp_equals(args[0], "EXPIRE") || resp_equals(args[0], "PEXPIRE")) {
        if (count != 3) {
            return reply_text("-ERR wrong number of arguments for expire command\r\n");
        }
        uint64_t expires_at;
        uint64_t unit = resp_equals(args[0], "EXPIRE") ? 1000 : 1;
        if (!deadline(args[2], now_ms, unit, true, &expires_at)) {
            return reply_text("-ERR value is not an integer or out of range\r\n");
        }
        bool changed = store_expire_at(store, args[1], now_ms, expires_at);
        if (changed) {
            /* 0 이하 TTL 은 즉시 삭제됐으므로 DEL 로, 아니면 새 만료 시각으로 기록한다. */
            record(context, expires_at <= now_ms ? CHANGE_DEL : CHANGE_EXPIRE, args[1], (Bytes){0}, expires_at);
        }
        return integer_reply(changed);
    }
    if (resp_equals(args[0], "PTTL")) {
        if (count != 2) {
            return reply_text("-ERR wrong number of arguments for 'pttl' command\r\n");
        }
        return integer_reply(store_pttl(store, args[1], now_ms));
    }
    if (resp_equals(args[0], "PING")) {
        if (count == 1) {
            return reply_text("+PONG\r\n");
        }
        if (count == 2) {
            return bulk_reply(args[1]);
        }
        return reply_text("-ERR wrong number of arguments for 'ping' command\r\n");
    }
    if (resp_equals(args[0], "SAVE")) {
        if (count != 1) {
            return reply_text("-ERR wrong number of arguments for 'save' command\r\n");
        }
        if (!context->save_snapshot) {
            return reply_text("-ERR snapshot is disabled (start with --snapshot PATH)\r\n");
        }
        /* 실패해도 마지막으로 완성된 스냅샷 파일은 그대로다(persist.c 의 임시 파일 쓰기 뒤 교체). */
        return context->save_snapshot(context->hook_context) ? reply_text("+OK\r\n")
                                                             : reply_text("-ERR snapshot save failed\r\n");
    }
    return reply_text("-ERR unknown command\r\n");
}
