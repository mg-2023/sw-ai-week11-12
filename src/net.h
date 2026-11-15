/*
 * net.h
 *
 * 정의 : 운영체제별 소켓 API 차이(Windows Winsock, POSIX)를 가리는 얇은 네트워크 인터페이스.
 * 책임 :
 *   - 맡는 것 : 소켓 생성 · 접속 · 수신 · 송신, 논블로킹 설정, poll, 시계, sleep, 포트 문자열 파싱
 *   - 맡지 않는 것 : 프로토콜(RESP) 해석, 클라이언트 상태 관리
 * 위치 : server.c(서버)와 examples/report_api.c(클라이언트 겸 작은 HTTP 서버)가 쓰고, 구현은 net.c 에 있다.
 */

#ifndef MINI_REDIS_NET_H
#define MINI_REDIS_NET_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* 플랫폼 별 타입 이름을 맞춘다. 이후 코드는 Socket, PollFd, INVALID_FD 만 쓰면 어느 OS 에서나 같은 모양이다. */
#ifdef _WIN32
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0600
#endif
#include <winsock2.h>
typedef SOCKET Socket;
typedef WSAPOLLFD PollFd;
#define INVALID_FD INVALID_SOCKET
#else
#include <poll.h>
typedef int Socket;
typedef struct pollfd PollFd;
#define INVALID_FD (-1)
#endif

/* 함수별 정의 · 설명 · 동작은 net.c 의 각 함수 위 주석을 본다. */
bool net_init(void);
void net_cleanup(void);
void net_close(Socket fd);
bool net_nonblocking(Socket fd);
bool net_retryable(void);
bool net_timeout(Socket fd, unsigned ms);
int net_poll(PollFd *fds, size_t count, int timeout_ms);
int net_recv(Socket fd, char *data, size_t length);
int net_send(Socket fd, const char *data, size_t length);
bool net_send_all(Socket fd, const char *data, size_t length);
Socket net_listen(const char *address, uint16_t port, uint16_t *bound_port);
Socket net_accept(Socket listener);
Socket net_connect(const char *address, uint16_t port);
bool net_parse_port(const char *text, uint16_t *port);
uint64_t net_now_ms(void);
void net_sleep_ms(unsigned ms);

#endif
