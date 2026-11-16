/*
 * test_persist.c
 *
 * 스냅샷 단위 시험. 시각(단조 ms, Unix ms)을 직접 넘겨 "서버가 꺼져 있던 시간" 을 정확히 만든다.
 * 파일은 현재 폴더에 test-persist-*.tmpdata 이름으로 만들고 끝나면 지운다.
 */

#include "persist.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

#define BYTES(literal) ((Bytes){literal, sizeof(literal) - 1})

static const char SNAP[] = "test-persist-snapshot.tmpdata";
static const char SNAP_TMP[] = "test-persist-snapshot.tmpdata.tmp";

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

int main(void) {
    test_snapshot_round_trip_with_downtime();
    test_snapshot_interrupted_and_corrupt();
    remove(SNAP);
    remove(SNAP_TMP);
    puts("2 persistence unit scenarios passed");
    return 0;
}
