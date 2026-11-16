/*
 * server.c
 *
 * 정의 : Mini Redis TCP 서버의 진입점과 단일 스레드 이벤트 루프.
 * 책임 :
 *   - 연결 수락, 연결별 입력 · 출력 버퍼 관리, 요청 파싱 호출, 응답 직렬화, 종료 신호 처리를 맡는다.
 *   - poll 한 번으로 서버 소켓과 모든 클라이언트를 감시한다. 스레드를 쓰지 않으므로 명령은 한 번에 하나씩, 끝까지 실행된다(명령 단위 원자성).
 *   - 연결마다 응답이 다 나가야 다음 명령을 처리해 응답 순서를 지키고 버퍼를 한 개로 유지한다.
 *   - 주기(--expire-cycle-ms, 기본 100ms)마다 store_maintain 을 불러 만료 항목을 정리한다(주기 정리).
 *   - 시연 로그(--log) : 연결 ID, 명령 실행 순번, 명령과 키, 결과를 "응답을 출력 버퍼에 넣은 시점(EXEC)" 과 "소켓으로 다 보낸 시점(SENT)" 으로 나눠 기록한다.
 *   - 영속성(--snapshot 또는 --aof) : 시작할 때 파일에서 복원하고, 상태를 바꾼 명령을 응답 전에 AOF 에 기록한다. AOF 기록이 실패하면 응답하지 않고 종료한다.
 *   - 맡지 않는 것 : RESP 바이트 해석(resp.c), 명령 의미(commands.c), 저장 구조(store.c), 파일 형식(persist.c), OS 소켓 차이(net.c)
 * 위치 : 프로그램의 최상위다. 아래 모듈을 모두 사용한다(net -> resp -> commands -> store, persist).
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

/*
 * 정의 : SIGINT, SIGTERM 을 받았을 때 호출되는 시그널 핸들러.
 * 설명 : 시그널 핸들러 안에서는 할 수 있는 일이 제한된다. 플래그만 세우고 정리는 이벤트 루프가 정상 흐름에서 하게 한다.
 * 입력 : signal_number : 받은 시그널 번호(사용하지 않음)
 * 출력 : 없음
 * 동작 :
 *   1. stopped 를 1 로 만든다.
 */
static void stop_server(int signal_number) {
    (void)signal_number;
    stopped = 1;
}

/* ───────── 시연 로그 ───────── */

/*
 * 정의 : 시연 로그에 한 줄을 쓰는 함수.
 * 설명 : 줄 앞에 서버 시작부터 지난 ms 를 붙여 사건의 순서와 간격을 보이게 한다. 줄마다 flush 해서 강제 종료 직전 줄도 파일에 남긴다. 로그가 꺼져 있으면 아무것도 하지 않는다.
 * 입력 : format/... : printf 형식
 * 출력 : 없음
 * 동작 :
 *   1. log 가 NULL 이면 끝낸다.
 *   2. "[+경과ms] " 머리, 본문, 줄바꿈을 쓰고 flush 한다.
 */
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

/*
 * 정의 : 바이트열을 로그용 따옴표 문자열로 바꾸는 함수.
 * 설명 : 키 · 값에는 줄바꿈이나 NUL 같은 바이트가 들어갈 수 있다. 출력 가능한 ASCII 는 그대로(따옴표와 역슬래시는 앞에 \ 를 붙임), 나머지는 \xNN 으로 바꾸고, 길면 앞부분만 보이고 남은 길이를 적는다.
 * 입력 : bytes : 바꿀 바이트열, out/size : 결과 버퍼
 * 출력 : out(널 종료)
 * 동작 :
 *   1. 여는 따옴표를 쓴다.
 *   2. LOG_PREVIEW 바이트까지 한 바이트씩 바꿔 쓴다.
 *   3. 닫는 따옴표와, 잘랐으면 "...(+N bytes)" 를 붙인다.
 */
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

/*
 * 정의 : 응답 값을 redis-cli 와 비슷한 글자로 바꾸는 함수.
 * 설명 : 로그에서 "어떤 명령이 무엇을 돌려줬는지" 를 바로 읽게 한다. nil, 정수, 오류, 문자열을 구분한다.
 * 입력 : reply : 응답, out/size : 결과 버퍼
 * 출력 : out
 * 동작 :
 *   1. 정수는 "(integer) N", bulk 는 따옴표 문자열.
 *   2. TEXT 중 "$-1" 은 "(nil)", "-" 로 시작하면 "(error) ...", "+" 면 그 뒤 글자.
 */
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

/*
 * 정의 : 저장소가 만료 항목을 지울 때 불리는 알림 함수(store.on_expire).
 * 설명 : 조회 시 만료와 주기 정리를 로그에서 구분한다. 조회 시 만료는 어떤 명령(실행 순번 · 연결) 안에서 일어났는지도 남긴다.
 * 입력 : context : 사용하지 않음, key : 지울 키, cause : 지우는 경로
 * 출력 : 없음
 * 동작 :
 *   1. 조회 시 만료면 "EXPIRE on-access" 와 지금 명령의 순번 · 연결을, 주기 정리면 "EXPIRE by-cycle" 을 쓴다.
 */
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
 * 정의 : 명령이 상태를 바꿀 때 불리는 기록 함수(CommandContext.record_change).
 * 설명 : AOF 모드에서 바뀐 내용을 응답 전에 파일에 덧붙인다. 실패하면 persistence_failed 를 켜서 호출자가 응답하지 않고 서버를 멈추게 한다.
 * 입력 : context : 사용하지 않음, change : 바뀐 내용
 * 출력 : 없음
 * 동작 :
 *   1. AOF 가 꺼져 있거나 이미 실패했으면 끝낸다.
 *   2. aof_append 하고 결과(바이트, fsync 여부와 정책)를 로그에 남긴다.
 *   3. 실패하면 로그 · 표준 오류에 이유를 쓰고 persistence_failed 를 켠다.
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

/*
 * 정의 : SAVE 명령이 부르는 스냅샷 저장 함수(CommandContext.save_snapshot).
 * 설명 : 지금 저장소 상태를 스냅샷 파일로 쓴다. 실패해도 마지막 완성본은 그대로이고 서버는 계속 동작한다.
 * 입력 : context : 사용하지 않음
 * 출력 : 성공하면 true
 * 동작 :
 *   1. snapshot_save 를 부르고 결과를 로그에 남긴다.
 */
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

/*
 * 정의 : 버퍼 용량을 required 이상으로 늘리는 함수.
 * 설명 : 요청과 응답 크기가 제각각이라 필요할 때 키운다. 상한(maximum)을 두어 한 연결이 메모리를 무한정 쓰지 못하게 한다.
 * 입력 : buffer : 대상 버퍼, required : 필요한 용량, maximum : 허용하는 최대 용량
 * 출력 : 이미 충분하거나 늘리는 데 성공하면 true, 메모리 할당 실패면 false
 * 동작 :
 *   1. 이미 용량이 충분하면 바로 true.
 *   2. IO_CHUNK 에서 시작해 필요한 크기가 될 때까지 두 배로 키운다.
 *   3. 상한을 넘으면 상한으로 줄인다.
 *   4. realloc 으로 다시 할당해 반영한다.
 */
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
 * 정의 : Reply 를 RESP2 바이트로 직렬화해 출력 버퍼에 담는 함수.
 * 설명 : 명령 결과를 와이어 형식으로 바꾸는 곳이다. 값을 출력 버퍼에 복사하므로 이후 저장소의 값이 바뀌거나 지워져도 응답이 안전하다. 연결마다 응답을 하나씩만 담으므로 버퍼를 처음부터 덮어쓴다.
 * 입력 : output : 연결의 출력 버퍼(비어 있어야 함), reply : 직렬화할 응답
 * 출력 : 성공하면 true, 버퍼를 늘리지 못하면 false
 * 동작 :
 *   1. TEXT 는 이미 RESP 형식이니 그대로 쓴다.
 *   2. INTEGER 는 ":숫자\r\n" 으로, BULK 는 "$길이\r\n" 머리를 만든다.
 *   3. 머리 + 본문 + 끝 CRLF 의 전체 길이만큼 출력 버퍼를 확보한다.
 *   4. 머리와 본문, 끝 CRLF 를 차례로 복사한다.
 *   5. begin 을 0, end 를 전체 길이로 정한다.
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

/*
 * 정의 : 클라이언트 연결을 닫고 자원을 해제하는 함수.
 * 설명 : 연결 오류나 종료 때 소켓과 버퍼 메모리를 모두 돌려주고 슬롯을 빈 칸으로 만들어 새 연결이 재사용하게 한다.
 * 입력 : client : 닫을 연결
 * 출력 : 없음
 * 동작 :
 *   1. 소켓을 닫는다.
 *   2. 입력, 출력 버퍼를 free 한다.
 *   3. 연결 구조체를 fd 가 INVALID_FD 인 빈 상태로 되돌린다.
 */
static void close_client(Client *client) {
    log_line("CONN conn=%" PRIu64 " closed", client->id);
    net_close(client->fd);
    free(client->input.data);
    free(client->output.data);
    *client = (Client){.fd = INVALID_FD};
}

/*
 * 정의 : 연결에 쌓인 입력에서 명령 하나를 꺼내 실행하고 응답을 출력 버퍼에 담는 함수.
 * 설명 : 단일 스레드 이벤트 루프에서 명령 단위 원자성이 지켜지는 지점이다. 한 번 호출에 명령을 최대 하나만 실행하고, 그 응답을 복사해 둔 뒤에야 입력을 소비한다. 앞 응답이 다 나가기 전에는 다음 명령을 실행하지 않아 응답 순서와 버퍼 하나 정책을 지킨다.
 * 입력 : client : 대상 연결, store : 저장소
 * 출력 : 계속 유지하면 true, 연결을 닫아야 하면 false(메모리 부족 등)
 * 동작 :
 *   1. 입력이 없거나 보낼 응답이 남았거나 닫을 예정이면 아무것도 하지 않고 true.
 *   2. resp_parse 로 요청 하나를 파싱한다. 데이터가 모자라면 더 받을 때까지 기다린다.
 *   3. 형식 오류이거나 상한까지 찼는데도 완성되지 않으면 오류 응답을 담고 보낸 뒤 닫도록 표시한다.
 *   4. 파싱된 인자를 입력 버퍼를 가리키는 Bytes 배열로 만든다.
 *   5. execute_command 를 실행하고 결과를 출력 버퍼에 복사한다.
 *   6. 처리한 만큼 입력을 소비하고 파서를 초기화한다. 입력이 비면 인덱스를 0 으로 돌리고 큰 버퍼는 해제한다.
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

/*
 * 정의 : 연결 소켓에서 읽을 수 있는 만큼 입력 버퍼로 읽어 오는 함수.
 * 설명 : 논블로킹 소켓이라 데이터가 쪼개져 올 수 있고, 한 번에 IO_CHUNK 만 읽어 한 연결이 루프를 오래 붙잡지 못하게 한다. 프레임 상한을 넘겨 쌓이는 입력은 거절한다.
 * 입력 : client : 대상 연결
 * 출력 : 연결을 유지하면 true, 상대가 닫았거나 오류이거나 버퍼를 못 늘리면 false
 * 동작 :
 *   1. 앞쪽에 처리된 공간이 있고 뒤쪽 여유가 IO_CHUNK 보다 작으면 남은 데이터를 앞으로 당긴다.
 *   2. 읽을 수 있는 양을 프레임 상한과 IO_CHUNK 중 작은 쪽으로 정하고 버퍼를 확보한다.
 *   3. net_recv 로 읽는다. 0 이하이면 재시도 가능한 오류일 때만 true.
 *   4. 읽은 만큼 end 를 늘린다.
 */
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

/*
 * 정의 : 출력 버퍼의 응답을 소켓으로 보내는 함수.
 * 설명 : 논블로킹 소켓은 한 번에 다 못 보낼 수 있다. 보낸 만큼 begin 을 옮겨 두고 다음 POLLOUT 때 이어서 보낸다. 오류 응답 뒤에는 연결을 닫는다.
 * 입력 : client : 대상 연결
 * 출력 : 연결을 유지하면 true, 오류이거나 오류 응답을 다 보낸 뒤면 false
 * 동작 :
 *   1. 남은 양 중 최대 IO_CHUNK 만 보낸다.
 *   2. 0 이하이면 재시도 가능한 오류일 때만 true.
 *   3. 보낸 만큼 begin 을 옮기고 아직 남았으면 true.
 *   4. 다 보냈으면 인덱스를 0 으로 돌리고 큰 버퍼는 해제한다.
 *   5. close_after_reply 가 켜져 있으면 false 를 돌려 연결을 닫게 한다.
 */
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

/*
 * 정의 : 새 접속을 받아 빈 클라이언트 슬롯에 넣는 함수.
 * 설명 : 서버 소켓이 읽기 가능일 때 불린다. 접속 수 상한을 두어 자원 고갈을 막고, 꽉 찼으면 사유를 알리고 끊는다.
 * 입력 : listener : 서버 소켓, clients : 슬롯 배열(MAX_CLIENTS 개)
 * 출력 : 없음
 * 동작 :
 *   1. net_accept 로 접속을 받는다. 실패하면 끝낸다.
 *   2. 논블로킹으로 바꾸고 빈 슬롯을 찾아 fd 를 넣는다.
 *   3. 빈 슬롯이 없으면 최대 접속 수 오류를 보내고 소켓을 닫는다.
 *   4. 논블로킹 전환에 실패해도 소켓을 닫는다.
 */
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
 * 정의 : poll 기반 단일 스레드 이벤트 루프.
 * 설명 : 서버의 중심이다. 접속 수락, 입력 처리, 응답 송신, 주기 정리를 한 스레드가 번갈아 한다. 스레드가 하나라 명령이 서로 끼어들 수 없고 락이 필요 없다.
 * 입력 : listener : 논블로킹 서버 소켓, store : 저장소
 * 출력 : 정상 종료(시그널)면 true, poll 오류나 서버 소켓 오류면 false
 * 동작 :
 *   1. 주기 정리가 켜져 있고 시각이 되면 store_maintain 을 실행하고, 지운 항목이 있으면 로그에 남긴다. everysec 이면 밀린 fsync 를 한다.
 *   2. 연결마다 process_input 으로 대기 중인 명령을 처리한다. 응답이 남았으면 POLLOUT, 아니면 POLLIN 을 감시한다. AOF 기록이 실패했으면 루프를 멈춘다.
 *   3. 다음 주기 정리 시각까지를 대기 시간으로 net_poll 을 한다.
 *   4. 서버 소켓이 읽기 가능이면 접속을 받는다.
 *   5. 준비된 연결은 응답이 있으면 write_client, 없으면 read_client 를 하고 실패하면 닫는다.
 *   6. stopped 가 켜지면 루프를 나와 모든 연결을 닫는다.
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

/*
 * 정의 : 서버를 설정하고 실행하는 프로그램 진입점.
 * 설명 : 명령줄 옵션을 읽고, 저장소와 네트워크를 준비한 뒤 이벤트 루프를 돌리고, 끝나면 자원을 순서대로 정리한다.
 * 입력 : argc/argv : 명령줄 인자(아래 Usage 문자열 참고)
 * 출력 : 정상 종료면 EXIT_SUCCESS, 옵션 오류나 시작 · 실행 실패면 EXIT_FAILURE
 * 동작 :
 *   1. 옵션을 해석한다. 잘못되거나 --snapshot 과 --aof 를 함께 주면 사용법을 출력하고 종료한다.
 *   2. 로그 출력 대상을 열고 store_init 을 한 뒤 만료 알림 함수를 등록한다.
 *   3. 스냅샷 또는 AOF 에서 복원한다. 파일이 깨졌으면 시작하지 않는다. 복원 결과는 표준 오류와 로그에 쓴다.
 *   4. net_init, net_listen 으로 서버 소켓을 열고 논블로킹으로 바꾼다(포트 0 이면 실제 포트로 갱신).
 *   5. 종료 시그널 핸들러를 등록하고 수신 주소를 출력한다(시험 코드가 읽는 첫 줄이라 형식을 바꾸지 않는다).
 *   6. run_loop 를 실행한다.
 *   7. AOF, 서버 소켓, 네트워크, 저장소, 로그를 정리하고 결과를 돌려준다.
 */
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
