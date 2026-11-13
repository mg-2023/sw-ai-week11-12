#include "resp.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

#define BYTES(literal) ((Bytes){literal, sizeof(literal) - 1})

static void test_fragmentation_and_pipeline(void) {
    const char first[] = "*3\r\n$3\r\nSET\r\n$0\r\n\r\n$4\r\na\0\r\n\r\n";
    const char pipeline[] = "*3\r\n$3\r\nSET\r\n$0\r\n\r\n$4\r\na\0\r\n\r\n*1\r\n$4\r\nPING\r\n";
    RespParser parser = {0};
    for (size_t n = 0; n < sizeof(first) - 1; ++n) {
        assert(resp_parse(&parser, pipeline, n) == RESP_INCOMPLETE);
    }
    assert(resp_parse(&parser, pipeline, sizeof(pipeline) - 1) == RESP_READY);
    assert(parser.offset == sizeof(first) - 1 && parser.count == 3);
    assert(parser.length[1] == 0 && parser.length[2] == 4);
    assert(memcmp(pipeline + parser.start[2], "a\0\r\n", 4) == 0);
    size_t offset = parser.offset;
    parser = (RespParser){0};
    assert(resp_parse(&parser, pipeline + offset, sizeof(pipeline) - 1 - offset) == RESP_READY);
    assert(parser.count == 1 && memcmp(pipeline + offset + parser.start[0], "PING", 4) == 0);
}

static void test_invalid_frames(void) {
    const char *invalid[] = {
        "GET key\r\n", "*0\r\n", "*17\r\n", "*1\r\n$-1\r\n", "*1\r\n$1048577\r\n",
        "*1\r\n$1\r\nx\n\r", "*1\r\n$9999999999999999999999999", "*01\r\n",
    };
    for (size_t i = 0; i < sizeof(invalid) / sizeof(*invalid); ++i) {
        RespParser parser = {0};
        assert(resp_parse(&parser, invalid[i], strlen(invalid[i])) == RESP_INVALID);
    }
}

static void test_integer_edges(void) {
    int64_t value;
    assert(resp_integer(BYTES("0"), &value) && value == 0);
    assert(resp_integer(BYTES("9223372036854775807"), &value) && value == INT64_MAX);
    assert(resp_integer(BYTES("-9223372036854775808"), &value) && value == INT64_MIN);
    assert(!resp_integer(BYTES("9223372036854775808"), &value));
    assert(!resp_integer(BYTES("-9223372036854775809"), &value));
    assert(!resp_integer(BYTES("1\0"), &value));
    assert(!resp_integer(BYTES("-"), &value));
}

int main(void) {
    test_fragmentation_and_pipeline();
    test_invalid_frames();
    test_integer_edges();
    puts("3 RESP unit scenarios passed");
    return 0;
}
