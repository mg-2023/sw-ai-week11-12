/*
 * persist.c
 *
 * 정의 : persist.h 의 구현. RDB 방식의 스냅샷 파일과 AOF 파일을 쓰고 읽는다.
 * 책임 :
 *   - 스냅샷 형식(자체 형식, 리틀 엔디언) :
 *       "MRSNAP01" | 저장 시각 u64 | { 'E' 만료 시각 u64 | 키 길이 u32 | 값 길이 u32 | 키 | 값 }* | 'Z' 항목 수 u64 | 체크섬 u64
 *       만료 시각은 Unix ms(0 이면 TTL 없음), 체크섬은 앞의 모든 바이트에 대한 FNV-1a 64비트다.
 *   - 스냅샷 교체 : "경로.tmp" 에 끝까지 쓰고 fsync 한 뒤에만 원래 경로로 이름을 바꾼다. 쓰는 도중 멈추면 원래 파일은 그대로 남는다.
 *   - AOF 형식 : 요청과 같은 RESP2 배열을 실행 순서대로 이어 쓴다. SET key value [PXAT unix_ms], DEL key, PEXPIREAT key unix_ms
 *   - AOF 끝의 불완전한 레코드(쓰는 도중 종료)는 잘라 내고 앞의 레코드만 재생한다. 중간이 깨졌으면 시작을 거부한다.
 *   - 맡지 않는 것 : 명령 해석, 언제 저장할지, 소켓
 * 위치 : server.c 가 부른다. 파일 입출력 차이(Windows / POSIX)는 이 파일 안의 작은 도우미 함수가 가린다.
 */

#define _POSIX_C_SOURCE 200809L
#include "persist.h"
#include "resp.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <sys/stat.h>
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

size_t snapshot_crash_after_entries;

static const char SNAPSHOT_MAGIC[8] = {'M', 'R', 'S', 'N', 'A', 'P', '0', '1'};

/* ───────── 파일 입출력 도우미 (Windows / POSIX) ───────── */

/*
 * 정의 : 파일을 열어 파일 기술자를 돌려주는 함수.
 * 설명 : 스냅샷 임시 파일은 새로 만들어 덮어쓰고(truncate), AOF 는 읽기 · 쓰기와 덧붙이기로 연다. Windows 는 바이너리 모드를 따로 지정해야 CRLF 변환이 일어나지 않는다.
 * 입력 : path : 경로, append : true 면 AOF 용(만들기 + 읽기쓰기 + 덧붙이기), false 면 새로 쓰기
 * 출력 : 파일 기술자, 실패하면 -1
 * 동작 :
 *   1. 운영체제별 플래그를 골라 open 한다.
 */
static int open_file(const char *path, bool append) {
#ifdef _WIN32
    int flags = _O_BINARY | _O_CREAT | (append ? (_O_RDWR | _O_APPEND) : (_O_WRONLY | _O_TRUNC));
    return _open(path, flags, _S_IREAD | _S_IWRITE);
#else
    int flags = O_CREAT | (append ? (O_RDWR | O_APPEND) : (O_WRONLY | O_TRUNC));
    return open(path, flags, 0644);
#endif
}

/*
 * 정의 : 파일 기술자를 닫는 함수.
 * 설명 : 운영체제별 이름 차이(_close, close)를 가린다.
 * 입력 : fd : 닫을 파일 기술자
 * 출력 : 성공하면 true
 * 동작 :
 *   1. 운영체제에 맞는 close 를 부른다.
 */
static bool close_file(int fd) {
#ifdef _WIN32
    return _close(fd) == 0;
#else
    return close(fd) == 0;
#endif
}

/*
 * 정의 : 버퍼 전체를 파일에 쓰는 함수.
 * 설명 : write 는 요청보다 적게 쓸 수 있어서 다 쓸 때까지 반복한다. 실패하면 일부만 쓰였을 수 있다(AOF 는 재시작 때 불완전한 끝을 잘라 낸다).
 * 입력 : fd : 파일 기술자, data/length : 쓸 바이트
 * 출력 : 모두 썼으면 true
 * 동작 :
 *   1. 남은 길이가 0 이 될 때까지 write 를 반복한다.
 *   2. 0 이하를 돌려받으면 false(EINTR 는 다시 시도).
 */
static bool write_all(int fd, const char *data, size_t length) {
    while (length) {
        unsigned chunk = length > (1u << 30) ? (1u << 30) : (unsigned)length;
#ifdef _WIN32
        int written = _write(fd, data, chunk);
#else
        ssize_t written = write(fd, data, chunk);
#endif
        if (written <= 0) {
            if (written < 0 && errno == EINTR) {
                continue;
            }
            return false;
        }
        data += written;
        length -= (size_t)written;
    }
    return true;
}

/*
 * 정의 : 파일 내용을 디스크까지 내려보내는 함수(fsync).
 * 설명 : write 가 끝나도 데이터는 운영체제 캐시에 있을 수 있다. 전원이 꺼져도 남아야 하는 지점(스냅샷 교체 전, AOF always)에서 부른다.
 * 입력 : fd : 파일 기술자
 * 출력 : 성공하면 true
 * 동작 :
 *   1. Windows : _commit, POSIX : fsync 를 부른다.
 */
static bool sync_file(int fd) {
#ifdef _WIN32
    return _commit(fd) == 0;
#else
    return fsync(fd) == 0;
#endif
}

/*
 * 정의 : 파일 길이를 length 로 자르는 함수.
 * 설명 : AOF 끝의 불완전한 레코드를 버린 뒤, 새 레코드가 깨진 바이트 뒤가 아니라 마지막 온전한 레코드 바로 뒤에 붙게 한다.
 * 입력 : fd : 파일 기술자, length : 남길 길이
 * 출력 : 성공하면 true
 * 동작 :
 *   1. Windows : _chsize_s, POSIX : ftruncate 를 부른다.
 */
static bool truncate_file(int fd, size_t length) {
#ifdef _WIN32
    return _chsize_s(fd, (long long)length) == 0;
#else
    return ftruncate(fd, (off_t)length) == 0;
#endif
}

/*
 * 정의 : 임시 파일을 원래 경로로 바꿔 끼우는 함수.
 * 설명 : 스냅샷을 원래 파일에 바로 덮어쓰면 쓰는 도중 멈췄을 때 마지막 완성본까지 잃는다. 다 쓴 임시 파일을 한 번에 교체하면 원래 경로에는 항상 옛 완성본 아니면 새 완성본만 있다.
 * 입력 : from : 다 쓴 임시 파일, to : 원래 경로
 * 출력 : 성공하면 true
 * 동작 :
 *   1. Windows : MoveFileExA 에 기존 파일 교체와 완료까지 기다리기(WRITE_THROUGH)를 지정한다.
 *   2. POSIX : rename 은 같은 파일 시스템 안에서 원자적으로 교체한다.
 */
static bool replace_file(const char *from, const char *to) {
#ifdef _WIN32
    return MoveFileExA(from, to, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
#else
    return rename(from, to) == 0;
#endif
}

/*
 * 정의 : 파일 전체를 메모리로 읽는 함수.
 * 설명 : 스냅샷과 AOF 는 시작할 때 한 번 처음부터 끝까지 읽는다. 파일이 없으면 오류가 아니라 "비어 있음" 으로 본다(첫 실행).
 * 입력 : path : 경로, data/length : 결과를 받을 곳(호출자가 free), exists : 파일이 있었는지
 * 출력 : 읽었거나 파일이 없으면 true, 읽기 실패면 false
 * 동작 :
 *   1. fopen 에 실패하고 errno 가 ENOENT 면 exists=false, true.
 *   2. 끝까지 읽으며 버퍼를 두 배씩 늘린다.
 */
static bool read_file(const char *path, char **data, size_t *length, bool *exists) {
    *data = NULL;
    *length = 0;
    *exists = false;
    FILE *file = fopen(path, "rb");
    if (!file) {
        return errno == ENOENT;
    }
    *exists = true;
    size_t capacity = 0;
    for (;;) {
        if (*length == capacity) {
            size_t grown = capacity ? capacity * 2 : 65536;
            char *bigger = realloc(*data, grown);
            if (!bigger) {
                fclose(file);
                return false;
            }
            *data = bigger;
            capacity = grown;
        }
        size_t got = fread(*data + *length, 1, capacity - *length, file);
        *length += got;
        if (got == 0) {
            break;
        }
    }
    bool ok = !ferror(file);
    fclose(file);
    return ok;
}

/* ───────── 시각 변환 ───────── */

/*
 * 정의 : 저장소의 만료 시각(단조 ms)을 파일에 쓸 Unix ms 로 바꾸는 함수.
 * 설명 : 단조 시계는 프로세스 · 부팅마다 기준점이 달라 파일에 그대로 쓰면 재시작 뒤 해석할 수 없다. "지금 Unix 시각 + 남은 시간" 으로 바꿔 쓴다.
 * 입력 : deadline_ms : 단조 만료 시각(0 이면 TTL 없음), now_ms : 지금 단조 시각, unix_ms : 지금 Unix 시각
 * 출력 : Unix ms 만료 시각(TTL 없으면 0)
 * 동작 :
 *   1. 0 이면 0.
 *   2. 이미 지났으면 지금 Unix 시각, 아니면 지금 Unix 시각 + 남은 ms.
 */
static uint64_t to_unix(uint64_t deadline_ms, uint64_t now_ms, uint64_t unix_ms) {
    if (!deadline_ms) {
        return 0;
    }
    return deadline_ms <= now_ms ? unix_ms : unix_ms + (deadline_ms - now_ms);
}

/*
 * 정의 : 파일에서 읽은 Unix ms 만료 시각을 이번 실행의 단조 시각으로 바꾸는 함수.
 * 설명 : 서버가 꺼져 있던 시간도 TTL 에서 빠져야 한다. Unix 시각끼리 비교해 이미 지났으면 만료로 보고, 남았으면 "지금 단조 시각 + 남은 시간" 으로 바꾼다. TTL 이 처음부터 다시 시작되지 않는다.
 * 입력 : unix_deadline : 파일의 만료 시각(0 이면 TTL 없음), now_ms/unix_ms : 지금 시각 두 가지, deadline_ms : 결과
 * 출력 : 살아 있으면 true, 이미 만료됐으면 false
 * 동작 :
 *   1. 0 이면 TTL 없음(deadline 0), true.
 *   2. unix_ms 이상 지났으면 false.
 *   3. 아니면 now_ms + 남은 ms 를 담고 true.
 */
static bool to_monotonic(uint64_t unix_deadline, uint64_t now_ms, uint64_t unix_ms, uint64_t *deadline_ms) {
    if (!unix_deadline) {
        *deadline_ms = 0;
        return true;
    }
    if (unix_deadline <= unix_ms) {
        return false;
    }
    *deadline_ms = now_ms + (unix_deadline - unix_ms);
    return true;
}

/* ───────── 스냅샷 ───────── */

/*
 * 스냅샷을 쓰는 동안의 상태.
 * fd : 임시 파일, buffer/used : 모아 두었다가 한 번에 쓸 바이트, checksum : 지금까지 쓴 바이트의 FNV-1a
 * entries : 쓴 항목 수, now_ms/unix_ms : 시각 변환 기준, ok : 쓰기 실패가 있었는지
 */
typedef struct {
    int fd;
    char buffer[65536];
    size_t used;
    uint64_t checksum;
    uint64_t entries;
    uint64_t now_ms;
    uint64_t unix_ms;
    bool ok;
} SnapshotWriter;

/*
 * 정의 : 바이트 조각을 체크섬에 반영하는 함수(FNV-1a 64).
 * 설명 : 불러올 때 같은 계산을 다시 해서 파일이 잘리거나 바뀌지 않았는지 확인한다.
 * 입력 : hash : 지금까지의 값, data/length : 더할 바이트
 * 출력 : 새 체크섬
 * 동작 :
 *   1. 바이트마다 XOR 뒤 FNV 소수를 곱한다.
 */
static uint64_t checksum_update(uint64_t hash, const char *data, size_t length) {
    for (size_t i = 0; i < length; ++i) {
        hash ^= (unsigned char)data[i];
        hash *= UINT64_C(1099511628211);
    }
    return hash;
}

/*
 * 정의 : 모아 둔 바이트를 임시 파일에 쓰는 함수.
 * 설명 : 항목마다 write 를 부르면 시스템 콜이 많아진다. 64 KiB 씩 모아서 쓴다.
 * 입력 : writer : 쓰기 상태
 * 출력 : 없음(실패하면 writer->ok 가 false)
 * 동작 :
 *   1. 모인 바이트가 있고 아직 실패가 없으면 write_all 한다.
 *   2. used 를 0 으로 되돌린다.
 */
static void writer_flush(SnapshotWriter *writer) {
    if (writer->used && writer->ok) {
        writer->ok = write_all(writer->fd, writer->buffer, writer->used);
    }
    writer->used = 0;
}

/*
 * 정의 : 바이트 조각을 스냅샷에 덧붙이는 함수(체크섬 갱신 포함).
 * 설명 : 큰 값은 버퍼를 거치지 않고 바로 쓴다.
 * 입력 : writer : 쓰기 상태, data/length : 쓸 바이트
 * 출력 : 없음
 * 동작 :
 *   1. 체크섬에 반영한다.
 *   2. 버퍼에 다 안 들어가면 먼저 비운다. 버퍼보다 크면 바로 쓴다.
 *   3. 아니면 버퍼에 복사한다.
 */
static void writer_put(SnapshotWriter *writer, const void *data, size_t length) {
    writer->checksum = checksum_update(writer->checksum, data, length);
    if (writer->used + length > sizeof(writer->buffer)) {
        writer_flush(writer);
    }
    if (length > sizeof(writer->buffer)) {
        writer->ok = writer->ok && write_all(writer->fd, data, length);
        return;
    }
    memcpy(writer->buffer + writer->used, data, length);
    writer->used += length;
}

/*
 * 정의 : 정수를 리틀 엔디언 n 바이트로 덧붙이는 함수.
 * 설명 : 실행 환경의 바이트 순서와 상관없이 같은 파일 형식이 되게 한다.
 * 입력 : writer : 쓰기 상태, value : 정수, bytes : 4 또는 8
 * 출력 : 없음
 * 동작 :
 *   1. 아래 바이트부터 차례로 꺼내 배열에 담고 writer_put 한다.
 */
static void writer_put_uint(SnapshotWriter *writer, uint64_t value, size_t bytes) {
    unsigned char encoded[8];
    for (size_t i = 0; i < bytes; ++i) {
        encoded[i] = (unsigned char)(value >> (8 * i));
    }
    writer_put(writer, encoded, bytes);
}

/*
 * 정의 : store_foreach 가 항목마다 부르는 방문 함수. 항목 하나를 스냅샷에 쓴다.
 * 설명 : 'E' 표시, Unix ms 만료 시각, 키 · 값 길이, 키, 값 순서다. 시험용 장애 주입이 켜져 있으면 정해진 개수를 쓴 직후 프로세스를 끝내 "쓰기 도중 강제 종료" 를 만든다.
 * 입력 : context : SnapshotWriter, key/value : 항목, deadline_ms : 단조 만료 시각
 * 출력 : 계속하면 true, 쓰기가 실패했으면 false(순회 중단)
 * 동작 :
 *   1. 키 · 값 길이가 u32 를 넘으면 실패.
 *   2. 필드를 차례로 덧붙이고 항목 수를 늘린다.
 *   3. 장애 주입 개수에 닿으면 버퍼를 비운 뒤 _Exit(3).
 */
static bool write_entry(void *context, Bytes key, Bytes value, uint64_t deadline_ms) {
    SnapshotWriter *writer = context;
    if (key.length > UINT32_MAX || value.length > UINT32_MAX) {
        writer->ok = false;
        return false;
    }
    writer_put(writer, "E", 1);
    writer_put_uint(writer, to_unix(deadline_ms, writer->now_ms, writer->unix_ms), 8);
    writer_put_uint(writer, key.length, 4);
    writer_put_uint(writer, value.length, 4);
    writer_put(writer, key.data, key.length);
    writer_put(writer, value.data, value.length);
    ++writer->entries;
    if (snapshot_crash_after_entries && writer->entries == snapshot_crash_after_entries) {
        writer_flush(writer);
        fprintf(stderr, "snapshot: injected crash after %zu entries (temporary file left incomplete)\n",
                snapshot_crash_after_entries);
        fflush(stderr);
        _Exit(3);
    }
    return writer->ok;
}

/*
 * 정의 : 저장소의 지금 상태를 스냅샷 파일로 저장하는 함수(SAVE).
 * 설명 : 단일 스레드에서 바로 쓰므로 저장하는 동안 다른 명령은 실행되지 않는다(그만큼 응답이 멈춘다). 만료된 항목은 쓰지 않는다. 새 파일을 끝까지 쓰고 fsync 한 다음에만 원래 파일과 바꾼다.
 * 입력 : store : 저장소, path : 스냅샷 경로, now_ms/unix_ms : 지금 시각, saved : 쓴 항목 수, error/error_size : 실패 이유를 받을 곳
 * 출력 : 성공하면 true. 실패하면 false 이고 원래 경로의 파일은 바뀌지 않는다.
 * 동작 :
 *   1. "경로.tmp" 를 새로 만든다.
 *   2. 머리(MRSNAP01, 저장 시각), 항목들, 끝 표시('Z', 항목 수), 체크섬을 쓴다.
 *   3. fsync 하고 닫는다.
 *   4. 임시 파일을 원래 경로로 교체한다. 중간에 실패하면 임시 파일을 지운다.
 */
bool snapshot_save(const Store *store, const char *path, uint64_t now_ms, uint64_t unix_ms,
                   size_t *saved, char *error, size_t error_size) {
    char temporary[1024];
    if (snprintf(temporary, sizeof(temporary), "%s.tmp", path) >= (int)sizeof(temporary)) {
        snprintf(error, error_size, "snapshot path too long");
        return false;
    }
    SnapshotWriter *writer = malloc(sizeof(*writer));
    if (!writer) {
        snprintf(error, error_size, "out of memory");
        return false;
    }
    *writer = (SnapshotWriter){.checksum = UINT64_C(14695981039346656037), .now_ms = now_ms, .unix_ms = unix_ms, .ok = true};
    writer->fd = open_file(temporary, false);
    if (writer->fd < 0) {
        snprintf(error, error_size, "cannot create %s: %s", temporary, strerror(errno));
        free(writer);
        return false;
    }
    writer_put(writer, SNAPSHOT_MAGIC, sizeof(SNAPSHOT_MAGIC));
    writer_put_uint(writer, unix_ms, 8);
    store_foreach(store, now_ms, write_entry, writer);
    writer_put(writer, "Z", 1);
    writer_put_uint(writer, writer->entries, 8);
    uint64_t checksum = writer->checksum;
    writer_put_uint(writer, checksum, 8);
    writer_flush(writer);
    bool ok = writer->ok && sync_file(writer->fd);
    ok = close_file(writer->fd) && ok;
    if (ok && !replace_file(temporary, path)) {
        ok = false;
    }
    if (!ok) {
        snprintf(error, error_size, "write, fsync or rename of %s failed", temporary);
        remove(temporary);
    } else if (saved) {
        *saved = (size_t)writer->entries;
    }
    free(writer);
    return ok;
}

/*
 * 정의 : 리틀 엔디언 정수를 읽는 함수.
 * 설명 : 남은 바이트가 모자라면 실패로 알려 잘린 파일을 거른다.
 * 입력 : data/length : 파일 전체, offset : 읽을 위치(읽은 만큼 전진), bytes : 4 또는 8, value : 결과
 * 출력 : 읽었으면 true
 * 동작 :
 *   1. 남은 길이를 확인한다.
 *   2. 아래 바이트부터 모아 정수로 만든다.
 */
static bool read_uint(const char *data, size_t length, size_t *offset, size_t bytes, uint64_t *value) {
    if (length - *offset < bytes) {
        return false;
    }
    *value = 0;
    for (size_t i = 0; i < bytes; ++i) {
        *value |= (uint64_t)(unsigned char)data[*offset + i] << (8 * i);
    }
    *offset += bytes;
    return true;
}

/*
 * 정의 : 스냅샷 파일을 읽어 저장소를 채우는 함수.
 * 설명 : 체크섬까지 맞는 완성본만 받아들인다. 깨진 파일로 일부만 채운 채 시작하면 사용자는 데이터가 사라진 줄 모르기 때문에 시작을 거부한다. 서버가 꺼져 있는 동안 만료된 항목은 넣지 않는다. 남은 임시 파일(.tmp)은 읽지 않는다.
 * 입력 : store : 빈 저장소, path : 스냅샷 경로, now_ms/unix_ms : 지금 시각, report : 결과
 * 출력 : 성공하거나 파일이 없으면 true, 형식 · 체크섬 오류나 메모리 부족이면 false(report->error)
 * 동작 :
 *   1. 파일을 읽는다. 없으면 빈 상태로 true.
 *   2. 길이와 머리, 맨 끝 체크섬을 확인한다.
 *   3. 'E' 항목마다 만료 시각을 바꾸고, 살아 있으면 store_set 한다.
 *   4. 'Z' 뒤 항목 수가 읽은 수와 같고 그 뒤가 정확히 체크섬이면 성공.
 */
bool snapshot_load(Store *store, const char *path, uint64_t now_ms, uint64_t unix_ms, LoadReport *report) {
    *report = (LoadReport){0};
    char *data;
    size_t length;
    bool exists;
    if (!read_file(path, &data, &length, &exists)) {
        snprintf(report->error, sizeof(report->error), "cannot read %s", path);
        return false;
    }
    if (!exists) {
        return true;
    }
    bool ok = false;
    size_t offset = sizeof(SNAPSHOT_MAGIC) + 8;
    uint64_t entries = 0;
    uint64_t stored;
    if (length < offset + 1 + 8 + 8 || memcmp(data, SNAPSHOT_MAGIC, sizeof(SNAPSHOT_MAGIC)) != 0) {
        snprintf(report->error, sizeof(report->error), "%s is not a complete snapshot", path);
        goto done;
    }
    size_t checksum_at = length - 8;
    size_t at = checksum_at;
    if (!read_uint(data, length, &at, 8, &stored) ||
        stored != checksum_update(UINT64_C(14695981039346656037), data, checksum_at)) {
        snprintf(report->error, sizeof(report->error), "%s checksum mismatch (truncated or modified)", path);
        goto done;
    }
    while (offset < checksum_at && data[offset] == 'E') {
        ++offset;
        uint64_t unix_deadline, key_length, value_length, deadline_ms;
        if (!read_uint(data, checksum_at, &offset, 8, &unix_deadline) ||
            !read_uint(data, checksum_at, &offset, 4, &key_length) ||
            !read_uint(data, checksum_at, &offset, 4, &value_length) ||
            checksum_at - offset < key_length + value_length) {
            snprintf(report->error, sizeof(report->error), "%s has a malformed entry", path);
            goto done;
        }
        Bytes key = {data + offset, (size_t)key_length};
        Bytes value = {data + offset + key_length, (size_t)value_length};
        offset += (size_t)(key_length + value_length);
        ++entries;
        if (!to_monotonic(unix_deadline, now_ms, unix_ms, &deadline_ms)) {
            ++report->skipped_expired;
            continue;
        }
        if (!store_set(store, key, value, deadline_ms)) {
            snprintf(report->error, sizeof(report->error), "out of memory while loading %s", path);
            goto done;
        }
        ++report->loaded;
    }
    uint64_t declared;
    if (offset >= checksum_at || data[offset++] != 'Z' || !read_uint(data, checksum_at, &offset, 8, &declared) ||
        declared != entries || offset != checksum_at) {
        snprintf(report->error, sizeof(report->error), "%s has an invalid trailer", path);
        goto done;
    }
    ok = true;
done:
    free(data);
    return ok;
}

/* ───────── AOF ───────── */

/*
 * 정의 : 한 레코드를 재생해 저장소에 반영하는 함수.
 * 설명 : AOF 의 만료 시각은 절대 Unix ms 라서 서버가 꺼져 있던 시간이 TTL 에 포함된다. 이미 지난 만료 시각을 가진 SET 은 "덮어쓴 뒤 만료" 이므로 키를 지운 결과가 맞다.
 * 입력 : store : 저장소, args/count : 레코드 인자, now_ms/unix_ms : 지금 시각, report : 결과
 * 출력 : 알 수 있는 레코드면 true, 모르는 형식이면 false
 * 동작 :
 *   1. SET key value [PXAT t] : t 가 지났으면 키 삭제, 아니면 store_set.
 *   2. DEL key : store_delete.
 *   3. PEXPIREAT key t : t 가 지났으면 키 삭제, 아니면 store_expire_at.
 */
static bool replay_record(Store *store, const Bytes *args, size_t count, uint64_t now_ms, uint64_t unix_ms,
                          LoadReport *report) {
    int64_t unix_deadline = 0;
    uint64_t deadline_ms = 0;
    if (resp_equals(args[0], "SET") && (count == 3 || count == 5)) {
        if (count == 5 && (!resp_equals(args[3], "PXAT") || !resp_integer(args[4], &unix_deadline) || unix_deadline <= 0)) {
            return false;
        }
        if (!to_monotonic((uint64_t)unix_deadline, now_ms, unix_ms, &deadline_ms)) {
            store_delete(store, args[1], now_ms);
            ++report->skipped_expired;
            return true;
        }
        return store_set(store, args[1], args[2], deadline_ms);
    }
    if (resp_equals(args[0], "DEL") && count == 2) {
        store_delete(store, args[1], now_ms);
        return true;
    }
    if (resp_equals(args[0], "PEXPIREAT") && count == 3 && resp_integer(args[2], &unix_deadline) && unix_deadline > 0) {
        if (!to_monotonic((uint64_t)unix_deadline, now_ms, unix_ms, &deadline_ms)) {
            store_delete(store, args[1], now_ms);
            ++report->skipped_expired;
            return true;
        }
        store_expire_at(store, args[1], now_ms, deadline_ms);
        return true;
    }
    return false;
}

/*
 * 정의 : AOF 를 열고, 있던 레코드를 재생해 저장소를 채우는 함수.
 * 설명 : 시작할 때 한 번 부른다. 마지막 레코드가 쓰는 도중 끊겼으면(RESP_INCOMPLETE) 그 부분만 잘라 내고 계속한다. 그 레코드는 응답을 받지 못한 명령이라 버려도 클라이언트에게 성공이라고 알린 데이터를 잃지 않는다(always 정책 기준). 중간 레코드가 깨졌으면 시작을 거부한다.
 * 입력 : aof : 채울 AOF 상태, path : 경로, policy : 동기화 정책, store : 빈 저장소, now_ms/unix_ms : 지금 시각, report : 결과
 * 출력 : 성공하면 true(aof->fd 가 열림), 실패하면 false(report->error)
 * 동작 :
 *   1. 파일 전체를 읽는다.
 *   2. resp_parse 로 레코드를 하나씩 꺼내 replay_record 한다.
 *   3. 끝에서 INCOMPLETE 면 그 위치를 온전한 끝으로 기억하고, INVALID 이거나 모르는 레코드면 실패.
 *   4. 파일을 덧붙이기 모드로 열고, 잘라 낼 바이트가 있으면 온전한 끝까지 자른 뒤 fsync 한다.
 */
bool aof_open(Aof *aof, const char *path, FsyncPolicy policy, Store *store,
              uint64_t now_ms, uint64_t unix_ms, LoadReport *report) {
    uint64_t fail_at = aof->fail_at;
    *aof = (Aof){.fd = -1, .policy = policy, .last_sync_ms = now_ms, .fail_at = fail_at};
    *report = (LoadReport){0};
    char *data;
    size_t length;
    bool exists;
    if (!read_file(path, &data, &length, &exists)) {
        snprintf(report->error, sizeof(report->error), "cannot read %s", path);
        return false;
    }
    size_t offset = 0;
    bool ok = true;
    while (offset < length) {
        RespParser parser = {0};
        RespResult result = resp_parse(&parser, data + offset, length - offset);
        if (result == RESP_INCOMPLETE) {
            report->truncated_bytes = length - offset;
            break;
        }
        Bytes args[RESP_MAX_ARGS];
        for (size_t i = 0; i < parser.count && result == RESP_READY; ++i) {
            args[i] = (Bytes){data + offset + parser.start[i], parser.length[i]};
        }
        if (result != RESP_READY || !replay_record(store, args, parser.count, now_ms, unix_ms, report)) {
            snprintf(report->error, sizeof(report->error), "%s has a corrupt record at byte %zu", path, offset);
            ok = false;
            break;
        }
        ++report->loaded;
        offset += parser.offset;
    }
    free(data);
    if (!ok) {
        return false;
    }
    aof->fd = open_file(path, true);
    if (aof->fd < 0) {
        snprintf(report->error, sizeof(report->error), "cannot open %s: %s", path, strerror(errno));
        return false;
    }
    if (report->truncated_bytes && !(truncate_file(aof->fd, offset) && sync_file(aof->fd))) {
        snprintf(report->error, sizeof(report->error), "cannot truncate incomplete tail of %s", path);
        aof_close(aof);
        return false;
    }
    return true;
}

/*
 * 정의 : 바이트 조각을 늘어나는 버퍼 끝에 덧붙이는 함수.
 * 설명 : AOF 레코드를 한 덩어리로 만든 뒤 write 한 번에 쓰기 위해 모은다(레코드가 여러 write 로 쪼개지면 중간 실패 때 끝이 더 많이 깨진다).
 * 입력 : buffer/used/capacity : 레코드 버퍼(필요하면 두 배로 늘림), data/length : 덧붙일 바이트
 * 출력 : 성공하면 true, 메모리 부족이면 false
 * 동작 :
 *   1. 필요한 크기가 될 때까지 용량을 두 배로 늘려 realloc 한다.
 *   2. 끝에 복사한다.
 */
static bool append_raw(char **buffer, size_t *used, size_t *capacity, const char *data, size_t length) {
    size_t need = *used + length;
    if (need > *capacity) {
        size_t grown = *capacity ? *capacity : 256;
        while (grown < need) {
            grown *= 2;
        }
        char *bigger = realloc(*buffer, grown);
        if (!bigger) {
            return false;
        }
        *buffer = bigger;
        *capacity = grown;
    }
    memcpy(*buffer + *used, data, length);
    *used = need;
    return true;
}

/*
 * 정의 : RESP bulk string 하나("$길이\r\n본문\r\n")를 버퍼에 덧붙이는 함수.
 * 설명 : AOF 레코드를 요청과 같은 RESP2 배열로 만들 때 인자마다 부른다. 재생할 때 같은 resp_parse 로 읽을 수 있다.
 * 입력 : buffer/used/capacity : 레코드 버퍼, data/length : 인자
 * 출력 : 성공하면 true
 * 동작 :
 *   1. 길이 머리, 본문, CRLF 를 차례로 append_raw 한다.
 */
static bool append_bulk(char **buffer, size_t *used, size_t *capacity, const char *data, size_t length) {
    char header[32];
    int header_length = snprintf(header, sizeof(header), "$%zu\r\n", length);
    return append_raw(buffer, used, capacity, header, (size_t)header_length) &&
           append_raw(buffer, used, capacity, data, length) && append_raw(buffer, used, capacity, "\r\n", 2);
}

/*
 * 정의 : 상태를 바꾼 연산 하나를 AOF 끝에 덧붙이는 함수.
 * 설명 : 명령이 실행된 직후, 응답을 출력 버퍼에 넣기 전에 부른다. 그래서 always 정책에서는 "+OK 를 받은 쓰기는 디스크에 있다" 가 성립한다. 만료 시각은 Unix ms 로 바꿔 PXAT/PEXPIREAT 로 쓴다.
 * 입력 : aof : 열린 AOF, change : 바뀐 내용, now_ms/unix_ms : 이 명령의 시각, result : 쓴 바이트와 fsync 여부
 * 출력 : 성공하면 true. 실패하면 false 이고 aof->error 에 이유가 있다(호출자는 응답하지 않고 서버를 멈춘다).
 * 동작 :
 *   1. 변경 종류에 따라 SET/DEL/PEXPIREAT 인자를 RESP 배열로 만든다.
 *   2. 시험용 장애 주입 번호면 쓰지 않고 실패한다.
 *   3. write_all 로 덧붙인다.
 *   4. always 면 바로 fsync, 아니면 pending_sync 만 켠다.
 */
bool aof_append(Aof *aof, const Change *change, uint64_t now_ms, uint64_t unix_ms, AofWrite *result) {
    *result = (AofWrite){0};
    char number[32];
    Bytes args[5];
    size_t count = 0;
    if (change->type == CHANGE_SET) {
        args[count++] = (Bytes){"SET", 3};
        args[count++] = change->key;
        args[count++] = change->value;
        if (change->deadline_ms) {
            int n = snprintf(number, sizeof(number), "%llu",
                             (unsigned long long)to_unix(change->deadline_ms, now_ms, unix_ms));
            args[count++] = (Bytes){"PXAT", 4};
            args[count++] = (Bytes){number, (size_t)n};
        }
    } else if (change->type == CHANGE_DEL) {
        args[count++] = (Bytes){"DEL", 3};
        args[count++] = change->key;
    } else {
        int n = snprintf(number, sizeof(number), "%llu",
                         (unsigned long long)to_unix(change->deadline_ms, now_ms, unix_ms));
        args[count++] = (Bytes){"PEXPIREAT", 9};
        args[count++] = change->key;
        args[count++] = (Bytes){number, (size_t)n};
    }

    char *buffer = NULL;
    size_t used = 0, capacity = 0;
    char header[16];
    int header_length = snprintf(header, sizeof(header), "*%zu\r\n", count);
    bool ok = append_raw(&buffer, &used, &capacity, header, (size_t)header_length);
    for (size_t i = 0; ok && i < count; ++i) {
        ok = append_bulk(&buffer, &used, &capacity, args[i].data, args[i].length);
    }
    if (!ok) {
        free(buffer);
        snprintf(aof->error, sizeof(aof->error), "out of memory building AOF record");
        return false;
    }
    ++aof->appended;
    if (aof->fail_at && aof->appended == aof->fail_at) {
        free(buffer);
        snprintf(aof->error, sizeof(aof->error), "injected write failure on record %llu",
                 (unsigned long long)aof->appended);
        return false;
    }
    ok = write_all(aof->fd, buffer, used);
    free(buffer);
    if (!ok) {
        snprintf(aof->error, sizeof(aof->error), "write failed: %s", strerror(errno));
        return false;
    }
    result->bytes = used;
    if (aof->policy == FSYNC_ALWAYS) {
        if (!sync_file(aof->fd)) {
            snprintf(aof->error, sizeof(aof->error), "fsync failed: %s", strerror(errno));
            return false;
        }
        aof->last_sync_ms = now_ms;
        result->synced = true;
    } else {
        aof->pending_sync = true;
    }
    return true;
}

/*
 * 정의 : everysec 정책에서 1초가 지났으면 fsync 하는 함수.
 * 설명 : 이벤트 루프가 반복마다 부른다. write 는 이미 끝났으므로 프로세스가 죽어도 운영체제가 가진 데이터는 남는다. fsync 는 운영체제 · 전원 장애에서 잃을 수 있는 범위를 약 1초로 묶는다.
 * 입력 : aof : 열린 AOF, now_ms : 지금 시각, synced : 이번에 fsync 했는지
 * 출력 : 실패가 없으면 true, fsync 실패면 false(aof->error)
 * 동작 :
 *   1. everysec 이 아니거나 밀린 데이터가 없거나 1초가 안 됐으면 아무것도 하지 않는다.
 *   2. fsync 하고 시각을 기록한다.
 */
bool aof_sync_if_due(Aof *aof, uint64_t now_ms, bool *synced) {
    *synced = false;
    if (aof->fd < 0 || aof->policy != FSYNC_EVERYSEC || !aof->pending_sync || now_ms - aof->last_sync_ms < 1000) {
        return true;
    }
    if (!sync_file(aof->fd)) {
        snprintf(aof->error, sizeof(aof->error), "fsync failed: %s", strerror(errno));
        return false;
    }
    aof->pending_sync = false;
    aof->last_sync_ms = now_ms;
    *synced = true;
    return true;
}

/*
 * 정의 : AOF 를 닫는 함수(정상 종료).
 * 설명 : 밀린 데이터가 있으면 마지막으로 fsync 한다.
 * 입력 : aof : 닫을 AOF
 * 출력 : 없음
 * 동작 :
 *   1. 열려 있으면 fsync 하고 닫는다.
 */
void aof_close(Aof *aof) {
    if (aof->fd >= 0) {
        sync_file(aof->fd);
        close_file(aof->fd);
        aof->fd = -1;
    }
}

/*
 * 정의 : 명령줄의 동기화 정책 이름을 값으로 바꾸는 함수.
 * 설명 : --appendfsync always|everysec|no 를 해석한다(Redis 와 같은 이름).
 * 입력 : text : 이름, policy : 결과
 * 출력 : 아는 이름이면 true
 * 동작 :
 *   1. 세 이름과 비교한다.
 */
bool persist_parse_policy(const char *text, FsyncPolicy *policy) {
    static const char *names[] = {"always", "everysec", "no"};
    for (int i = 0; i < 3; ++i) {
        if (strcmp(text, names[i]) == 0) {
            *policy = (FsyncPolicy)i;
            return true;
        }
    }
    return false;
}

/*
 * 정의 : 동기화 정책 값을 이름으로 바꾸는 함수.
 * 설명 : 로그에 실제로 쓴 정책을 남긴다.
 * 입력 : policy : 정책
 * 출력 : "always", "everysec", "no"
 * 동작 :
 *   1. 표에서 꺼낸다.
 */
const char *persist_policy_name(FsyncPolicy policy) {
    static const char *names[] = {"always", "everysec", "no"};
    return names[policy];
}
