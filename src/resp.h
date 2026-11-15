/*
 * resp.h
 *
 * 정의 : RESP2 요청(클라이언트가 보내는 명령 배열)을 파싱하기 위한 공개 인터페이스.
 * 책임 :
 *   - 맡는 것 : 요청 프레임 파싱 상태 보관, 정수 문자열 파싱, 명령 이름 비교
 *   - 맡지 않는 것 : 명령 실행(commands.c), 응답 직렬화(server.c 의 queue_reply), 소켓 읽기(net.c)
 * 위치 : server.c 가 resp_parse 로 요청을 읽고, commands.c 가 resp_integer, resp_equals 를 쓴다.
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

/* 함수별 정의 · 설명 · 동작은 resp.c 의 각 함수 위 주석을 본다. */
RespResult resp_parse(RespParser *parser, const char *data, size_t size);
bool resp_integer(Bytes text, int64_t *value);
bool resp_equals(Bytes text, const char *keyword);

#endif
