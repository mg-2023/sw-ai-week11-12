/*
 * persist.c : RDB 방식의 스냅샷과 AOF 파일 쓰기 · 읽기.
 *   스냅샷(리틀 엔디언) : "MRSNAP01" | 저장 시각 u64 | { 'E' 만료 u64 | 키 길이 u32 | 값 길이 u32 | 키 | 값 }*
 *                         | 'Z' 항목 수 u64 | 앞 바이트 전체의 FNV-1a 64 체크섬 u64
 *   AOF : 요청과 같은 RESP2 배열. SET key value [PXAT unix_ms] | DEL key | PEXPIREAT key unix_ms
 *   만료 시각은 Unix ms 절대 시각으로 쓴다(단조 시계는 재시작하면 기준점이 바뀐다).
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

/* Windows 는 바이너리 모드를 지정해야 CRLF 변환이 일어나지 않는다. */
static int open_file(const char *path, bool append) {
#ifdef _WIN32
    int flags = _O_BINARY | _O_CREAT | (append ? (_O_RDWR | _O_APPEND) : (_O_WRONLY | _O_TRUNC));
    return _open(path, flags, _S_IREAD | _S_IWRITE);
#else
    int flags = O_CREAT | (append ? (O_RDWR | O_APPEND) : (O_WRONLY | O_TRUNC));
    return open(path, flags, 0644);
#endif
}

static bool close_file(int fd) {
#ifdef _WIN32
    return _close(fd) == 0;
#else
    return close(fd) == 0;
#endif
}

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

static bool sync_file(int fd) {
#ifdef _WIN32
    return _commit(fd) == 0;
#else
    return fsync(fd) == 0;
#endif
}

/* 불완전한 끝을 잘라 두지 않으면 새 레코드가 깨진 바이트 뒤에 붙어 다음 재시작에서 중간 손상이 된다. */
static bool truncate_file(int fd, size_t length) {
#ifdef _WIN32
    return _chsize_s(fd, (long long)length) == 0;
#else
    return ftruncate(fd, (off_t)length) == 0;
#endif
}

/* 다 쓴 임시 파일로 교체하면 원래 경로에는 옛 완성본 아니면 새 완성본만 있다. */
static bool replace_file(const char *from, const char *to) {
#ifdef _WIN32
    return MoveFileExA(from, to, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
#else
    return rename(from, to) == 0;
#endif
}

/* 파일이 없으면 오류가 아니라 비어 있음(첫 실행)으로 본다. */
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

static uint64_t to_unix(uint64_t deadline_ms, uint64_t now_ms, uint64_t unix_ms) {
    if (!deadline_ms) {
        return 0;
    }
    return deadline_ms <= now_ms ? unix_ms : unix_ms + (deadline_ms - now_ms);
}

/* 서버가 꺼져 있던 시간도 TTL 에서 빠지게 Unix 시각끼리 비교한다. TTL 이 처음부터 다시 시작되지 않는다. */
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

static uint64_t checksum_update(uint64_t hash, const char *data, size_t length) {
    for (size_t i = 0; i < length; ++i) {
        hash ^= (unsigned char)data[i];
        hash *= UINT64_C(1099511628211);
    }
    return hash;
}

static void writer_flush(SnapshotWriter *writer) {
    if (writer->used && writer->ok) {
        writer->ok = write_all(writer->fd, writer->buffer, writer->used);
    }
    writer->used = 0;
}

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

static void writer_put_uint(SnapshotWriter *writer, uint64_t value, size_t bytes) {
    unsigned char encoded[8];
    for (size_t i = 0; i < bytes; ++i) {
        encoded[i] = (unsigned char)(value >> (8 * i));
    }
    writer_put(writer, encoded, bytes);
}

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
 * 원래 파일에 바로 덮어쓰면 쓰는 도중 멈췄을 때 마지막 완성본까지 잃는다.
 * 그래서 .tmp 에 끝까지 쓰고 fsync 한 뒤에만 교체한다. 단일 스레드라 저장하는 동안 다른 명령은 멈춘다.
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

/* 체크섬까지 맞는 완성본만 받는다 : 깨진 파일로 일부만 채운 채 시작하면 데이터가 사라진 줄 모른다. */
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

/* 재생 중 지난 만료 시각을 나타내는 값. 0 은 TTL 없음이라 쓸 수 없다. */
enum { REPLAYED_PAST_DEADLINE = 1 };

/*
 * 기록을 순서대로 모두 적용한다. 지난 만료 시각도 키를 지우지 않고 "이미 지난 시각"으로만 저장한다 :
 * 뒤에 오는 PEXPIREAT 나 SET 이 그 TTL 을 늘리거나 없앨 수 있기 때문이다. 만료된 키는 재생이 끝난 뒤 한꺼번에 지운다.
 * 저장소 호출에 now 로 0 을 넘겨 재생 중에는 만료 판단이 일어나지 않게 한다(store_expire_at 은 deadline <= now 일 때만 지운다).
 */
static bool replay_record(Store *store, const Bytes *args, size_t count, uint64_t now_ms, uint64_t unix_ms) {
    int64_t unix_deadline = 0;
    uint64_t deadline_ms = 0;
    if (resp_equals(args[0], "SET") && (count == 3 || count == 5)) {
        if (count == 5 && (!resp_equals(args[3], "PXAT") || !resp_integer(args[4], &unix_deadline) || unix_deadline <= 0)) {
            return false;
        }
        if (!to_monotonic((uint64_t)unix_deadline, now_ms, unix_ms, &deadline_ms)) {
            deadline_ms = REPLAYED_PAST_DEADLINE;
        }
        return store_set(store, args[1], args[2], deadline_ms);
    }
    if (resp_equals(args[0], "DEL") && count == 2) {
        store_delete(store, args[1], 0);
        return true;
    }
    if (resp_equals(args[0], "PEXPIREAT") && count == 3 && resp_integer(args[2], &unix_deadline) && unix_deadline > 0) {
        if (!to_monotonic((uint64_t)unix_deadline, now_ms, unix_ms, &deadline_ms)) {
            deadline_ms = REPLAYED_PAST_DEADLINE;
        }
        store_expire_at(store, args[1], 0, deadline_ms);
        return true;
    }
    return false;
}

static bool append_raw(char **buffer, size_t *used, size_t *capacity, const char *data, size_t length);

/* 만료 시각이 now_ms 이하인 키의 이름을 길이와 함께 한 덩어리에 모으는 상태 */
typedef struct {
    char *data;
    size_t used;
    size_t capacity;
    size_t keys;
    uint64_t now_ms;
    bool ok;
} ExpiredKeys;

static bool collect_expired(void *context, Bytes key, Bytes value, uint64_t deadline_ms) {
    ExpiredKeys *found = context;
    (void)value;
    if (!deadline_ms || deadline_ms > found->now_ms) {
        return true;
    }
    if (!append_raw(&found->data, &found->used, &found->capacity, (const char *)&key.length, sizeof key.length) ||
        !append_raw(&found->data, &found->used, &found->capacity, key.data, key.length)) {
        found->ok = false;
        return false;
    }
    ++found->keys;
    return true;
}

/* 재생이 끝난 뒤 만료 시각이 지난 키를 지우고 그 수를 센다. 순회 중에는 지우지 않고 이름을 복사해 둔 뒤 지운다. */
static bool drop_expired_after_replay(Store *store, uint64_t now_ms, LoadReport *report) {
    ExpiredKeys found = {.now_ms = now_ms, .ok = true};
    store_foreach(store, 0, collect_expired, &found);
    size_t offset = 0;
    for (size_t i = 0; found.ok && i < found.keys; ++i) {
        size_t length;
        memcpy(&length, found.data + offset, sizeof length);
        offset += sizeof length;
        if (store_delete(store, (Bytes){found.data + offset, length}, 0)) {
            ++report->skipped_expired;
        }
        offset += length;
    }
    free(found.data);
    return found.ok;
}

/*
 * 끝의 불완전한 레코드(RESP_INCOMPLETE)만 잘라 내고 계속한다. 그 레코드는 응답을 받지 못한 명령이라
 * always 기준으로 성공을 알린 데이터를 잃지 않는다. 중간이 깨졌으면 시작을 거부한다.
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
        if (result != RESP_READY || !replay_record(store, args, parser.count, now_ms, unix_ms)) {
            snprintf(report->error, sizeof(report->error), "%s has a corrupt record at byte %zu", path, offset);
            ok = false;
            break;
        }
        ++report->loaded;
        offset += parser.offset;
    }
    free(data);
    if (ok && !drop_expired_after_replay(store, now_ms, report)) {
        snprintf(report->error, sizeof(report->error), "out of memory dropping expired keys of %s", path);
        ok = false;
    }
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

static bool append_bulk(char **buffer, size_t *used, size_t *capacity, const char *data, size_t length) {
    char header[32];
    int header_length = snprintf(header, sizeof(header), "$%zu\r\n", length);
    return append_raw(buffer, used, capacity, header, (size_t)header_length) &&
           append_raw(buffer, used, capacity, data, length) && append_raw(buffer, used, capacity, "\r\n", 2);
}

/*
 * 명령 실행 직후 · 응답 전에 부른다. 레코드를 한 버퍼에 모아 write 한 번으로 써서 중간 실패 때 끝이 덜 깨지게 한다.
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

/* write 는 이미 끝났으므로 프로세스가 죽어도 운영체제가 가진 데이터는 남는다. fsync 는 전원 장애 손실을 약 1초로 묶는다. */
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

void aof_close(Aof *aof) {
    if (aof->fd >= 0) {
        sync_file(aof->fd);
        close_file(aof->fd);
        aof->fd = -1;
    }
}

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

const char *persist_policy_name(FsyncPolicy policy) {
    static const char *names[] = {"always", "everysec", "no"};
    return names[policy];
}
