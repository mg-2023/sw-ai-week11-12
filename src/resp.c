#include "resp.h"

bool resp_integer(Bytes text, int64_t *value) {
    if (!text.length) {
        return false;
    }
    bool negative = text.data[0] == '-';
    size_t start = negative ? 1 : 0;
    if (start == text.length || (text.data[start] == '0' && text.length > 1)) {
        return false;
    }
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
            if (length < 0 || length > RESP_MAX_BULK || parser->offset + (size_t)length + 2 > RESP_MAX_FRAME) {
                return RESP_INVALID;
            }
            parser->bulk_length = (size_t)length;
            parser->reading_bulk = true;
        }
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
