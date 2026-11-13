#include "commands.h"
#include "resp.h"

#include <string.h>

Reply reply_text(const char *wire_text) {
    return (Reply){.type = REPLY_TEXT, .bytes = {wire_text, strlen(wire_text)}};
}

static Reply integer_reply(int64_t value) {
    return (Reply){.type = REPLY_INTEGER, .number = value};
}

static Reply bulk_reply(Bytes value) {
    return (Reply){.type = REPLY_BULK, .bytes = value};
}

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

static Reply command_set(Store *store, const Bytes *args, size_t count, uint64_t now_ms) {
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
    return reply_text("+OK\r\n");
}

Reply execute_command(Store *store, const Bytes *args, size_t count, uint64_t now_ms) {
    if (resp_equals(args[0], "SET")) {
        return command_set(store, args, count, now_ms);
    }
    if (resp_equals(args[0], "GET")) {
        if (count != 2) {
            return reply_text("-ERR wrong number of arguments for 'get' command\r\n");
        }
        Bytes value;
        return store_get(store, args[1], now_ms, &value) ? bulk_reply(value) : reply_text("$-1\r\n");
    }
    if (resp_equals(args[0], "DEL")) {
        if (count < 2) {
            return reply_text("-ERR wrong number of arguments for 'del' command\r\n");
        }
        int64_t removed = 0;
        for (size_t i = 1; i < count; ++i) {
            removed += store_delete(store, args[i], now_ms);
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
        return integer_reply(store_expire_at(store, args[1], now_ms, expires_at));
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
    return reply_text("-ERR unknown command\r\n");
}
