#ifndef MINI_REDIS_COMMANDS_H
#define MINI_REDIS_COMMANDS_H

#include "store.h"

typedef enum { REPLY_TEXT, REPLY_BULK, REPLY_INTEGER } ReplyType;

typedef struct {
    ReplyType type;
    Bytes bytes;
    int64_t number;
} Reply;

Reply execute_command(Store *store, const Bytes *args, size_t count, uint64_t now_ms);
Reply reply_text(const char *wire_text);

#endif
