/*
 * resp.h : RESP2 요청 파서 인터페이스와 크기 상한.
 */

#ifndef MINI_REDIS_RESP_H
#define MINI_REDIS_RESP_H

#include "store.h"

/*
 * RESP_MAX_ARGS : 한 명령의 최대 인자 수, RESP_MAX_BULK : 인자 하나(bulk string)의 최대 바이트
 * RESP_MAX_FRAME : 요청 한 개(프레임)가 차지할 수 있는 최대 바이트. 클라이언트 버퍼 크기의 상한이다.
 */
enum { RESP_MAX_ARGS = 16, RESP_MAX_BULK = 1024 * 1024, RESP_MAX_FRAME = 2 * RESP_MAX_BULK + 4096 };

/*
 * 파싱 진행 상태. 요청이 여러 번에 나뉘어 도착해도 이어서 파싱할 수 있게 위치를 들고 있다.
 * offset : 지금까지 읽은 바이트 수(입력 시작 기준), count : 인자 수(0 이면 아직 헤더를 못 읽음)
 * parsed : 끝낸 인자 수, start/length : 인자별 위치와 길이(입력 버퍼 안, 복사하지 않음)
 * reading_bulk/bulk_length : 길이 줄은 읽었고 본문을 기다리는 중인지, 그 본문 길이
 */
typedef struct {
    size_t offset;
    size_t count;
    size_t parsed;
    size_t start[RESP_MAX_ARGS];
    size_t length[RESP_MAX_ARGS];
    size_t bulk_length;
    bool reading_bulk;
} RespParser;

/* INCOMPLETE : 데이터가 더 필요, READY : 명령 하나 완성, INVALID : RESP2 형식 위반 */
typedef enum { RESP_INCOMPLETE, RESP_READY, RESP_INVALID } RespResult;

/* resp_parse : INCOMPLETE 면 같은 parser 와 같은 시작 위치의 더 긴 버퍼로 다시 부른다. READY 면 offset 만큼 소비한다.
   resp_integer : 실패하면 value 는 그대로. resp_equals : keyword 는 대문자 널 종료 문자열. */
RespResult resp_parse(RespParser *parser, const char *data, size_t size);
bool resp_integer(Bytes text, int64_t *value);
bool resp_equals(Bytes text, const char *keyword);

#endif
