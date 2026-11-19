/*
 * report_api.c
 *
 * 정의 : 캐시 어사이드(cache-aside) 패턴을 보여 주는 예제 HTTP 서버.
 * 책임 :
 *   - GET /v1/report 요청을 받으면 먼저 Mini Redis 에서 리포트를 찾고(캐시 적중), 없으면 원본 작업을 흉내 낸 뒤 캐시에 채운다(미적중).
 *   - 채울 때 EX 30 으로 TTL 을 걸어 낡은 캐시가 시간이 지나면 저절로 무효화된다.
 *   - 응답 헤더 X-Cache 로 hit, miss, bypass, error 를 알려 캐시 효과를 눈으로 확인하게 한다.
 *   - GET /v1/report?cache=off 는 캐시를 거치지 않는 비교용 경로다.
 *   - 맡지 않는 것 : 실제 데이터베이스 조회(고정 JSON 으로 대체), 동시 요청 처리(연결을 하나씩 순서대로 처리)
 * 위치 : Mini Redis 와 별도의 프로세스(report-api)로, net.c 의 소켓 함수를 써서 Mini Redis 에 RESP2 로 접속하는 클라이언트 역할도 한다.
 */

#include "net.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* 원본 데이터 대신 쓰는 고정 리포트 JSON. 캐시에 넣고 꺼내는 값이다. */
#define REPORT "{\"orders\":12,\"total_cents\":4200}"
/* 캐시 키 "sample-report"(13바이트)를 RESP bulk string 으로 인코딩한 것. */
#define CACHE_KEY "$13\r\nsample-report\r\n"

enum { REPORT_MAX = 1024, HTTP_HEADER_MAX = 8192 };
/* Mini Redis 로 보내는 GET 요청. RESP2 배열 두 개(GET, 키)를 미리 만들어 둔 것이다. */
static const char cache_get[] = "*2\r\n$3\r\nGET\r\n" CACHE_KEY;

/*
 * 정의 : 소켓에서 정확히 length 바이트를 읽는 함수.
 * 설명 : TCP 는 바이트를 쪼개 줄 수 있어서 본문처럼 길이가 정해진 데이터는 다 받을 때까지 반복해야 한다.
 * 입력 : fd : 소켓, data : 받을 버퍼, length : 읽을 바이트 수
 * 출력 : 모두 읽었으면 true, 연결이 닫히거나 오류면 false
 * 동작 :
 *   1. 남은 길이가 0 이 될 때까지 net_recv 를 반복한다.
 *   2. 받은 만큼 버퍼 위치를 앞으로, 남은 길이를 줄인다.
 *   3. 0 이하를 받으면 false.
 */
static bool read_exact(Socket fd, char *data, size_t length) {
    while (length) {
        int received = net_recv(fd, data, length);
        if (received <= 0) {
            return false;
        }
        data += received;
        length -= (size_t)received;
    }
    return true;
}

/*
 * 정의 : CRLF 로 끝나는 한 줄을 읽는 함수.
 * 설명 : Mini Redis 의 응답 머리($길이, +OK 등)는 한 줄이다. 줄 끝을 모르므로 한 바이트씩 읽어 줄 밖의 데이터를 소비하지 않는다.
 * 입력 : fd : 소켓, line : 줄을 받을 버퍼, capacity : 버퍼 크기
 * 출력 : CRLF 까지 읽었으면 true(CRLF 는 빼고 널 종료), 버퍼가 차거나 읽기 실패면 false
 * 동작 :
 *   1. 한 바이트씩 read_exact 로 읽는다.
 *   2. 직전 글자가 CR 이고 지금이 LF 이면 CR 자리를 널로 바꿔 끝낸다.
 *   3. 버퍼 끝까지 줄바꿈을 못 찾으면 false.
 */
static bool read_line(Socket fd, char *line, size_t capacity) {
    for (size_t i = 0; i + 1 < capacity; ++i) {
        if (!read_exact(fd, &line[i], 1)) {
            return false;
        }
        if (i > 0 && line[i] == '\n' && line[i - 1] == '\r') {
            line[i - 1] = '\0';
            return true;
        }
    }
    return false;
}

/*
 * 정의 : HTTP/1.1 응답(헤더 + JSON 본문)을 보내는 함수.
 * 설명 : X-Cache 헤더에 캐시 상태를 실어 클라이언트가 적중 여부를 확인하게 한다. Cache-Control: no-store 헤더로 브라우저 쪽 캐시를 막아 Redis 캐시의 효과만 보이게 한다.
 * 입력 : fd : 클라이언트 소켓, status : 상태줄(예 "200 OK"), cache : X-Cache 값, body : JSON 본문
 * 출력 : 없음(보내기 실패는 무시)
 * 동작 :
 *   1. 상태, 본문 길이, X-Cache 로 헤더 문자열을 만든다.
 *   2. 헤더가 버퍼에 들어갔을 때만 헤더를 보낸 뒤 본문을 보낸다.
 */
static void send_http(Socket fd, const char *status, const char *cache, const char *body) {
    char header[256];
    int length = snprintf(header, sizeof(header),
                          "HTTP/1.1 %s\r\nContent-Type: application/json\r\nContent-Length: %zu\r\n"
                          "Connection: close\r\nCache-Control: no-store\r\nX-Cache: %s\r\n\r\n",
                          status, strlen(body), cache);
    if (length > 0 && (size_t)length < sizeof(header) && net_send_all(fd, header, (size_t)length)) {
        net_send_all(fd, body, strlen(body));
    }
}

/*
 * 정의 : Mini Redis 에서 리포트를 조회하고, 없으면 만들어 채우는 캐시 어사이드 핵심 함수.
 * 설명 : 캐시 어사이드: 먼저 캐시를 보고(적중이면 끝), 없으면 원본을 만들어 캐시에 넣는다. SET 에 EX 30 을 붙여 30초 뒤 만료로 무효화되므로 데이터가 영원히 낡지 않는다.
 * 입력 : redis : Mini Redis 에 연결된 소켓, report : 리포트를 받을 버퍼(REPORT_MAX 크기), cache : "hit" 또는 "miss" 를 받을 곳
 * 출력 : 성공하면 true(report 에 널 종료 JSON), 통신 오류나 형식 오류면 false
 * 동작 :
 *   1. GET 요청을 보내고 응답 첫 줄을 읽는다.
 *   2. 첫 줄이 $-1 이면 미적중이다. 원본 작업(sleep)을 흉내 내고 SET EX 30 으로 채운 뒤 +OK 를 확인한다.
 *   3. 아니면 적중이다. $길이 를 파싱하고 본문과 CRLF 를 읽어 검증한다.
 *   4. cache 에 miss 또는 hit 를 기록한다.
 */
static bool cache_fetch(Socket redis, char *report, const char **cache) {
    char line[64];
    if (!net_send_all(redis, cache_get, sizeof(cache_get) - 1) || !read_line(redis, line, sizeof(line))) {
        return false;
    }
    /* cache miss: $-1 은 값이 없을 때 Redis 가 주는 nil 응답이다. */
    if (strcmp(line, "$-1") == 0) {
        net_sleep_ms(50); /* 캐시를 거치지 않는 경로와 같은 원본 작업 시간을 흉내 낸다. */
        char request[256];
        int length = snprintf(request, sizeof(request), "*5\r\n$3\r\nSET\r\n" CACHE_KEY
                              "$%zu\r\n" REPORT "\r\n$2\r\nEX\r\n$2\r\n30\r\n", sizeof(REPORT) - 1);
        if (length <= 0 || (size_t)length >= sizeof(request) ||
            !net_send_all(redis, request, (size_t)length) || !read_line(redis, line, sizeof(line)) ||
            strcmp(line, "+OK") != 0) {
            return false;
        }
        memcpy(report, REPORT, sizeof(REPORT));
        *cache = "miss";
        return true;
    }

    /* cache hit: 응답 머리 $길이 다음에 본문과 CRLF 가 온다. 길이 상한과 본문 형식을 검사해 이상한 응답은 오류로 처리한다. */
    uint16_t length;
    char ending[2];
    if (line[0] != '$' || !net_parse_port(line + 1, &length) || length >= REPORT_MAX ||
        !read_exact(redis, report, length) || !read_exact(redis, ending, sizeof(ending)) ||
        memcmp(ending, "\r\n", 2) != 0 || memchr(report, '\0', length)) {
        return false;
    }
    report[length] = '\0';
    *cache = "hit";
    return true;
}

/*
 * 정의 : HTTP 요청 헤더를 읽어 요청 줄(첫 줄)만 남기는 함수.
 * 설명 : 라우팅에 필요한 것은 "GET /v1/report HTTP/1.1" 같은 요청 줄뿐이다. 헤더 끝(빈 줄)이 올 때까지 받되 크기와 시간에 상한을 둔다.
 * 입력 : fd : 클라이언트 소켓, request : 요청을 받을 버퍼(HTTP_HEADER_MAX 크기)
 * 출력 : 헤더 끝까지 받았으면 true(request 에는 첫 줄만 남음), 아니면 false
 * 동작 :
 *   1. 2초 제한 시간과 버퍼 크기 한도 안에서 반복해 받는다.
 *   2. 받은 뒤 널 종료하고 "\r\n\r\n" 이 있는지 찾는다.
 *   3. 있으면 첫 CRLF 자리를 널로 바꿔 요청 줄만 남기고 true.
 *   4. 제한을 넘기거나 읽기 실패면 false.
 */
static bool read_request(Socket fd, char *request) {
    size_t used = 0;
    uint64_t deadline = net_now_ms() + 2000;
    while (used < HTTP_HEADER_MAX - 1 && net_now_ms() < deadline) {
        int received = net_recv(fd, request + used, HTTP_HEADER_MAX - 1 - used);
        if (received <= 0) {
            return false;
        }
        used += (size_t)received;
        request[used] = '\0';
        if (strstr(request, "\r\n\r\n")) {
            *strstr(request, "\r\n") = '\0';
            return true;
        }
    }
    return false;
}

/*
 * 정의 : 클라이언트 한 명의 HTTP 요청을 경로별로 처리하는 함수.
 * 설명 : 캐시를 거치는 경로와 거치지 않는 경로를 나누어 캐시 효과를 비교하게 한다.
 * 입력 : fd : 클라이언트 소켓, redis_port : Mini Redis 포트
 * 출력 : 없음(결과는 HTTP 응답으로 보냄)
 * 동작 :
 *   1. 제한 시간을 걸고 요청 줄을 읽는다.
 *   2. ?cache=off 이면 50ms 원본 작업을 흉내 내고 X-Cache: bypass 로 응답한다.
 *   3. 그 밖의 경로는 404.
 *   4. /v1/report 는 Mini Redis 에 접속해 cache_fetch 로 리포트를 얻는다.
 *   5. 성공하면 X-Cache: hit 또는 miss 로 200 응답, 실패하면 502 응답.
 */
static void serve_report(Socket fd, uint16_t redis_port) {
    char request[HTTP_HEADER_MAX];
    if (!net_timeout(fd, 2000) || !read_request(fd, request)) {
        return;
    }
    if (strcmp(request, "GET /v1/report?cache=off HTTP/1.1") == 0) {
        net_sleep_ms(50);
        send_http(fd, "200 OK", "bypass", REPORT);
        return;
    }
    if (strcmp(request, "GET /v1/report HTTP/1.1") != 0) {
        send_http(fd, "404 Not Found", "bypass", "{\"error\":\"route not found\"}");
        return;
    }

    Socket redis = net_connect("127.0.0.1", redis_port);
    const char *cache = NULL;
    char report[REPORT_MAX];
    bool success = redis != INVALID_FD && net_timeout(redis, 2000) && cache_fetch(redis, report, &cache);
    if (redis != INVALID_FD) {
        net_close(redis);
    }
    if (success) {
        send_http(fd, "200 OK", cache, report);
    } else {
        send_http(fd, "502 Bad Gateway", "error", "{\"error\":\"Mini Redis request failed\"}");
    }
}

/*
 * 정의 : 예제 서버를 설정하고 요청을 반복해서 받는 진입점.
 * 설명 : 연결 하나를 받아 처리하고 닫는 일을 반복하는 가장 단순한 순차 서버다. 캐시 어사이드 흐름을 보는 데 집중하려는 것이다.
 * 입력 : argc/argv : 명령줄 인자(--port 포트, --redis-port Mini Redis 포트)
 * 출력 : 서버 소켓 오류로 루프를 벗어나거나 시작에 실패하면 EXIT_FAILURE(정상 종료 경로는 없음)
 * 동작 :
 *   1. --port, --redis-port 옵션을 해석한다. 잘못되면 사용법을 출력하고 종료한다.
 *   2. net_init 후 127.0.0.1 에서 net_listen 한다.
 *   3. 접속을 받아 serve_report 로 처리하고 닫는 일을 반복한다.
 *   4. 재시도 불가능한 accept 오류가 나면 루프를 나와 정리한다.
 */
int main(int argc, char **argv) {
    uint16_t port = 8001;
    uint16_t redis_port = 6379;
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--port") == 0 && i + 1 < argc && net_parse_port(argv[i + 1], &port)) {
            ++i;
        } else if (strcmp(argv[i], "--redis-port") == 0 && i + 1 < argc &&
                   net_parse_port(argv[i + 1], &redis_port) && redis_port != 0) {
            ++i;
        } else {
            fprintf(stderr, "Usage: %s [--port PORT] [--redis-port PORT]\n", argv[0]);
            return EXIT_FAILURE;
        }
    }
    if (!net_init()) {
        return EXIT_FAILURE;
    }
    Socket listener = net_listen("127.0.0.1", port, &port);
    if (listener == INVALID_FD) {
        fputs("Could not listen for report API requests\n", stderr);
        net_cleanup();
        return EXIT_FAILURE;
    }
    printf("Report API listening on 127.0.0.1:%u\n", (unsigned)port);
    fflush(stdout);
    for (;;) {
        Socket client = net_accept(listener);
        if (client != INVALID_FD) {
            serve_report(client, redis_port);
            net_close(client);
        } else if (!net_retryable()) {
            break;
        }
    }
    net_close(listener);
    net_cleanup();
    return EXIT_FAILURE;
}
