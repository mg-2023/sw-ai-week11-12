/*
 * resp.c : RESP2 요청 파싱(TCP 분할 대비 이어서 파싱), 엄격한 정수 파싱, 대소문자 무시 비교.
 * 인자는 복사하지 않고 입력 버퍼 안의 위치만 기록한다.
 */

#include "resp.h"

/* Redis 와 같은 오류를 내려고 공백 · '+' · 앞자리 0 · 범위 초과를 조용히 넘기지 않고 거절한다. */
bool resp_integer(Bytes text, int64_t *value) {
    if (!text.length) {
        return false;
    }
    bool negative = text.data[0] == '-';
    size_t start = negative ? 1 : 0;
    if (start == text.length || (text.data[start] == '0' && text.length > 1)) {
        return false;
    }
    /* 음수는 절댓값이 INT64_MAX + 1 까지 가능하므로 한계를 부호에 따라 달리 잡는다. */
    uint64_t limit = (uint64_t)INT64_MAX + negative;
    uint64_t number = 0;
    for (size_t i = start; i < text.length; ++i) {
        unsigned digit = (unsigned char)text.data[i] - (unsigned)'0';
        if (digit > 9 || number > (limit - digit) / 10) {
            return false;
        }
        number = number * 10 + digit;
    }
    if (negative && number == limit) {
        *value = INT64_MIN;
    } else {
        *value = negative ? -(int64_t)number : (int64_t)number;
    }
    return true;
}

bool resp_equals(Bytes text, const char *keyword) {
    for (size_t i = 0; i < text.length; ++i) {
        char c = text.data[i];
        if (c >= 'a' && c <= 'z') {
            c -= 'a' - 'A';
        }
        if (!keyword[i] || c != keyword[i]) {
            return false;
        }
    }
    return keyword[text.length] == '\0';
}

/* '*' 또는 '$' 길이 줄. 21글자 안에 CR 이 없으면 끝없이 긴 줄로 보고 INVALID 로 막는다. */
static RespResult read_length(RespParser *parser, const char *data, size_t size,
                              char prefix, int64_t *length) {
    size_t start = parser->offset;
    if (start == size) {
        return RESP_INCOMPLETE;
    }
    if (data[start] != prefix) {
        return RESP_INVALID;
    }
    for (size_t i = start + 1; i < size && i - start <= 21; ++i) {
        if (data[i] == '\r') {
            if (i + 1 == size) {
                return RESP_INCOMPLETE;
            }
            if (data[i + 1] != '\n' || !resp_integer((Bytes){data + start + 1, i - start - 1}, length)) {
                return RESP_INVALID;
            }
            parser->offset = i + 2;
            return RESP_READY;
        }
    }
    return size - start > 21 ? RESP_INVALID : RESP_INCOMPLETE;
}

RespResult resp_parse(RespParser *parser, const char *data, size_t size) {
    if (!parser->count) {
        int64_t count;
        RespResult result = read_length(parser, data, size, '*', &count);
        if (result != RESP_READY) {
            return result;
        }
        if (count < 1 || count > RESP_MAX_ARGS) {
            return RESP_INVALID;
        }
        parser->count = (size_t)count;
    }
    while (parser->parsed < parser->count) {
        if (!parser->reading_bulk) {
            int64_t length;
            RespResult result = read_length(parser, data, size, '$', &length);
            if (result != RESP_READY) {
                return result;
            }
            /* 인자 하나와 프레임 전체의 크기 상한을 미리 검사해, 거대한 길이를 선언해 메모리를 잡아먹는 요청을 막는다. */
            if (length < 0 || length > RESP_MAX_BULK || parser->offset + (size_t)length + 2 > RESP_MAX_FRAME) {
                return RESP_INVALID;
            }
            parser->bulk_length = (size_t)length;
            parser->reading_bulk = true;
        }
        /* 본문 끝(end) 뒤 CRLF 2바이트까지 도착해야 이 인자를 끝낼 수 있다. 부족하면 상태를 남기고 INCOMPLETE. */
        size_t end = parser->offset + parser->bulk_length;
        if (size < end + 2) {
            return RESP_INCOMPLETE;
        }
        if (data[end] != '\r' || data[end + 1] != '\n') {
            return RESP_INVALID;
        }
        parser->start[parser->parsed] = parser->offset;
        parser->length[parser->parsed++] = parser->bulk_length;
        parser->offset = end + 2;
        parser->reading_bulk = false;
    }
    return RESP_READY;
}
