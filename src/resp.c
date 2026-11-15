/*
 * resp.c
 *
 * 정의 : RESP2 요청 파싱과 인자 해석 도우미 구현.
 * 책임 :
 *   - 요청 형식 : *개수 CRLF 다음에 인자마다 $길이 CRLF 본문 CRLF (모두 bulk string 배열)
 *   - 스트림 처리 : TCP 는 바이트가 쪼개져 오므로 데이터가 부족하면 INCOMPLETE 로 알리고 상태를 남겨 이어서 파싱한다.
 *   - 방어 : 인자 수, 인자 길이, 프레임 크기 상한을 넘으면 INVALID 로 거절한다.
 *   - 맡지 않는 것 : 인자 복사(위치만 기록), 명령 의미 해석, 소켓 읽기
 * 위치 : server.c 의 process_input 이 resp_parse 를 부르고, commands.c 가 resp_integer, resp_equals 를 부른다.
 */

#include "resp.h"

/*
 * 정의 : 문자열을 64비트 정수로 바꾸는 함수. 형식이 엄격하다.
 * 설명 : EX/PX/EXPIRE 의 시간 인자와 RESP 길이 줄을 읽을 때 쓴다. 잘못된 입력(공백, +, 앞자리 0, 범위 초과)을 조용히 넘기지 않고 거절해야 Redis 와 같은 오류 응답을 낼 수 있다.
 * 입력 : text : 십진수 문자열(널 종료 불필요), value : 결과를 받을 곳
 * 출력 : 올바른 정수면 true, 아니면 false(value 는 바뀌지 않음)
 * 동작 :
 *   1. 빈 문자열이면 false.
 *   2. 맨 앞 '-' 를 부호로 처리한다. 부호만 있거나 '0' 으로 시작하는 두 글자 이상 문자열(01, -0 등)은 false.
 *   3. 각 글자가 숫자인지, 곱하기 10 을 해도 범위를 넘지 않는지 검사하며 값을 쌓는다.
 *   4. INT64_MIN 경계를 따로 처리해 결과를 value 에 쓴다.
 */
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

/*
 * 정의 : 명령 이름을 대소문자 구분 없이 비교하는 함수.
 * 설명 : Redis 명령은 get, GET 모두 같은 명령이다. 입력을 대문자로 바꿔 키워드와 비교해 별도 복사 없이 처리한다.
 * 입력 : text : 입력 문자열, keyword : 비교할 대문자 키워드(널 종료)
 * 출력 : 같으면 true, 다르면 false
 * 동작 :
 *   1. 입력의 각 글자를 소문자면 대문자로 바꾼다.
 *   2. 키워드가 먼저 끝나거나 글자가 다르면 false.
 *   3. 입력이 끝났을 때 키워드도 끝났는지 확인해 길이까지 같게 한다.
 */
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

/*
 * 정의 : '*' 또는 '$' 로 시작하는 길이 줄(접두 문자 + 정수 + CRLF)을 한 줄 읽는 함수.
 * 설명 : RESP2 의 배열 개수와 bulk 길이는 모두 이 형식이다. 줄이 아직 다 안 왔을 수 있어서 INCOMPLETE 를 구분하고, 끝없이 긴 줄은 INVALID 로 막는다.
 * 입력 : parser : 현재 위치(offset)를 가진 상태, data/size : 입력 버퍼, prefix : 기대하는 접두 문자, length : 읽은 정수를 받을 곳
 * 출력 : READY(읽음, parser->offset 이 줄 뒤로 이동), INCOMPLETE(더 필요), INVALID(형식 오류)
 * 동작 :
 *   1. 남은 데이터가 없으면 INCOMPLETE.
 *   2. 첫 글자가 접두 문자가 아니면 INVALID.
 *   3. 최대 21글자 안에서 CR 을 찾는다.
 *   4. CR 뒤에 LF 가 오고 사이 문자열이 정수면 offset 을 줄 뒤로 옮기고 READY.
 *   5. CR 을 못 찾았을 때 이미 21글자를 넘었으면 INVALID, 아니면 INCOMPLETE.
 */
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

/*
 * 정의 : 입력 버퍼에서 요청 하나(명령 배열)를 파싱하는 함수.
 * 설명 : RESP2 요청을 한 번에 다 못 받아도(TCP 분할) 같은 parser 로 다시 부르면 멈춘 곳에서 이어간다. 인자는 복사하지 않고 위치만 기록해 불필요한 메모리 복사를 피한다.
 * 입력 : parser : 진행 상태(처음에는 0 으로 초기화), data/size : 입력 버퍼와 현재 길이(같은 요청이면 시작 위치가 같아야 함)
 * 출력 : READY(인자를 모두 읽음, parser->count 개의 start/length 가 채워짐), INCOMPLETE(더 필요), INVALID(형식 오류)
 * 동작 :
 *   1. 아직 인자 개수를 모르면 '*개수' 줄을 읽고 1 이상 RESP_MAX_ARGS 이하인지 검사한다.
 *   2. 인자마다 '$길이' 줄을 읽고 길이가 범위와 프레임 상한 안인지 검사한다.
 *   3. 본문과 뒤따르는 CRLF 가 모두 도착했는지, CRLF 가 맞는지 확인한다.
 *   4. 인자의 시작 위치와 길이를 기록하고 offset 을 뒤로 옮긴다.
 *   5. 모든 인자를 읽으면 READY.
 */
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
