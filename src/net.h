#ifndef MINI_REDIS_NET_H
#define MINI_REDIS_NET_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

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
