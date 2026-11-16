/*
 * net.c : Windows(Winsock) · POSIX 소켓, poll, 시계 차이를 #ifdef 로 가린다. IPv4 TCP 만 지원한다.
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

/* POSIX 는 끊긴 소켓에 쓸 때 프로세스가 죽지 않도록 SIGPIPE 를 무시한다. */
bool net_init(void) {
#ifdef _WIN32
    WSADATA data;
    return WSAStartup(MAKEWORD(2, 2), &data) == 0;
#else
    return signal(SIGPIPE, SIG_IGN) != SIG_ERR;
#endif
}

void net_cleanup(void) {
#ifdef _WIN32
    WSACleanup();
#endif
}

void net_close(Socket fd) {
#ifdef _WIN32
    closesocket(fd);
#else
    close(fd);
#endif
}

bool net_nonblocking(Socket fd) {
#ifdef _WIN32
    unsigned long enabled = 1;
    return ioctlsocket(fd, FIONBIO, &enabled) == 0;
#else
    int flags = fcntl(fd, F_GETFL);
    return flags != -1 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
#endif
}

/* 논블로킹 소켓의 would block · 인터럽트는 연결 실패가 아니다. 이때 연결을 닫지 않도록 구분한다. */
bool net_retryable(void) {
#ifdef _WIN32
    int error = WSAGetLastError();
    return error == WSAEWOULDBLOCK || error == WSAEINTR;
#else
    return errno == EWOULDBLOCK || errno == EAGAIN || errno == EINTR;
#endif
}

bool net_timeout(Socket fd, unsigned ms) {
#ifdef _WIN32
    DWORD timeout = ms;
#else
    struct timeval timeout = {(time_t)(ms / 1000), (long)(ms % 1000) * 1000};
#endif
    return setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout, sizeof(timeout)) == 0 &&
           setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, (const char *)&timeout, sizeof(timeout)) == 0;
}

int net_poll(PollFd *fds, size_t count, int timeout_ms) {
#ifdef _WIN32
    return WSAPoll(fds, (ULONG)count, timeout_ms);
#else
    return poll(fds, (nfds_t)count, timeout_ms);
#endif
}

int net_recv(Socket fd, char *data, size_t length) {
    return (int)recv(fd, data, (int)length, 0);
}

int net_send(Socket fd, const char *data, size_t length) {
    return (int)send(fd, data, (int)length, 0);
}

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

static bool ipv4_address(const char *address, uint16_t port, struct sockaddr_in *result) {
    *result = (struct sockaddr_in){0};
    result->sin_family = AF_INET;
    result->sin_port = htons(port);
    return inet_pton(AF_INET, address, &result->sin_addr) == 1;
}

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

Socket net_accept(Socket listener) {
    return accept(listener, NULL, NULL);
}

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

/* 단조 시계 : 시스템 시각이 바뀌어도 만료가 뒤로 가지 않는다. */
uint64_t net_now_ms(void) {
#ifdef _WIN32
    return GetTickCount64();
#else
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
#endif
}

/* 영속성 파일의 만료 시각 변환에만 쓴다. TTL 판정은 net_now_ms 로 한다. */
uint64_t net_unix_ms(void) {
#ifdef _WIN32
    FILETIME now;
    GetSystemTimeAsFileTime(&now);
    uint64_t ticks = ((uint64_t)now.dwHighDateTime << 32) | now.dwLowDateTime;
    return (ticks - UINT64_C(116444736000000000)) / 10000;
#else
    struct timespec now;
    clock_gettime(CLOCK_REALTIME, &now);
    return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
#endif
}

void net_sleep_ms(unsigned ms) {
#ifdef _WIN32
    Sleep(ms);
#else
    struct timespec delay = {(time_t)(ms / 1000), (long)(ms % 1000) * 1000000};
    while (nanosleep(&delay, &delay) == -1 && errno == EINTR) {
    }
#endif
}
