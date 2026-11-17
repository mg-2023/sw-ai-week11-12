/*
 * test_persist.c
 *
 * 스냅샷 · AOF 단위 시험. 시각(단조 ms, Unix ms)을 직접 넘겨 "서버가 꺼져 있던 시간" 을 정확히 만든다.
 * 파일은 현재 폴더에 test-persist-*.tmpdata 이름으로 만들고 끝나면 지운다.
 */

#include "persist.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

#define BYTES(literal) ((Bytes){literal, sizeof(literal) - 1})

static const char SNAP[] = "test-persist-snapshot.tmpdata";
static const char SNAP_TMP[] = "test-persist-snapshot.tmpdata.tmp";
static const char AOF[] = "test-persist-aof.tmpdata";

/* 첫 실행의 시각과, 3초 꺼져 있다가 재시작한 뒤의 시각. 단조 시계는 재시작하면 작은 값부터 다시 센다. */
enum { RUN1_MONO = 500000, RUN2_MONO = 1000 };
static const uint64_t RUN1_UNIX = UINT64_C(1700000000000);
static const uint64_t RUN2_UNIX = UINT64_C(1700000003000);

static void expect_value(Store *store, Bytes key, uint64_t now, const char *expected) {
    Bytes value;
    assert(store_get(store, key, now, &value));
    assert(value.length == strlen(expected) && memcmp(value.data, expected, value.length) == 0);
}

static void write_bytes(const char *path, const char *mode, const char *data, size_t length) {
    FILE *file = fopen(path, mode);
    assert(file && fwrite(data, 1, length, file) == length);
    fclose(file);
}

static long file_size(const char *path) {
    FILE *file = fopen(path, "rb");
    assert(file);
    fseek(file, 0, SEEK_END);
    long size = ftell(file);
    fclose(file);
    return size;
}

/* 스냅샷 : 값 · TTL 을 저장하고, 꺼져 있던 3초를 반영해 복원한다 */
static void test_snapshot_round_trip_with_downtime(void) {
    remove(SNAP);
    Store store;
    assert(store_init(&store));
    assert(store_set(&store, BYTES("plain"), BYTES("v1"), 0));
    assert(store_set(&store, BYTES("bin\0key"), BYTES("a\r\nb"), 0));
    assert(store_set(&store, BYTES("short"), BYTES("s"), RUN1_MONO + 2000));  /* 꺼져 있는 동안 만료 */
    assert(store_set(&store, BYTES("long"), BYTES("l"), RUN1_MONO + 10000));  /* 7초 남아야 한다 */
    assert(store_set(&store, BYTES("gone"), BYTES("g"), RUN1_MONO - 1));      /* 저장 시점에 이미 만료 */
    size_t saved = 0;
    char error[192];
    assert(snapshot_save(&store, SNAP, RUN1_MONO, RUN1_UNIX, &saved, error, sizeof(error)));
    assert(saved == 4);
    store_destroy(&store);

    LoadReport report;
    assert(store_init(&store));
    assert(snapshot_load(&store, SNAP, RUN2_MONO, RUN2_UNIX, &report));
    assert(report.loaded == 3 && report.skipped_expired == 1);
    expect_value(&store, BYTES("plain"), RUN2_MONO, "v1");
    expect_value(&store, BYTES("bin\0key"), RUN2_MONO, "a\r\nb");
    assert(store_pttl(&store, BYTES("short"), RUN2_MONO) == -2);
    assert(store_pttl(&store, BYTES("long"), RUN2_MONO) == 7000);
    assert(store_pttl(&store, BYTES("plain"), RUN2_MONO) == -1);
    store_destroy(&store);
}

/* 스냅샷 : 새 저장이 임시 파일에서 멈추면 마지막 완성본을 쓰고, 완성본이 깨졌으면 시작을 거부한다 */
static void test_snapshot_interrupted_and_corrupt(void) {
    Store store;
    LoadReport report;
    char error[192];
    assert(store_init(&store));
    assert(store_set(&store, BYTES("k"), BYTES("v1"), 0));
    assert(snapshot_save(&store, SNAP, RUN1_MONO, RUN1_UNIX, NULL, error, sizeof(error)));
    store_destroy(&store);

    /* 다음 저장이 임시 파일 앞부분만 쓰고 프로세스가 죽은 상태를 만든다 (교체 전) */
    write_bytes(SNAP_TMP, "wb", "MRSNAP01partial", 15);
    assert(store_init(&store));
    assert(snapshot_load(&store, SNAP, RUN2_MONO, RUN2_UNIX, &report));
    expect_value(&store, BYTES("k"), RUN2_MONO, "v1");
    store_destroy(&store);
    remove(SNAP_TMP);

    /* 완성본 마지막 바이트를 바꾸면 체크섬이 맞지 않아 거부한다 */
    FILE *file = fopen(SNAP, "r+b");
    assert(file);
    fseek(file, -1, SEEK_END);
    int last = fgetc(file);
    fseek(file, -1, SEEK_END);
    fputc(last ^ 0xff, file);
    fclose(file);
    assert(store_init(&store));
    assert(!snapshot_load(&store, SNAP, RUN2_MONO, RUN2_UNIX, &report));
    assert(strstr(report.error, "checksum"));
    store_destroy(&store);

    /* 파일이 없으면 첫 실행으로 보고 빈 저장소로 시작한다 */
    remove(SNAP);
    assert(store_init(&store));
    assert(snapshot_load(&store, SNAP, RUN2_MONO, RUN2_UNIX, &report) && store.size == 0);
    store_destroy(&store);
}

/* AOF 에 Change 하나를 덧붙이는 짧은 도우미 */
static void append(Aof *aof, ChangeType type, Bytes key, Bytes value, uint64_t deadline) {
    Change change = {.type = type, .key = key, .value = value, .deadline_ms = deadline};
    AofWrite written;
    assert(aof_append(aof, &change, RUN1_MONO, RUN1_UNIX, &written));
    assert(written.bytes > 0 && written.synced == (aof->policy == FSYNC_ALWAYS));
}

/* AOF : 저장 · 덮어쓰기 · 삭제 · TTL 변경을 순서대로 재생하고, 꺼져 있던 시간을 TTL 에서 뺀다 */
static void test_aof_replay(void) {
    remove(AOF);
    Store store;
    Aof aof = {0};
    LoadReport report;
    assert(store_init(&store));
    assert(aof_open(&aof, AOF, FSYNC_ALWAYS, &store, RUN1_MONO, RUN1_UNIX, &report) && report.loaded == 0);
    append(&aof, CHANGE_SET, BYTES("user"), BYTES("v1"), 0);
    append(&aof, CHANGE_SET, BYTES("user"), BYTES("v2"), 0);                       /* 덮어쓰기 */
    append(&aof, CHANGE_SET, BYTES("deleted"), BYTES("x"), 0);
    append(&aof, CHANGE_DEL, BYTES("deleted"), (Bytes){0}, 0);                     /* 삭제 */
    append(&aof, CHANGE_SET, BYTES("short"), BYTES("s"), RUN1_MONO + 2000);        /* 꺼져 있는 동안 만료 */
    append(&aof, CHANGE_SET, BYTES("ttl"), BYTES("t"), 0);
    append(&aof, CHANGE_EXPIRE, BYTES("ttl"), (Bytes){0}, RUN1_MONO + 10000);      /* TTL 변경 */
    append(&aof, CHANGE_SET, BYTES("old"), BYTES("o"), RUN1_MONO + 60000);
    append(&aof, CHANGE_SET, BYTES("old"), BYTES("o2"), 0);                        /* TTL 없는 값으로 덮어써 TTL 제거 */
    aof_close(&aof);
    store_destroy(&store);

    assert(store_init(&store));
    assert(aof_open(&aof, AOF, FSYNC_ALWAYS, &store, RUN2_MONO, RUN2_UNIX, &report));
    assert(report.loaded == 9 && report.skipped_expired == 1 && report.truncated_bytes == 0);
    expect_value(&store, BYTES("user"), RUN2_MONO, "v2");
    assert(store_pttl(&store, BYTES("deleted"), RUN2_MONO) == -2);
    assert(store_pttl(&store, BYTES("short"), RUN2_MONO) == -2);
    assert(store_pttl(&store, BYTES("ttl"), RUN2_MONO) == 7000);
    assert(store_pttl(&store, BYTES("old"), RUN2_MONO) == -1);
    aof_close(&aof);
    store_destroy(&store);
}

/* AOF : 마지막 레코드가 쓰다 만 채로 끝나면 그 부분만 잘라 내고, 그 뒤 새 레코드는 온전한 끝에 붙는다 */
static void test_aof_incomplete_tail(void) {
    remove(AOF);
    Store store;
    Aof aof = {0};
    LoadReport report;
    assert(store_init(&store));
    assert(aof_open(&aof, AOF, FSYNC_EVERYSEC, &store, RUN1_MONO, RUN1_UNIX, &report));
    append(&aof, CHANGE_SET, BYTES("a"), BYTES("1"), 0);
    aof_close(&aof);
    store_destroy(&store);
    long complete = file_size(AOF);
    const char torn[] = "*3\r\n$3\r\nSET\r\n$1\r\nb\r\n$5\r\n12"; /* 값 5바이트 중 2바이트만 쓴 상태 */
    write_bytes(AOF, "ab", torn, sizeof(torn) - 1);

    assert(store_init(&store));
    assert(aof_open(&aof, AOF, FSYNC_EVERYSEC, &store, RUN2_MONO, RUN2_UNIX, &report));
    assert(report.loaded == 1 && report.truncated_bytes == sizeof(torn) - 1);
    assert(file_size(AOF) == complete);
    expect_value(&store, BYTES("a"), RUN2_MONO, "1");
    assert(store_pttl(&store, BYTES("b"), RUN2_MONO) == -2);
    append(&aof, CHANGE_SET, BYTES("c"), BYTES("3"), 0);
    aof_close(&aof);
    store_destroy(&store);

    assert(store_init(&store));
    assert(aof_open(&aof, AOF, FSYNC_EVERYSEC, &store, RUN2_MONO, RUN2_UNIX, &report));
    assert(report.loaded == 2 && report.truncated_bytes == 0);
    expect_value(&store, BYTES("c"), RUN2_MONO, "3");
    aof_close(&aof);
    store_destroy(&store);
}

/* AOF : 중간 레코드가 깨졌으면 일부만 복원한 채 시작하지 않고 거부한다 */
static void test_aof_corrupt_middle(void) {
    const char data[] = "*2\r\n$3\r\nDEL\r\n$1\r\na\r\nGARBAGE\r\n*2\r\n$3\r\nDEL\r\n$1\r\nb\r\n";
    write_bytes(AOF, "wb", data, sizeof(data) - 1);
    Store store;
    Aof aof = {0};
    LoadReport report;
    assert(store_init(&store));
    assert(!aof_open(&aof, AOF, FSYNC_ALWAYS, &store, RUN2_MONO, RUN2_UNIX, &report));
    assert(strstr(report.error, "corrupt record"));
    store_destroy(&store);
}

/* AOF : 쓰기 실패(장애 주입)는 false 로 알리고 파일에 아무것도 쓰지 않는다 */
static void test_aof_write_failure(void) {
    remove(AOF);
    Store store;
    Aof aof = {.fail_at = 2};
    LoadReport report;
    assert(store_init(&store));
    assert(aof_open(&aof, AOF, FSYNC_ALWAYS, &store, RUN1_MONO, RUN1_UNIX, &report));
    append(&aof, CHANGE_SET, BYTES("a"), BYTES("1"), 0);
    long before = file_size(AOF);
    Change change = {.type = CHANGE_SET, .key = BYTES("b"), .value = BYTES("2")};
    AofWrite written;
    assert(!aof_append(&aof, &change, RUN1_MONO, RUN1_UNIX, &written));
    assert(strstr(aof.error, "injected"));
    assert(file_size(AOF) == before);
    aof_close(&aof);
    store_destroy(&store);
    remove(AOF);
}

/* 스냅샷 : 키가 0개여도 저장하고 복원한다 */
static void test_snapshot_with_zero_keys(void) {
    remove(SNAP);
    Store store;
    LoadReport report;
    char error[192];
    size_t saved = 99;
    assert(store_init(&store));
    assert(snapshot_save(&store, SNAP, RUN1_MONO, RUN1_UNIX, &saved, error, sizeof(error)));
    assert(saved == 0);
    store_destroy(&store);

    assert(store_init(&store));
    assert(snapshot_load(&store, SNAP, RUN2_MONO, RUN2_UNIX, &report));
    assert(report.loaded == 0 && report.skipped_expired == 0 && store.size == 0);
    assert(store_pttl(&store, BYTES("x"), RUN2_MONO) == -2);
    store_destroy(&store);
    remove(SNAP);
}

/* NUL · CRLF · 빈 문자열이 들어 있는 키와 값 */
#define ODD_COUNT 5
#define INIT(literal) {literal, sizeof(literal) - 1}
static const Bytes ODD_KEYS[ODD_COUNT] = {INIT("\0"), INIT("\r\n"), INIT(""), INIT("k\0\r\n"), INIT("*3\r\n$3\r\nSET\r\n")};
static const Bytes ODD_VALUES[ODD_COUNT] = {INIT(""), INIT("\0\r\n"), INIT("empty key"), INIT("\r\n\r\n"), INIT("\0")};

static void expect_odd_entries(Store *store, uint64_t now) {
    assert(store->size == ODD_COUNT);
    for (int i = 0; i < ODD_COUNT; ++i) {
        Bytes value;
        assert(store_get(store, ODD_KEYS[i], now, &value));
        assert(value.length == ODD_VALUES[i].length && memcmp(value.data, ODD_VALUES[i].data, value.length) == 0);
    }
}

/* 스냅샷 : 키 · 값에 NUL · CRLF · 빈 문자열이 있어도 그대로 복원된다 */
static void test_snapshot_binary_round_trip(void) {
    remove(SNAP);
    Store store;
    LoadReport report;
    char error[192];
    assert(store_init(&store));
    for (int i = 0; i < ODD_COUNT; ++i) {
        assert(store_set(&store, ODD_KEYS[i], ODD_VALUES[i], 0));
    }
    assert(snapshot_save(&store, SNAP, RUN1_MONO, RUN1_UNIX, NULL, error, sizeof(error)));
    store_destroy(&store);

    assert(store_init(&store));
    assert(snapshot_load(&store, SNAP, RUN2_MONO, RUN2_UNIX, &report));
    assert(report.loaded == ODD_COUNT);
    expect_odd_entries(&store, RUN2_MONO);
    store_destroy(&store);
    remove(SNAP);
}

/* AOF : 키 · 값에 NUL · CRLF · 빈 문자열이 있어도 재생하면 그대로다 */
static void test_aof_binary_round_trip(void) {
    remove(AOF);
    Store store;
    Aof aof = {0};
    LoadReport report;
    assert(store_init(&store));
    assert(aof_open(&aof, AOF, FSYNC_NO, &store, RUN1_MONO, RUN1_UNIX, &report));
    for (int i = 0; i < ODD_COUNT; ++i) {
        append(&aof, CHANGE_SET, ODD_KEYS[i], ODD_VALUES[i], 0);
    }
    aof_close(&aof);
    store_destroy(&store);

    assert(store_init(&store));
    assert(aof_open(&aof, AOF, FSYNC_NO, &store, RUN2_MONO, RUN2_UNIX, &report));
    assert(report.loaded == ODD_COUNT && report.truncated_bytes == 0);
    expect_odd_entries(&store, RUN2_MONO);
    append(&aof, CHANGE_DEL, ODD_KEYS[2], (Bytes){0}, 0);
    aof_close(&aof);
    store_destroy(&store);

    assert(store_init(&store));
    assert(aof_open(&aof, AOF, FSYNC_NO, &store, RUN2_MONO, RUN2_UNIX, &report));
    assert(report.loaded == ODD_COUNT + 1 && store.size == ODD_COUNT - 1);
    assert(store_pttl(&store, BYTES(""), RUN2_MONO) == -2);
    aof_close(&aof);
    store_destroy(&store);
    remove(AOF);
}

/* 스냅샷 : 저장 시점에 이미 만료된 키는 다시 켜도 없다 (꺼져 있던 시간이 0 이어도) */
static void test_snapshot_drops_key_expired_at_save(void) {
    remove(SNAP);
    Store store;
    LoadReport report;
    char error[192];
    size_t saved = 0;
    assert(store_init(&store));
    assert(store_set(&store, BYTES("expired"), BYTES("e"), RUN1_MONO));
    assert(store_set(&store, BYTES("older"), BYTES("o"), RUN1_MONO - 500));
    assert(store_set(&store, BYTES("alive"), BYTES("a"), RUN1_MONO + 1));
    assert(snapshot_save(&store, SNAP, RUN1_MONO, RUN1_UNIX, &saved, error, sizeof(error)));
    assert(saved == 1);
    store_destroy(&store);

    assert(store_init(&store));
    assert(snapshot_load(&store, SNAP, RUN1_MONO, RUN1_UNIX, &report));
    assert(report.loaded == 1 && store.size == 1);
    assert(store_pttl(&store, BYTES("expired"), RUN1_MONO) == -2);
    assert(store_pttl(&store, BYTES("older"), RUN1_MONO) == -2);
    expect_value(&store, BYTES("alive"), RUN1_MONO, "a");
    store_destroy(&store);
    remove(SNAP);
}

/* 파일이 없는 경로로 snapshot_load · aof_open 을 부르면 빈 저장소로 성공한다 */
static void test_missing_files_start_empty(void) {
    remove(SNAP);
    remove(AOF);
    Store store;
    LoadReport report;
    Aof aof = {0};
    assert(store_init(&store));
    assert(snapshot_load(&store, SNAP, RUN2_MONO, RUN2_UNIX, &report));
    assert(report.loaded == 0 && report.skipped_expired == 0 && report.error[0] == '\0' && store.size == 0);
    store_destroy(&store);

    assert(store_init(&store));
    assert(aof_open(&aof, AOF, FSYNC_EVERYSEC, &store, RUN2_MONO, RUN2_UNIX, &report));
    assert(report.loaded == 0 && report.truncated_bytes == 0 && report.error[0] == '\0' && store.size == 0);
    append(&aof, CHANGE_SET, BYTES("first"), BYTES("1"), 0);
    aof_close(&aof);
    store_destroy(&store);

    assert(store_init(&store));
    assert(aof_open(&aof, AOF, FSYNC_EVERYSEC, &store, RUN2_MONO, RUN2_UNIX, &report));
    assert(report.loaded == 1);
    expect_value(&store, BYTES("first"), RUN2_MONO, "1");
    aof_close(&aof);
    store_destroy(&store);
    remove(AOF);
}

/* 0바이트짜리 AOF 파일도 빈 저장소로 열리고 이어서 덧붙일 수 있다 */
static void test_empty_aof_file(void) {
    write_bytes(AOF, "wb", "", 0);
    assert(file_size(AOF) == 0);
    Store store;
    Aof aof = {0};
    LoadReport report;
    assert(store_init(&store));
    assert(aof_open(&aof, AOF, FSYNC_ALWAYS, &store, RUN2_MONO, RUN2_UNIX, &report));
    assert(report.loaded == 0 && report.truncated_bytes == 0 && store.size == 0);
    append(&aof, CHANGE_SET, BYTES("k"), BYTES("v"), 0);
    aof_close(&aof);
    store_destroy(&store);

    assert(store_init(&store));
    assert(aof_open(&aof, AOF, FSYNC_ALWAYS, &store, RUN2_MONO, RUN2_UNIX, &report));
    assert(report.loaded == 1);
    expect_value(&store, BYTES("k"), RUN2_MONO, "v");
    aof_close(&aof);
    store_destroy(&store);
    remove(AOF);
}

/* AOF : 꺼져 있던 동안 지난 PEXPIREAT 은 재생하면 그 키를 지운다 */
static void test_aof_expire_record_in_the_past(void) {
    remove(AOF);
    Store store;
    Aof aof = {0};
    LoadReport report;
    assert(store_init(&store));
    assert(aof_open(&aof, AOF, FSYNC_ALWAYS, &store, RUN1_MONO, RUN1_UNIX, &report));
    append(&aof, CHANGE_SET, BYTES("soon"), BYTES("s"), 0);
    append(&aof, CHANGE_EXPIRE, BYTES("soon"), (Bytes){0}, RUN1_MONO + 1000);   /* 1초 뒤 만료, 3초 꺼져 있었다 */
    append(&aof, CHANGE_SET, BYTES("later"), BYTES("l"), 0);
    append(&aof, CHANGE_EXPIRE, BYTES("later"), (Bytes){0}, RUN1_MONO + 9000);  /* 6초 남는다 */
    aof_close(&aof);
    store_destroy(&store);

    assert(store_init(&store));
    assert(aof_open(&aof, AOF, FSYNC_ALWAYS, &store, RUN2_MONO, RUN2_UNIX, &report));
    assert(report.loaded == 4 && report.skipped_expired == 1);
    assert(store_pttl(&store, BYTES("soon"), RUN2_MONO) == -2);
    assert(store_pttl(&store, BYTES("later"), RUN2_MONO) == 6000);
    assert(store.size == 1);
    aof_close(&aof);
    store_destroy(&store);
    remove(AOF);
}

/* aof_close 는 첫 호출에서 fd 를 -1 로 바꾸고, 두 번째 호출은 아무 파일도 건드리지 않는다 */
static void test_aof_close_twice(void) {
    remove(AOF);
    Store store;
    Aof aof = {0};
    LoadReport report;
    assert(store_init(&store));
    assert(aof_open(&aof, AOF, FSYNC_ALWAYS, &store, RUN1_MONO, RUN1_UNIX, &report));
    assert(aof.fd >= 0);
    aof_close(&aof);
    assert(aof.fd == -1);
    /* 닫힌 번호는 곧바로 다른 파일이 가져갈 수 있다. 두 번째 close 가 그 번호를 닫았다면 이 파일 쓰기가 실패한다. */
    FILE *other = fopen("test-persist-other.tmpdata", "wb");
    assert(other);
    aof_close(&aof);
    assert(aof.fd == -1);
    assert(fwrite("still open", 1, 10, other) == 10 && fflush(other) == 0);
    fclose(other);
    assert(file_size("test-persist-other.tmpdata") == 10);
    remove("test-persist-other.tmpdata");
    store_destroy(&store);
    remove(AOF);
}

int main(void) {
    test_snapshot_round_trip_with_downtime();
    test_snapshot_interrupted_and_corrupt();
    test_aof_replay();
    test_aof_incomplete_tail();
    test_aof_corrupt_middle();
    test_aof_write_failure();
    test_snapshot_with_zero_keys();
    test_snapshot_binary_round_trip();
    test_aof_binary_round_trip();
    test_snapshot_drops_key_expired_at_save();
    test_missing_files_start_empty();
    test_empty_aof_file();
    test_aof_expire_record_in_the_past();
    test_aof_close_twice();
    remove(SNAP);
    remove(SNAP_TMP);
    remove(AOF);
    puts("14 persistence unit scenarios passed");
    return 0;
}
