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

/* 같은 모양의 인자 count 개("a" 한 글자씩)로 이루어진 프레임을 만든다. */
static size_t build_frame(char *out, size_t count) {
    int length = sprintf(out, "*%zu\r\n", count);
    for (size_t i = 0; i < count; ++i) {
        length += sprintf(out + length, "$1\r\na\r\n");
    }
    return (size_t)length;
}

/* 인자 16개는 READY, 17개는 INVALID (실제로 인자를 다 채운 프레임) */
static void test_argument_count_limit(void) {
    char frame[256];
    RespParser parser = {0};
    size_t size = build_frame(frame, 16);
    assert(resp_parse(&parser, frame, size) == RESP_READY);
    assert(parser.count == 16 && parser.offset == size);
    for (size_t i = 0; i < 16; ++i) {
        assert(parser.length[i] == 1 && frame[parser.start[i]] == 'a');
    }
    parser = (RespParser){0};
    size = build_frame(frame, 17);
    assert(resp_parse(&parser, frame, size) == RESP_INVALID);
}

/* bulk 길이 0 · 정확히 RESP_MAX_BULK 는 READY, RESP_MAX_BULK + 1 은 INVALID */
static void test_bulk_length_limits(void) {
    static char frame[RESP_MAX_BULK + 64];
    RespParser parser = {0};
    assert(resp_parse(&parser, "*1\r\n$0\r\n\r\n", 10) == RESP_READY);
    assert(parser.length[0] == 0 && parser.offset == 10);

    int header = sprintf(frame, "*1\r\n$%d\r\n", RESP_MAX_BULK);
    memset(frame + header, 'x', RESP_MAX_BULK);
    memcpy(frame + header + RESP_MAX_BULK, "\r\n", 2);
    size_t size = (size_t)header + RESP_MAX_BULK + 2;
    parser = (RespParser){0};
    assert(resp_parse(&parser, frame, size) == RESP_READY);
    assert(parser.length[0] == RESP_MAX_BULK && parser.offset == size);

    const char *over = "*1\r\n$1048577\r\n";
    parser = (RespParser){0};
    assert(resp_parse(&parser, over, strlen(over)) == RESP_INVALID);
}

/* 길이 줄의 잘못된 모양(부호 · 공백 · 앞자리 0 · -0 · 음수 개수 · CR 뒤에 LF 없음)은 INVALID */
static void test_malformed_length_lines(void) {
    const char *invalid[] = {
        "*1\r\n$+3\r\nabc\r\n", "*1\r\n$ 3\r\nabc\r\n", "*1\r\n$03\r\nabc\r\n", "*1\r\n$-0\r\n\r\n",
        "*-1\r\n", "*1\r$3\r\nabc\r\n", "*+1\r\n", "* 1\r\n", "*1\r\n$\r\n", "*\r\n", "*1\r\n3\r\nabc\r\n",
    };
    for (size_t i = 0; i < sizeof(invalid) / sizeof(*invalid); ++i) {
        RespParser parser = {0};
        assert(resp_parse(&parser, invalid[i], strlen(invalid[i])) == RESP_INVALID);
    }
}

/* bulk 본문 뒤 CRLF 자리에 다른 바이트가 오면 INVALID, 아직 안 왔으면 INCOMPLETE */
static void test_bulk_terminator(void) {
    const char *invalid[] = {"*1\r\n$3\r\nabcXY", "*1\r\n$3\r\nabc\n\r", "*1\r\n$3\r\nabc\r?", "*1\r\n$3\r\nabcd\r\n"};
    for (size_t i = 0; i < sizeof(invalid) / sizeof(*invalid); ++i) {
        RespParser parser = {0};
        assert(resp_parse(&parser, invalid[i], strlen(invalid[i])) == RESP_INVALID);
    }
    const char *incomplete[] = {"*1\r\n$3\r\nabc", "*1\r\n$3\r\nabc\r", "*1\r\n$3\r\nab", "*1\r\n$3\r\n", "*1\r\n$3", "*1\r\n$", "*", ""};
    for (size_t i = 0; i < sizeof(incomplete) / sizeof(*incomplete); ++i) {
        RespParser parser = {0};
        assert(resp_parse(&parser, incomplete[i], strlen(incomplete[i])) == RESP_INCOMPLETE);
    }
}

/* 널 문자가 들어 있는 프레임 리터럴과 그 길이 */
typedef struct {
    const char *data;
    size_t size;
} Frame;
#define FRAME(literal) {literal, sizeof(literal) - 1}

/* 한 번에 파싱한 결과와 한 바이트씩 늘려 가며 같은 parser 로 파싱한 결과가 같다 */
static void test_byte_by_byte_matches_whole(void) {
    const Frame frames[] = {
        FRAME("*3\r\n$3\r\nSET\r\n$0\r\n\r\n$4\r\na\0\r\n\r\n"),
        FRAME("*2\r\n$0\r\n\r\n$0\r\n\r\n"),
        FRAME("*1\r\n$4\r\nPING\r\n"),
        FRAME("*4\r\n$3\r\nSET\r\n$1\r\nk\r\n$3\r\n\r\n\r\r\n$2\r\nEX\r\n"),
    };
    for (size_t f = 0; f < sizeof(frames) / sizeof(*frames); ++f) {
        RespParser whole = {0};
        assert(resp_parse(&whole, frames[f].data, frames[f].size) == RESP_READY);
        assert(whole.offset == frames[f].size);
        RespParser step = {0};
        for (size_t n = 0; n < frames[f].size; ++n) {
            assert(resp_parse(&step, frames[f].data, n) == RESP_INCOMPLETE);
        }
        assert(resp_parse(&step, frames[f].data, frames[f].size) == RESP_READY);
        assert(step.offset == whole.offset && step.count == whole.count);
        for (size_t i = 0; i < whole.count; ++i) {
            assert(step.start[i] == whole.start[i] && step.length[i] == whole.length[i]);
        }
    }
}

/* resp_equals 는 길이가 다르면 접두 · 접미 · 뒤에 NUL 이 붙어도 같다고 하지 않고, 대소문자만 무시한다 */
static void test_equals_rejects_length_mismatch(void) {
    assert(!resp_equals(BYTES("SE"), "SET"));
    assert(!resp_equals(BYTES("SETX"), "SET"));
    assert(!resp_equals(BYTES("SET\0"), "SET"));
    assert(!resp_equals(BYTES(""), "SET"));
    assert(resp_equals(BYTES(""), ""));
    assert(!resp_equals(BYTES("S"), ""));
    assert(resp_equals(BYTES("set"), "SET"));
    assert(resp_equals(BYTES("sEt"), "SET"));
    assert(!resp_equals(BYTES("SEZ"), "SET"));
}

/* resp_integer 는 부호 · 공백 · 앞자리 0 · 빈 문자열을 거절하고 실패하면 값을 건드리지 않는다 */
static void test_integer_rejects_loose_forms(void) {
    int64_t value = 77;
    assert(!resp_integer(BYTES("+1"), &value));
    assert(!resp_integer(BYTES(" 1"), &value));
    assert(!resp_integer(BYTES("1 "), &value));
    assert(!resp_integer(BYTES("-0"), &value));
    assert(!resp_integer(BYTES("00"), &value));
    assert(!resp_integer(BYTES(""), &value));
    assert(!resp_integer(BYTES("-01"), &value));
    assert(!resp_integer(BYTES("1a"), &value));
    assert(value == 77);
    assert(resp_integer(BYTES("-1"), &value) && value == -1);
}

int main(void) {
    test_fragmentation_and_pipeline();
    test_invalid_frames();
    test_integer_edges();
    test_argument_count_limit();
    test_bulk_length_limits();
    test_malformed_length_lines();
    test_bulk_terminator();
    test_byte_by_byte_matches_whole();
    test_equals_rejects_length_mismatch();
    test_integer_rejects_loose_forms();
    puts("10 RESP unit scenarios passed");
    return 0;
}
