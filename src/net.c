/*
 * net.c
 *
 * 정의 : net.h 의 구현. Windows 와 POSIX 두 경로를 #ifdef 로 나눈다.
 * 책임 :
 *   - 소켓 열기 · 닫기, 논블로킹 전환, 수신 · 송신 래퍼, poll 래퍼를 제공한다.
 *   - IPv4 TCP 만 지원한다.
 *   - 단조 증가 시계(net_now_ms)를 제공한다. TTL 만료 판정의 시간 기준이 된다.
 *   - 맡지 않는 것 : 프로토콜 해석, 연결별 버퍼 관리, 이벤트 루프 흐름
 * 위치 : server.c 의 이벤트 루프와 examples/report_api.c 가 부른다.
 */

#define _POSIX_C_SOURCE 200809L
#include "net.h"

#ifdef _WIN32
#include <windows.h>
#include <ws2tcpip.h>
typedef int SockLen;
#else
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>
typedef socklen_t SockLen;
#endif

/*
 * 정의 : 네트워크 사용 전에 한 번 하는 초기화.
 * 설명 : Windows 는 Winsock 을 시작해야 소켓을 쓸 수 있다. POSIX 는 연결이 끊긴 소켓에 쓸 때 프로세스가 죽지 않도록 SIGPIPE 를 무시한다.
 * 입력 : 없음
 * 출력 : 성공하면 true
 * 동작 :
 *   1. Windows : WSAStartup 으로 Winsock 2.2 를 시작한다.
 *   2. POSIX : SIGPIPE 를 무시하도록 설정한다.
 */
bool net_init(void) {
#ifdef _WIN32
    WSADATA data;
    return WSAStartup(MAKEWORD(2, 2), &data) == 0;
#else
    return signal(SIGPIPE, SIG_IGN) != SIG_ERR;
#endif
}

/*
 * 정의 : 네트워크 사용을 끝낼 때 하는 정리.
 * 설명 : net_init 과 짝이다. Windows 에서만 할 일이 있다.
 * 입력 : 없음
 * 출력 : 없음
 * 동작 :
 *   1. Windows : WSACleanup 을 부른다.
 *   2. POSIX : 할 일 없음.
 */
void net_cleanup(void) {
#ifdef _WIN32
    WSACleanup();
#endif
}

/*
 * 정의 : 소켓을 닫는 함수.
 * 설명 : 소켓 닫기 함수 이름이 OS 마다 달라(closesocket, close) 하나로 감싼다.
 * 입력 : fd : 닫을 소켓
 * 출력 : 없음
 * 동작 :
 *   1. 플랫폼에 맞는 닫기 함수를 부른다.
 */
void net_close(Socket fd) {
#ifdef _WIN32
    closesocket(fd);
#else
    close(fd);
#endif
}

/*
 * 정의 : 소켓을 논블로킹 모드로 바꾸는 함수.
 * 설명 : 단일 스레드 이벤트 루프는 한 연결 때문에 멈추면 안 된다. 읽거나 쓸 수 없을 때 기다리지 않고 바로 돌아오게 해 poll 이 알려 줄 때만 처리한다.
 * 입력 : fd : 대상 소켓
 * 출력 : 성공하면 true
 * 동작 :
 *   1. Windows : ioctlsocket 의 FIONBIO 를 켠다.
 *   2. POSIX : 현재 플래그를 읽고 O_NONBLOCK 을 더해 설정한다.
 */
bool net_nonblocking(Socket fd) {
#ifdef _WIN32
    unsigned long enabled = 1;
    return ioctlsocket(fd, FIONBIO, &enabled) == 0;
#else
    int flags = fcntl(fd, F_GETFL);
    return flags != -1 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
#endif
}

/*
 * 정의 : 직전 소켓 오류가 "나중에 다시 시도하면 되는 상황"인지 알려 주는 함수.
 * 설명 : 논블로킹 소켓은 데이터가 없을 때나 시그널로 끊겼을 때 오류를 돌려주지만 이는 연결 실패가 아니다. 이런 경우에 연결을 닫지 않기 위해 구분한다.
 * 입력 : 없음(직전 오류 코드를 본다)
 * 출력 : 재시도 가능한 오류(would block, 인터럽트)이면 true
 * 동작 :
 *   1. Windows : WSAGetLastError 가 WSAEWOULDBLOCK 또는 WSAEINTR 인지 본다.
 *   2. POSIX : errno 가 EWOULDBLOCK, EAGAIN, EINTR 인지 본다.
 */
bool net_retryable(void) {
#ifdef _WIN32
    int error = WSAGetLastError();
    return error == WSAEWOULDBLOCK || error == WSAEINTR;
#else
    return errno == EWOULDBLOCK || errno == EAGAIN || errno == EINTR;
#endif
}

/*
 * 정의 : 블로킹 소켓의 수신 · 송신 대기 제한 시간을 정하는 함수.
 * 설명 : 블로킹으로 쓰는 쪽(예제 API 서버의 클라이언트 접속)이 상대가 응답하지 않을 때 영원히 멈추지 않게 한다.
 * 입력 : fd : 대상 소켓, ms : 제한 시간(밀리초)
 * 출력 : 두 옵션 모두 설정에 성공하면 true
 * 동작 :
 *   1. Windows 는 밀리초 정수, POSIX 는 timeval 로 시간 값을 만든다.
 *   2. SO_RCVTIMEO 와 SO_SNDTIMEO 를 설정한다.
 */
bool net_timeout(Socket fd, unsigned ms) {
#ifdef _WIN32
    DWORD timeout = ms;
#else
    struct timeval timeout = {(time_t)(ms / 1000), (long)(ms % 1000) * 1000};
#endif
    return setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout, sizeof(timeout)) == 0 &&
           setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, (const char *)&timeout, sizeof(timeout)) == 0;
}

/*
 * 정의 : 여러 소켓 중 읽기/쓰기 가능한 것이 생길 때까지 기다리는 함수.
 * 설명 : 이벤트 루프의 핵심 대기 지점이다. 한 스레드가 많은 연결을 감시하다가 준비된 연결만 처리한다.
 * 입력 : fds : 감시할 소켓과 관심 이벤트 배열, count : 개수, timeout_ms : 최대 대기 시간
 * 출력 : 준비된 소켓 수, 0 이면 시간 초과, 음수면 오류
 * 동작 :
 *   1. Windows : WSAPoll 을 부른다.
 *   2. POSIX : poll 을 부른다.
 */
int net_poll(PollFd *fds, size_t count, int timeout_ms) {
#ifdef _WIN32
    return WSAPoll(fds, (ULONG)count, timeout_ms);
#else
    return poll(fds, (nfds_t)count, timeout_ms);
#endif
}

/*
 * 정의 : 소켓에서 데이터를 읽는 함수.
 * 설명 : 길이와 반환값 타입을 int 로 통일해 OS 별 차이를 감춘다.
 * 입력 : fd : 소켓, data : 받을 버퍼, length : 버퍼 크기
 * 출력 : 읽은 바이트 수, 0 이면 상대가 연결을 닫음, 음수면 오류
 * 동작 :
 *   1. recv 를 부르고 결과를 int 로 돌려준다.
 */
int net_recv(Socket fd, char *data, size_t length) {
    return (int)recv(fd, data, (int)length, 0);
}

/*
 * 정의 : 소켓에 데이터를 보내는 함수. 일부만 보낼 수도 있다.
 * 설명 : 논블로킹 소켓은 송신 버퍼가 차면 요청한 만큼 못 보낸다. 호출자가 보낸 만큼 이어서 처리한다.
 * 입력 : fd : 소켓, data : 보낼 데이터, length : 바이트 수
 * 출력 : 보낸 바이트 수, 음수면 오류
 * 동작 :
 *   1. send 를 부르고 결과를 int 로 돌려준다.
 */
int net_send(Socket fd, const char *data, size_t length) {
    return (int)send(fd, data, (int)length, 0);
}

/*
 * 정의 : 데이터 전부를 보낼 때까지 반복해서 보내는 함수(블로킹 소켓용).
 * 설명 : 블로킹 소켓의 send 도 일부만 보낼 수 있어서 짧은 요청도 끝까지 보내는 반복이 필요하다.
 * 입력 : fd : 소켓, data : 보낼 데이터, length : 바이트 수
 * 출력 : 전부 보냈으면 true, 오류나 0 바이트 전송이면 false
 * 동작 :
 *   1. 남은 길이가 0 이 될 때까지 net_send 를 반복한다.
 *   2. 보낸 만큼 포인터를 앞으로, 남은 길이를 줄인다.
 *   3. 전송이 0 이하이면 false.
 */
bool net_send_all(Socket fd, const char *data, size_t length) {
    while (length > 0) {
        int sent = net_send(fd, data, length);
        if (sent <= 0) {
            return false;
        }
        data += sent;
        length -= (size_t)sent;
    }
    return true;
}

/*
 * 정의 : IPv4 주소 문자열과 포트로 소켓 주소 구조체를 채우는 함수.
 * 설명 : net_listen 과 net_connect 가 같은 방식으로 주소를 만들도록 공통으로 뺐다.
 * 입력 : address : 점으로 구분한 IPv4 문자열, port : 포트, result : 결과를 받을 곳
 * 출력 : 주소 문자열이 올바르면 true
 * 동작 :
 *   1. 구조체를 0 으로 채우고 family 를 AF_INET 으로 둔다.
 *   2. 포트를 네트워크 바이트 순서로 바꿔 넣는다.
 *   3. inet_pton 으로 주소를 변환한다.
 */
static bool ipv4_address(const char *address, uint16_t port, struct sockaddr_in *result) {
    *result = (struct sockaddr_in){0};
    result->sin_family = AF_INET;
    result->sin_port = htons(port);
    return inet_pton(AF_INET, address, &result->sin_addr) == 1;
}

/*
 * 정의 : TCP 서버 소켓을 만들어 주소에 묶고 접속 대기 상태로 만드는 함수.
 * 설명 : 서버가 클라이언트 접속을 받기 위한 첫 단계다. 포트에 0 을 주면 OS 가 빈 포트를 골라 주고, 실제 포트를 돌려줘서 테스트에서 포트 충돌을 피할 수 있다.
 * 입력 : address : 묶을 IPv4 주소, port : 포트(0 이면 자동), bound_port : 실제로 묶인 포트를 받을 곳
 * 출력 : 대기 중인 소켓, 실패하면 INVALID_FD
 * 동작 :
 *   1. 주소를 변환하고 TCP 소켓을 만든다.
 *   2. 주소 재사용 옵션을 설정한다.
 *   3. bind, listen 을 하고 getsockname 으로 실제 포트를 얻는다.
 *   4. 중간에 실패하면 소켓을 닫고 INVALID_FD.
 *   5. 성공하면 bound_port 에 포트를 기록한다.
 */
Socket net_listen(const char *address, uint16_t port, uint16_t *bound_port) {
    struct sockaddr_in endpoint;
    if (!ipv4_address(address, port, &endpoint)) {
        return INVALID_FD;
    }
    Socket fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (fd == INVALID_FD) {
        return INVALID_FD;
    }
    int enabled = 1;
#ifdef _WIN32
    /* Windows 는 SO_REUSEADDR 가 다른 프로세스의 포트 가로채기를 허용해서 SO_EXCLUSIVEADDRUSE 를 쓴다. POSIX 는 재시작 직후 다시 bind 할 수 있게 SO_REUSEADDR 를 쓴다. */
    int reuse = SO_EXCLUSIVEADDRUSE;
#else
    int reuse = SO_REUSEADDR;
#endif
    SockLen length = sizeof(endpoint);
    if (setsockopt(fd, SOL_SOCKET, reuse, (const char *)&enabled, sizeof(enabled)) != 0 ||
        bind(fd, (struct sockaddr *)&endpoint, sizeof(endpoint)) != 0 || listen(fd, SOMAXCONN) != 0 ||
        getsockname(fd, (struct sockaddr *)&endpoint, &length) != 0) {
        net_close(fd);
        return INVALID_FD;
    }
    *bound_port = ntohs(endpoint.sin_port);
    return fd;
}

/*
 * 정의 : 대기 중인 서버 소켓에서 새 클라이언트 접속 하나를 받는 함수.
 * 설명 : poll 이 서버 소켓을 읽기 가능으로 알려 줄 때 새 연결이 대기 중이다. 상대 주소는 필요 없어서 받지 않는다.
 * 입력 : listener : 서버 소켓
 * 출력 : 새 연결 소켓, 실패하면 INVALID_FD
 * 동작 :
 *   1. accept 를 부르고 결과를 돌려준다.
 */
Socket net_accept(Socket listener) {
    return accept(listener, NULL, NULL);
}

/*
 * 정의 : 서버에 TCP 로 접속하는 함수(클라이언트용).
 * 설명 : 예제 API 서버가 Mini Redis 에 접속해 캐시를 조회하고 채울 때 쓴다.
 * 입력 : address : 서버 IPv4 주소, port : 서버 포트
 * 출력 : 연결된 소켓, 실패하면 INVALID_FD
 * 동작 :
 *   1. 주소를 변환하고 TCP 소켓을 만든다.
 *   2. connect 로 접속한다.
 *   3. 접속에 실패하면 소켓을 닫고 INVALID_FD.
 */
Socket net_connect(const char *address, uint16_t port) {
    struct sockaddr_in endpoint;
    if (!ipv4_address(address, port, &endpoint)) {
        return INVALID_FD;
    }
    Socket fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (fd != INVALID_FD && connect(fd, (struct sockaddr *)&endpoint, sizeof(endpoint)) != 0) {
        net_close(fd);
        return INVALID_FD;
    }
    return fd;
}

/*
 * 정의 : 십진수 문자열을 0~65535 의 포트 번호로 바꾸는 함수.
 * 설명 : 명령줄 옵션(--port)을 검증한다. 숫자 외 글자, 빈 문자열, 범위 초과를 오류로 잡는다. 예제의 응답 길이 파싱에도 재사용한다.
 * 입력 : text : 십진수 문자열, port : 결과를 받을 곳
 * 출력 : 올바르면 true, 아니면 false
 * 동작 :
 *   1. 빈 문자열이면 false.
 *   2. 글자마다 숫자인지 확인하고 값을 쌓는다.
 *   3. UINT16_MAX 를 넘으면 false.
 *   4. 끝까지 통과하면 port 에 기록한다.
 */
bool net_parse_port(const char *text, uint16_t *port) {
    unsigned value = 0;
    if (*text == '\0') {
        return false;
    }
    for (; *text; ++text) {
        if (*text < '0' || *text > '9') {
            return false;
        }
        value = value * 10 + (unsigned)(*text - '0');
        if (value > UINT16_MAX) {
            return false;
        }
    }
    *port = (uint16_t)value;
    return true;
}

/*
 * 정의 : 현재 시각을 밀리초로 돌려주는 함수(단조 증가).
 * 설명 : TTL 만료 판정의 시간 기준이다. 벽시계가 아니라 단조 시계를 써서 시스템 시각이 바뀌어도 만료가 뒤로 가지 않는다. 시계는 여기서만 읽고 저장소에는 값으로 넘긴다.
 * 입력 : 없음
 * 출력 : 과거 임의 시점부터 지난 밀리초
 * 동작 :
 *   1. Windows : GetTickCount64 를 돌려준다.
 *   2. POSIX : CLOCK_MONOTONIC 의 초와 나노초를 밀리초로 합친다.
 */
uint64_t net_now_ms(void) {
#ifdef _WIN32
    return GetTickCount64();
#else
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
#endif
}

/*
 * 정의 : 지정한 밀리초만큼 쉬는 함수.
 * 설명 : 예제에서 원본 데이터를 가져오는 느린 작업을 흉내 내어 캐시 적중과 미적중의 응답 시간 차이를 만든다.
 * 입력 : ms : 쉴 시간(밀리초)
 * 출력 : 없음
 * 동작 :
 *   1. Windows : Sleep 을 부른다.
 *   2. POSIX : nanosleep 으로 쉬고, 시그널로 끊기면 남은 시간만큼 다시 쉰다.
 */
void net_sleep_ms(unsigned ms) {
#ifdef _WIN32
    Sleep(ms);
#else
    struct timespec delay = {(time_t)(ms / 1000), (long)(ms % 1000) * 1000000};
    while (nanosleep(&delay, &delay) == -1 && errno == EINTR) {
    }
#endif
}
