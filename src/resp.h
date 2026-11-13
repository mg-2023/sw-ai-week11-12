#ifndef MINI_REDIS_RESP_H
#define MINI_REDIS_RESP_H

#include "store.h"

enum { RESP_MAX_ARGS = 16, RESP_MAX_BULK = 1024 * 1024, RESP_MAX_FRAME = 2 * RESP_MAX_BULK + 4096 };

typedef struct {
    size_t offset;
    size_t count;
    size_t parsed;
    size_t start[RESP_MAX_ARGS];
    size_t length[RESP_MAX_ARGS];
    size_t bulk_length;
    bool reading_bulk;
} RespParser;

typedef enum { RESP_INCOMPLETE, RESP_READY, RESP_INVALID } RespResult;

RespResult resp_parse(RespParser *parser, const char *data, size_t size);
bool resp_integer(Bytes text, int64_t *value);
bool resp_equals(Bytes text, const char *keyword);

#endif
