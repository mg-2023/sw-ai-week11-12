#include "commands.h"
#include "net.h"
#include "resp.h"

#include <inttypes.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { MAX_CLIENTS = 256, IO_CHUNK = 16384, MAINTENANCE_MS = 100 };

typedef struct {
    char *data;
    size_t capacity;
    size_t begin;
    size_t end;
} Buffer;

typedef struct {
    Socket fd;
    Buffer input;
    Buffer output;
    RespParser parser;
    bool close_after_reply;
} Client;

static volatile sig_atomic_t stopped;

static void stop_server(int signal_number) {
    (void)signal_number;
    stopped = 1;
}

static bool reserve(Buffer *buffer, size_t required, size_t maximum) {
    if (required <= buffer->capacity) {
        return true;
    }
    size_t capacity = buffer->capacity ? buffer->capacity : IO_CHUNK;
    while (capacity < required) {
        capacity *= 2;
    }
    if (capacity > maximum) {
        capacity = maximum;
    }
    char *data = realloc(buffer->data, capacity);
    if (!data) {
        return false;
    }
    buffer->data = data;
    buffer->capacity = capacity;
    return true;
}

static bool queue_reply(Buffer *output, Reply reply) {
    const char *header = reply.bytes.data;
    size_t header_length = reply.bytes.length;
    size_t tail_length = 0;
    char formatted[64];
    if (reply.type == REPLY_INTEGER) {
        header_length = (size_t)snprintf(formatted, sizeof(formatted), ":%" PRId64 "\r\n", reply.number);
        header = formatted;
    } else if (reply.type == REPLY_BULK) {
        header_length = (size_t)snprintf(formatted, sizeof(formatted), "$%zu\r\n", reply.bytes.length);
        header = formatted;
        tail_length = reply.bytes.length + 2;
    }

    size_t total = header_length + tail_length;
    if (!reserve(output, total, RESP_MAX_FRAME)) {
        return false;
    }
    memcpy(output->data, header, header_length);
    if (reply.type == REPLY_BULK) {
        memcpy(output->data + header_length, reply.bytes.data, reply.bytes.length);
        memcpy(output->data + total - 2, "\r\n", 2);
    }
    output->begin = 0;
    output->end = total;
    return true;
}

static void close_client(Client *client) {
    net_close(client->fd);
    free(client->input.data);
    free(client->output.data);
    *client = (Client){.fd = INVALID_FD};
}

static bool process_input(Client *client, Store *store) {
    Buffer *input = &client->input;
    if (input->begin == input->end || client->output.end || client->close_after_reply) {
        return true;
    }
    const char *data = input->data + input->begin;
    RespParser *parser = &client->parser;
    size_t size = input->end - input->begin;
    RespResult result = resp_parse(parser, data, size);
    if (result == RESP_INCOMPLETE && size < RESP_MAX_FRAME) {
        return true;
    }
    if (result != RESP_READY) {
        client->close_after_reply = true;
        return queue_reply(&client->output, reply_text("-ERR invalid RESP2 frame\r\n"));
    }

    Bytes args[RESP_MAX_ARGS];
    for (size_t i = 0; i < parser->count; ++i) {
        args[i] = (Bytes){data + parser->start[i], parser->length[i]};
    }
    // Serialize before processing another command that could replace or free the value.
    if (!queue_reply(&client->output, execute_command(store, args, parser->count, net_now_ms()))) {
        return false;
    }
    input->begin += parser->offset;
    *parser = (RespParser){0};
    if (input->begin == input->end) {
        input->begin = input->end = 0;
        if (input->capacity > 4 * IO_CHUNK) {
            free(input->data);
            *input = (Buffer){0};
        }
    }
    return true;
}

static bool read_client(Client *client) {
    Buffer *input = &client->input;
    if (input->begin && input->capacity - input->end < IO_CHUNK) {
        memmove(input->data, input->data + input->begin, input->end - input->begin);
        input->end -= input->begin;
        input->begin = 0;
    }
    size_t available = RESP_MAX_FRAME - input->end;
    size_t to_read = available < IO_CHUNK ? available : IO_CHUNK;
    if (!to_read || !reserve(input, input->end + to_read, RESP_MAX_FRAME)) {
        return false;
    }
    int received = net_recv(client->fd, input->data + input->end, to_read);
    if (received <= 0) {
        return received < 0 && net_retryable();
    }
    input->end += (size_t)received;
    return true;
}

static bool write_client(Client *client) {
    Buffer *output = &client->output;
    size_t remaining = output->end - output->begin;
    size_t to_send = remaining < IO_CHUNK ? remaining : IO_CHUNK;
    int sent = net_send(client->fd, output->data + output->begin, to_send);
    if (sent <= 0) {
        return sent < 0 && net_retryable();
    }
    output->begin += (size_t)sent;
    if (output->begin != output->end) {
        return true;
    }
    output->begin = output->end = 0;
    if (output->capacity > 4 * IO_CHUNK) {
        free(output->data);
        *output = (Buffer){0};
    }
    return !client->close_after_reply;
}

static void accept_client(Socket listener, Client *clients) {
    Socket fd = net_accept(listener);
    if (fd == INVALID_FD) {
        return;
    }
    if (net_nonblocking(fd)) {
        for (size_t i = 0; i < MAX_CLIENTS; ++i) {
            if (clients[i].fd == INVALID_FD) {
                clients[i].fd = fd;
                return;
            }
        }
        const char full[] = "-ERR maximum number of clients reached\r\n";
        net_send(fd, full, sizeof(full) - 1);
    }
    net_close(fd);
}

static bool run_loop(Socket listener, Store *store) {
    Client clients[MAX_CLIENTS] = {0};
    PollFd fds[MAX_CLIENTS + 1];
    size_t slots[MAX_CLIENTS + 1];
    for (size_t i = 0; i < MAX_CLIENTS; ++i) {
        clients[i].fd = INVALID_FD;
    }

    bool success = true;
    uint64_t next_maintenance = net_now_ms();
    while (!stopped) {
        uint64_t now = net_now_ms();
        if (now >= next_maintenance) {
            store_maintain(store, now);
            next_maintenance = now + MAINTENANCE_MS;
        }
        size_t count = 1;
        fds[0] = (PollFd){.fd = listener, .events = POLLIN};
        for (size_t i = 0; i < MAX_CLIENTS; ++i) {
            Client *client = &clients[i];
            if (client->fd == INVALID_FD) {
                continue;
            }
            if (!process_input(client, store)) {
                close_client(client);
                continue;
            }
            fds[count] = (PollFd){.fd = client->fd, .events = client->output.end ? POLLOUT : POLLIN};
            slots[count++] = i;
        }

        now = net_now_ms();
        int timeout = now >= next_maintenance ? 0 : (int)(next_maintenance - now);
        int ready = net_poll(fds, count, timeout);
        if (ready < 0) {
            if (stopped || net_retryable()) {
                continue;
            }
            success = false;
            break;
        }
        if (fds[0].revents & (POLLERR | POLLHUP | POLLNVAL)) {
            success = false;
            break;
        }
        if (fds[0].revents & POLLIN) {
            accept_client(listener, clients);
        }
        for (size_t i = 1; i < count; ++i) {
            Client *client = &clients[slots[i]];
            short events = fds[i].revents;
            bool keep = !(events & (POLLERR | POLLNVAL));
            if (keep && client->output.end && (events & (POLLOUT | POLLHUP))) {
                keep = write_client(client);
            } else if (keep && !client->output.end && (events & (POLLIN | POLLHUP))) {
                keep = read_client(client);
            }
            if (!keep) {
                close_client(client);
            }
        }
    }
    for (size_t i = 0; i < MAX_CLIENTS; ++i) {
        if (clients[i].fd != INVALID_FD) {
            close_client(&clients[i]);
        }
    }
    return success;
}

int main(int argc, char **argv) {
    const char *address = "127.0.0.1";
    uint16_t port = 6379;
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--bind") == 0 && i + 1 < argc) {
            address = argv[++i];
        } else if (strcmp(argv[i], "--port") == 0 && i + 1 < argc && net_parse_port(argv[i + 1], &port)) {
            ++i;
        } else {
            fprintf(stderr, "Usage: %s [--bind IPv4] [--port PORT]\n", argv[0]);
            return EXIT_FAILURE;
        }
    }

    Store store;
    if (!store_init(&store)) {
        fputs("Could not initialize storage\n", stderr);
        return EXIT_FAILURE;
    }
    if (!net_init()) {
        fputs("Could not initialize networking\n", stderr);
        store_destroy(&store);
        return EXIT_FAILURE;
    }
    Socket listener = net_listen(address, port, &port);
    bool success = false;
    if (listener != INVALID_FD && net_nonblocking(listener)) {
        signal(SIGINT, stop_server);
        signal(SIGTERM, stop_server);
        printf("Mini Redis listening on %s:%u\n", address, (unsigned)port);
        fflush(stdout);
        success = run_loop(listener, &store);
    }
    if (listener != INVALID_FD) {
        net_close(listener);
    }
    net_cleanup();
    store_destroy(&store);
    if (!success) {
        fputs("Could not start or run Mini Redis TCP server\n", stderr);
    }
    return success ? EXIT_SUCCESS : EXIT_FAILURE;
}
