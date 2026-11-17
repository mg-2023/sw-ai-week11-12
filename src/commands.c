/*
 * commands.c : 명령 이름 · 인자를 검사해 저장소 호출로 바꾸고 Reply 를 만든다.
 * 저장소를 실제로 바꾼 경우에만 record_change 로 알린다(AOF). 소켓 · 파일 입출력은 하지 않는다.
 */

#include "commands.h"
#include "resp.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

/* 복사하지 않으므로 리터럴만 넘긴다. */
Reply reply_text(const char *wire_text) {
    return (Reply){.type = REPLY_TEXT, .bytes = {wire_text, strlen(wire_text)}};
}

static Reply integer_reply(int64_t value) {
    return (Reply){.type = REPLY_INTEGER, .number = value};
}

static Reply bulk_reply(Bytes value) {
    return (Reply){.type = REPLY_BULK, .bytes = value};
}

static void record(const CommandContext *context, ChangeType type, Bytes key, Bytes value, uint64_t deadline_ms) {
    if (context->record_change) {
        Change change = {.type = type, .key = key, .value = value, .deadline_ms = deadline_ms};
        context->record_change(context->hook_context, &change);
    }
}

/*
 * 상대 TTL 을 절대 만료 시각으로 바꾼다(저장소는 절대 시각만 비교한다).
 * 0 이하 TTL : EXPIRE 는 즉시 삭제로 허용(allow_immediate), SET 은 오류.
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
 * INCR : 읽고 더하고 쓰는 세 단계를 명령 하나로 묶는다(GET 뒤 SET 으로 나누면 그 사이에 다른 연결의 명령이 끼어든다).
 * 없거나 만료된 키는 0 에서 시작한다. 오류면 값을 바꾸지 않는다. TTL 은 기존 만료 시각을 그대로 유지한다.
 */
static Reply command_incr(const CommandContext *context, const Bytes *args, size_t count) {
    if (count != 2) {
        return reply_text("-ERR wrong number of arguments for 'incr' command\r\n");
    }
    Store *store = context->store;
    uint64_t now_ms = context->now_ms;
    int64_t current = 0;
    uint64_t expires_at = 0;
    Bytes old_value;
    if (store_get(store, args[1], now_ms, &old_value)) {
        if (!resp_integer(old_value, &current)) {
            return reply_text("-ERR value is not an integer or out of range\r\n");
        }
        /* 살아 있는 키의 남은 ms 는 1 이상이다. -1 이면 TTL 이 없다. */
        int64_t remaining = store_pttl(store, args[1], now_ms);
        expires_at = remaining > 0 ? now_ms + (uint64_t)remaining : 0;
    }
    /* 더하기 전에 검사해 부호 있는 오버플로(미정의 동작)를 피한다. */
    if (current == INT64_MAX) {
        return reply_text("-ERR increment or decrement would overflow\r\n");
    }
    ++current;
    /* 10진 문자열로 바꾼다. 20자 + 널이면 int64_t 전체가 들어간다. */
    char digits[24];
    int length = snprintf(digits, sizeof digits, "%" PRId64, current);
    Bytes new_value = {digits, (size_t)length};
    if (!store_set(store, args[1], new_value, expires_at)) {
        return reply_text("-OOM unable to allocate key/value\r\n");
    }
    record(context, CHANGE_SET, args[1], new_value, expires_at);
    return integer_reply(current);
}

/*
 * 명령을 추가할 때 고칠 단 한 곳. 이 함수가 끝나야 다음 명령이 시작되므로 명령 하나는 락 없이 원자적이다.
 */
Reply execute_command(const CommandContext *context, const Bytes *args, size_t count) {
    Store *store = context->store;
    uint64_t now_ms = context->now_ms;
    if (resp_equals(args[0], "SET")) {
        return command_set(context, args, count);
    }
    if (resp_equals(args[0], "INCR")) {
        return command_incr(context, args, count);
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
