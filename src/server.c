/*
 * server.c : 단일 스레드 poll 이벤트 루프, 연결별 입출력 버퍼, 응답 직렬화, 시연 로그, 영속성 연결.
 * 명령은 한 번에 하나씩 끝까지 실행되므로(명령 단위 원자성) 저장소에 락이 없다.
 * 설명 문서 : Obsidian 「Mini Redis 내부 API와 실행 흐름」
 */

#include "commands.h"
#include "net.h"
#include "persist.h"
#include "resp.h"

#include <inttypes.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* MAX_CLIENTS : 동시 접속 상한, IO_CHUNK : 한 번에 읽고 쓰는 단위 겸 버퍼 기본 크기, MAINTENANCE_MS : 주기 정리 기본 간격(ms), LOG_PREVIEW : 로그에 보일 인자 · 값 최대 바이트 */
enum { MAX_CLIENTS = 256, IO_CHUNK = 16384, MAINTENANCE_MS = 100, LOG_PREVIEW = 48 };

/*
 * 바이트 버퍼. 유효한 데이터는 data[begin, end) 구간이고, capacity 는 할당된 크기다.
 */
typedef struct {
    char *data;
    size_t capacity;
    size_t begin;
    size_t end;
} Buffer;

/*
 * 클라이언트 연결 하나의 상태.
 * input : 아직 처리하지 않은 받은 바이트, output : 보내야 할 응답(한 번에 응답 하나만 담음)
 * parser : 입력 파싱 진행 상태, close_after_reply : 오류 응답을 다 보낸 뒤 연결을 닫을지
 * id : 접속 순서대로 붙는 연결 ID(1부터, 슬롯 번호와 다름), reply_seq : 출력 버퍼에 든 응답을 만든 명령의 실행 순번(0 이면 명령이 아닌 프레임 오류 응답)
 */
typedef struct {
    Socket fd;
    Buffer input;
    Buffer output;
    RespParser parser;
    bool close_after_reply;
    uint64_t id;
    uint64_t reply_seq;
} Client;

/*
 * 서버 전체 상태(프로세스에 하나).
 * log : 시연 로그 출력 대상(NULL 이면 끔), started_ms : 로그 시각의 기준, next_client_id/exec_seq : 연결 ID · 실행 순번 발급기
 * current_client : 지금 실행 중인 명령의 연결 ID(조회 시 만료 로그용), command_ms/command_unix_ms : 지금 명령의 단조 · 벽시계 시각
 * expire_cycle_ms : 주기 정리 간격(0 이면 주기 정리 끔), snapshot_path : 스냅샷 경로(NULL 이면 끔)
 * aof/aof_enabled : AOF 상태, persistence_failed : AOF 기록 실패(응답하지 않고 종료해야 함), store : 저장소
 */
typedef struct {
    FILE *log;
    uint64_t started_ms;
    uint64_t next_client_id;
    uint64_t exec_seq;
    uint64_t current_client;
    uint64_t command_ms;
    uint64_t command_unix_ms;
    uint64_t expire_cycle_ms;
    const char *snapshot_path;
    Aof aof;
    bool aof_enabled;
    bool persistence_failed;
    Store *store;
} Server;

static Server server = {.expire_cycle_ms = MAINTENANCE_MS, .aof = {.fd = -1}};

/* 종료 신호를 받았는지 나타내는 플래그. 이벤트 루프가 매 반복 확인한다. */
static volatile sig_atomic_t stopped;

/* 시그널 핸들러에서는 플래그만 세운다. 정리는 이벤트 루프가 정상 흐름에서 한다. */
static void stop_server(int signal_number) {
    (void)signal_number;
    stopped = 1;
}

/* ───────── 시연 로그 ───────── */

/* 줄마다 flush 한다 : 강제 종료 직전 줄도 로그 파일에 남겨야 복구 실험을 해석할 수 있다. */
static void log_line(const char *format, ...) {
    if (!server.log) {
        return;
    }
    fprintf(server.log, "[+%7" PRIu64 "ms] ", net_now_ms() - server.started_ms);
    va_list args;
    va_start(args, format);
    vfprintf(server.log, format, args);
    va_end(args);
    fputc('\n', server.log);
    fflush(server.log);
}

/* 로그용 따옴표 문자열. 키 · 값에 CRLF · NUL 이 올 수 있어 출력 불가 바이트는 \xNN 으로, 길면 앞부분만 쓴다. */
static const char *quote(Bytes bytes, char *out, size_t size) {
    size_t used = 0;
    out[used++] = '"';
    size_t shown = bytes.length < LOG_PREVIEW ? bytes.length : LOG_PREVIEW;
    for (size_t i = 0; i < shown && used + 6 < size; ++i) {
        unsigned char c = (unsigned char)bytes.data[i];
        if (c == '"' || c == '\\') {
            out[used++] = '\\';
            out[used++] = (char)c;
        } else if (c >= 0x20 && c < 0x7f) {
            out[used++] = (char)c;
        } else {
            used += (size_t)snprintf(out + used, size - used, "\\x%02x", c);
        }
    }
    out[used++] = '"';
    out[used] = '\0';
    if (shown < bytes.length) {
        snprintf(out + used, size - used, "...(+%zu bytes)", bytes.length - shown);
    }
    return out;
}

static const char *describe_reply(Reply reply, char *out, size_t size) {
    if (reply.type == REPLY_INTEGER) {
        snprintf(out, size, "(integer) %" PRId64, reply.number);
    } else if (reply.type == REPLY_BULK) {
        quote(reply.bytes, out, size);
    } else {
        Bytes text = reply.bytes;
        text.length = text.length >= 2 ? text.length - 2 : 0; /* 끝 CRLF 제외 */
        if (text.length == 3 && memcmp(text.data, "$-1", 3) == 0) {
            snprintf(out, size, "(nil)");
        } else {
            snprintf(out, size, "%s%.*s", text.data[0] == '-' ? "(error) " : "", (int)(text.length - 1), text.data + 1);
        }
    }
    return out;
}

/* store.on_expire 알림. 조회 시 만료는 어떤 명령(순번 · 연결) 안에서 일어났는지도 남긴다. */
static void log_expired(void *context, Bytes key, StoreExpireCause cause) {
    (void)context;
    char text[LOG_PREVIEW * 4 + 64];
    if (cause == STORE_EXPIRED_ON_ACCESS) {
        log_line("EXPIRE on-access key=%s (found expired inside #%" PRIu64 " conn=%" PRIu64 ", removed)",
                 quote(key, text, sizeof(text)), server.exec_seq, server.current_client);
    } else {
        log_line("EXPIRE by-cycle  key=%s (nobody read it, removed by active expiry)", quote(key, text, sizeof(text)));
    }
}

/* ───────── 영속성 연결 ───────── */

/*
 * AOF 기록은 응답을 출력 버퍼에 넣기 전에 끝나야 한다(always 에서 "+OK = 디스크에 있음").
 * 실패하면 persistence_failed 를 켠다 : 호출자는 응답하지 않고 서버를 멈춘다(메모리와 디스크가 갈라진 채 성공을 알리지 않음).
 */
static void record_change(void *context, const Change *change) {
    (void)context;
    if (!server.aof_enabled || server.persistence_failed) {
        return;
    }
    static const char *names[] = {"SET", "DEL", "PEXPIREAT"};
    char key[LOG_PREVIEW * 4 + 64];
    AofWrite written;
    if (!aof_append(&server.aof, change, server.command_ms, server.command_unix_ms, &written)) {
        server.persistence_failed = true;
        log_line("AOF  #%" PRIu64 " %s %s FAILED: %s -> no reply, server stops", server.exec_seq, names[change->type],
                 quote(change->key, key, sizeof(key)), server.aof.error);
        fprintf(stderr, "AOF write failed (%s); stopping without replying\n", server.aof.error);
        return;
    }
    log_line("AOF  #%" PRIu64 " append %s %s (%zu bytes, appendfsync=%s, %s)", server.exec_seq, names[change->type],
             quote(change->key, key, sizeof(key)), written.bytes, persist_policy_name(server.aof.policy),
             written.synced ? "fsync done before reply" : "fsync deferred");
}

/* SAVE. 실패해도 마지막 완성본은 그대로이고 서버는 계속 동작한다. */
static bool save_snapshot(void *context) {
    (void)context;
    size_t saved = 0;
    char error[192] = "";
    bool ok = snapshot_save(server.store, server.snapshot_path, server.command_ms, server.command_unix_ms, &saved,
                            error, sizeof(error));
    if (ok) {
        log_line("SNAP #%" PRIu64 " saved %zu keys to %s (written to .tmp, fsync, then renamed)", server.exec_seq, saved,
                 server.snapshot_path);
    } else {
        log_line("SNAP #%" PRIu64 " save FAILED: %s (previous snapshot kept)", server.exec_seq, error);
    }
    return ok;
}

/* maximum 으로 한 연결이 쓸 수 있는 메모리를 묶는다. */
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

/*
 * Reply 를 출력 버퍼로 복사(직렬화)한다. reply.bytes 는 저장소 값이나 입력 버퍼를 가리키는 view 라서
 * 다음 명령이 그 항목을 바꾸거나 지우기 전에 반드시 복사해 둬야 한다. 연결당 응답 하나만 담는다.
 */
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
    log_line("CONN conn=%" PRIu64 " closed", client->id);
    net_close(client->fd);
    free(client->input.data);
    free(client->output.data);
    *client = (Client){.fd = INVALID_FD};
}

/*
 * 연결의 입력에서 명령을 최대 하나 실행한다. 앞 응답을 다 보내기 전에는 실행하지 않아
 * 응답 순서를 지키고 연결당 출력 버퍼를 하나로 유지한다. 순서 : 파싱 → 실행(AOF 기록) → 응답 복사 → 입력 소비.
 */
static bool process_input(Client *client, Store *store) {
    Buffer *input = &client->input;
    /* 한 번에 명령 하나: 응답이 아직 출력 버퍼에 남아 있으면 다음 명령을 실행하지 않는다. */
    if (input->begin == input->end || client->output.end || client->close_after_reply) {
        return true;
    }
    const char *data = input->data + input->begin;
    RespParser *parser = &client->parser;
    size_t size = input->end - input->begin;
    RespResult result = resp_parse(parser, data, size);
    /* 아직 요청이 다 오지 않은 정상 상황이다. 상한에 닿았는데도 미완성이면 아래에서 오류로 처리한다. */
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
    /* 실행 순번은 실제로 실행한 순서다. 도착 순서가 아니라 이 줄에 닿은 순서로 매긴다. */
    server.current_client = client->id;
    server.exec_seq++;
    server.command_ms = net_now_ms();
    server.command_unix_ms = net_unix_ms();
    CommandContext context = {
        .store = store,
        .now_ms = server.command_ms,
        .record_change = server.aof_enabled ? record_change : NULL,
        .save_snapshot = server.snapshot_path ? save_snapshot : NULL,
    };
    Reply reply = execute_command(&context, args, parser->count);
    /* AOF 기록이 실패한 쓰기는 응답하지 않는다. 클라이언트는 연결 끊김으로 "결과 모름" 을 알게 된다. */
    if (server.persistence_failed) {
        return false;
    }
    /* 다른 명령이 값을 바꾸거나 지우기 전에, 응답을 출력 버퍼로 복사(직렬화)해 둔다. 응답의 bytes 는 저장소 안을 가리키는 view 라서다. */
    if (!queue_reply(&client->output, reply)) {
        return false;
    }
    client->reply_seq = server.exec_seq;
    if (server.log) {
        char line[(RESP_MAX_ARGS + 1) * (LOG_PREVIEW * 4 + 32)];
        char piece[LOG_PREVIEW * 4 + 32];
        size_t used = (size_t)snprintf(line, sizeof(line), "%.*s", (int)(args[0].length < 16 ? args[0].length : 16), args[0].data);
        for (size_t i = 1; i < parser->count && used < sizeof(line); ++i) {
            used += (size_t)snprintf(line + used, sizeof(line) - used, " %s", quote(args[i], piece, sizeof(piece)));
        }
        log_line("EXEC #%" PRIu64 " conn=%" PRIu64 " %s -> %s | reply queued in output buffer (%zu bytes)", server.exec_seq,
                 client->id, line, describe_reply(reply, piece, sizeof(piece)), client->output.end);
    }
    /* 응답을 복사한 뒤에야 이 명령이 쓴 입력 바이트를 소비한다. */
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

/* 한 번에 IO_CHUNK 까지만 읽어 한 연결이 루프를 오래 붙잡지 못하게 한다. 프레임 상한을 넘는 입력은 거절한다. */
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

/* 논블로킹 send 는 일부만 보낼 수 있다. 보낸 만큼 begin 을 옮기고 다음 POLLOUT 때 이어 보낸다. */
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
    log_line("SENT #%" PRIu64 " conn=%" PRIu64 " %zu bytes written to socket", client->reply_seq, client->id, output->end);
    output->begin = output->end = 0;
    if (output->capacity > 4 * IO_CHUNK) {
        free(output->data);
        *output = (Buffer){0};
    }
    return !client->close_after_reply;
}

/* 연결 ID 는 접속 순서(1부터)이고 슬롯 번호와 다르다. 슬롯이 없으면 이유를 보내고 끊는다. */
static void accept_client(Socket listener, Client *clients) {
    Socket fd = net_accept(listener);
    if (fd == INVALID_FD) {
        return;
    }
    if (net_nonblocking(fd)) {
        for (size_t i = 0; i < MAX_CLIENTS; ++i) {
            if (clients[i].fd == INVALID_FD) {
                clients[i].fd = fd;
                clients[i].id = ++server.next_client_id;
                log_line("CONN conn=%" PRIu64 " opened (slot %zu)", clients[i].id, i);
                return;
            }
        }
        const char full[] = "-ERR maximum number of clients reached\r\n";
        net_send(fd, full, sizeof(full) - 1);
    }
    net_close(fd);
}

/*
 * 한 스레드가 주기 정리 · AOF everysec fsync · 명령 실행 · poll · 수락 · 송수신을 번갈아 한다.
 * 명령 실행을 읽은 직후가 아니라 루프 맨 앞에서 연결당 하나씩 해서 한 연결이 루프를 독점하지 못한다.
 */
static bool run_loop(Socket listener, Store *store) {
    Client clients[MAX_CLIENTS] = {0};
    PollFd fds[MAX_CLIENTS + 1];
    size_t slots[MAX_CLIENTS + 1];
    for (size_t i = 0; i < MAX_CLIENTS; ++i) {
        clients[i].fd = INVALID_FD;
    }

    bool success = true;
    /* 주기 정리 시각을 추적한다. 시작하자마자 한 번 실행된다. */
    uint64_t next_maintenance = net_now_ms();
    while (!stopped) {
        uint64_t now = net_now_ms();
        if (server.expire_cycle_ms && now >= next_maintenance) {
            /* 주기 정리(active expiration): 아무도 읽지 않는 만료 키도 이 호출로 지워진다. 커서에서부터 최대 32개만 검사한다. */
            size_t before = store->expiring;
            StoreCycle cycle = store_maintain(store, now);
            if (cycle.removed) {
                log_line("CYCLE checked %zu of %zu TTL keys from cursor (limit 32), removed %zu", cycle.checked, before,
                         cycle.removed);
            }
            next_maintenance = now + server.expire_cycle_ms;
        }
        bool synced;
        if (server.aof_enabled && !aof_sync_if_due(&server.aof, now, &synced)) {
            log_line("AOF  everysec fsync FAILED: %s -> server stops", server.aof.error);
            fprintf(stderr, "AOF fsync failed (%s); stopping\n", server.aof.error);
            success = false;
            break;
        } else if (server.aof_enabled && synced) {
            log_line("AOF  everysec fsync done");
        }
        size_t count = 1;
        fds[0] = (PollFd){.fd = listener, .events = POLLIN};
        for (size_t i = 0; i < MAX_CLIENTS; ++i) {
            Client *client = &clients[i];
            if (client->fd == INVALID_FD) {
                continue;
            }
            /* 읽은 직후가 아니라 루프 맨 앞에서 명령을 실행한다. 연결당 한 번에 한 명령이라 한 연결이 루프를 독점하지 못한다. */
            if (!process_input(client, store)) {
                close_client(client);
                continue;
            }
            /* 응답이 남은 연결은 쓰기만, 아니면 읽기만 감시한다. 응답을 다 보내기 전에는 새 요청을 읽지 않는다. */
            fds[count] = (PollFd){.fd = client->fd, .events = client->output.end ? POLLOUT : POLLIN};
            slots[count++] = i;
        }
        /* AOF 기록이 실패했으면 다른 연결에 남은 응답도 보내지 않고 바로 멈춘다. */
        if (server.persistence_failed) {
            success = false;
            break;
        }

        now = net_now_ms();
        /* 입력이 없어도 주기 정리 시각(또는 everysec fsync)에 맞춰 깨어나도록 poll 대기 시간을 정한다. 주기 정리를 껐으면 1초마다 깬다. */
        uint64_t wake = server.expire_cycle_ms ? next_maintenance : now + 1000;
        /* everysec 에서 아직 fsync 하지 않은 쓰기가 있으면 aof_sync_if_due 의 1초 기준 시각에 맞춰 깬다. 주기 정리 간격이 길어도 fsync 가 늦어지지 않는다. */
        if (server.aof_enabled && server.aof.policy == FSYNC_EVERYSEC && server.aof.pending_sync &&
            server.aof.last_sync_ms + 1000 < wake) {
            wake = server.aof.last_sync_ms + 1000;
        }
        int timeout = now >= wake ? 0 : (int)(wake - now);
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

/* 옵션 해석 → 로그 · 저장소 준비 → 스냅샷/AOF 복원(깨졌으면 시작 거부) → 수신 → run_loop → 정리. */
int main(int argc, char **argv) {
    const char *address = "127.0.0.1";
    uint16_t port = 6379;
    const char *log_path = NULL;
    const char *aof_path = NULL;
    FsyncPolicy policy = FSYNC_EVERYSEC;
    bool usage_error = false;
    for (int i = 1; i < argc && !usage_error; ++i) {
        bool has_value = i + 1 < argc;
        int64_t number = 0;
        if (strcmp(argv[i], "--bind") == 0 && has_value) {
            address = argv[++i];
        } else if (strcmp(argv[i], "--port") == 0 && has_value && net_parse_port(argv[i + 1], &port)) {
            ++i;
        } else if (strcmp(argv[i], "--log") == 0 && has_value) {
            log_path = argv[++i];
        } else if (strcmp(argv[i], "--snapshot") == 0 && has_value) {
            server.snapshot_path = argv[++i];
        } else if (strcmp(argv[i], "--aof") == 0 && has_value) {
            aof_path = argv[++i];
        } else if (strcmp(argv[i], "--appendfsync") == 0 && has_value && persist_parse_policy(argv[i + 1], &policy)) {
            ++i;
        } else if (has_value && resp_integer((Bytes){argv[i + 1], strlen(argv[i + 1])}, &number) && number >= 0 &&
                   (strcmp(argv[i], "--expire-cycle-ms") == 0 || strcmp(argv[i], "--debug-aof-fail-at") == 0 ||
                    strcmp(argv[i], "--debug-snapshot-crash-after") == 0)) {
            if (strcmp(argv[i], "--expire-cycle-ms") == 0) {
                server.expire_cycle_ms = (uint64_t)number;
            } else if (strcmp(argv[i], "--debug-aof-fail-at") == 0) {
                server.aof.fail_at = (uint64_t)number;
            } else {
                snapshot_crash_after_entries = (size_t)number;
            }
            ++i;
        } else {
            usage_error = true;
        }
    }
    if (usage_error || (server.snapshot_path && aof_path)) {
        fprintf(stderr,
                "Usage: %s [--bind IPv4] [--port PORT] [--log FILE|-] [--expire-cycle-ms MS(0=off)]\n"
                "          [--snapshot FILE | --aof FILE [--appendfsync always|everysec|no]]\n"
                "          [--debug-aof-fail-at N] [--debug-snapshot-crash-after N]\n",
                argv[0]);
        return EXIT_FAILURE;
    }

    server.started_ms = net_now_ms();
    if (log_path) {
        server.log = strcmp(log_path, "-") == 0 ? stderr : fopen(log_path, "w");
        if (!server.log) {
            fprintf(stderr, "Could not open log file %s\n", log_path);
            return EXIT_FAILURE;
        }
    }
    Store store;
    if (!store_init(&store)) {
        fputs("Could not initialize storage\n", stderr);
        return EXIT_FAILURE;
    }
    store.on_expire = log_expired;
    server.store = &store;

    LoadReport report = {0};
    bool loaded = true;
    const char *mode = NULL;
    if (server.snapshot_path) {
        mode = "snapshot";
        loaded = snapshot_load(&store, server.snapshot_path, net_now_ms(), net_unix_ms(), &report);
    } else if (aof_path) {
        mode = "aof";
        loaded = aof_open(&server.aof, aof_path, policy, &store, net_now_ms(), net_unix_ms(), &report);
        server.aof_enabled = loaded;
    }
    if (mode) {
        char summary[320];
        if (loaded) {
            snprintf(summary, sizeof(summary),
                     "LOAD %s %s: %zu %s applied, %zu skipped as expired during downtime, %zu bytes of incomplete tail truncated%s%s",
                     mode, server.snapshot_path ? server.snapshot_path : aof_path, report.loaded,
                     server.snapshot_path ? "keys" : "records", report.skipped_expired, report.truncated_bytes,
                     aof_path ? ", appendfsync=" : "", aof_path ? persist_policy_name(policy) : "");
        } else {
            snprintf(summary, sizeof(summary), "LOAD %s FAILED: %s", mode, report.error);
        }
        fprintf(stderr, "%s\n", summary);
        log_line("%s", summary);
        if (!loaded) {
            store_destroy(&store);
            return EXIT_FAILURE;
        }
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
    aof_close(&server.aof);
    net_cleanup();
    store_destroy(&store);
    if (!success) {
        fputs("Could not start or run Mini Redis TCP server\n", stderr);
    }
    if (server.log && server.log != stderr) {
        fclose(server.log);
    }
    return success ? EXIT_SUCCESS : EXIT_FAILURE;
}
