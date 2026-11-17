/*
 * test_commands.c
 *
 * execute_command 를 소켓 없이 직접 부르는 시험. 가짜 record_change · save_snapshot 을 넣어
 * 호출 횟수와 내용을 센다. 기대값은 Redis 와 같은 응답이라는 요구사항과 commands.h 의 계약으로 정했다.
 */

#include "commands.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

enum { MAX_RECORDS = 16, START_MS = 1000 };

/* record_change 로 받은 Change 하나의 복사본 (원본 view 는 호출이 끝나면 무효라 복사해 둔다) */
typedef struct {
    ChangeType type;
    char key[32];
    char value[32];
    uint64_t deadline_ms;
} Recorded;

/* 시험 한 건에 필요한 저장소 · 컨텍스트 · 기록 */
typedef struct {
    Store store;
    CommandContext context;
    Recorded records[MAX_RECORDS];
    size_t record_count;
    int save_calls;
    bool save_result;
} Env;

static void fake_record(void *context, const Change *change) {
    Env *env = context;
    assert(env->record_count < MAX_RECORDS);
    Recorded *slot = &env->records[env->record_count++];
    slot->type = change->type;
    snprintf(slot->key, sizeof slot->key, "%.*s", (int)change->key.length, change->key.data);
    snprintf(slot->value, sizeof slot->value, "%.*s", (int)change->value.length, change->value.data);
    slot->deadline_ms = change->deadline_ms;
}

static bool fake_save(void *context) {
    Env *env = context;
    ++env->save_calls;
    return env->save_result;
}

/* hooks 가 true 면 record_change · save_snapshot 을 모두 채운다. */
static void env_init(Env *env, bool hooks) {
    *env = (Env){.save_result = true};
    assert(store_init(&env->store));
    env->context = (CommandContext){.store = &env->store, .now_ms = START_MS, .hook_context = env};
    if (hooks) {
        env->context.record_change = fake_record;
        env->context.save_snapshot = fake_save;
    }
}

static void env_destroy(Env *env) {
    store_destroy(&env->store);
}

/* 문자열 인자들로 명령 하나를 실행한다. 인자 수는 배열 길이로 센다. */
static Reply run_words(Env *env, const char *const *words, size_t count) {
    Bytes args[8];
    assert(count <= 8);
    for (size_t i = 0; i < count; ++i) {
        args[i] = (Bytes){words[i], strlen(words[i])};
    }
    return execute_command(&env->context, args, count);
}

#define RUN(env, ...) \
    run_words((env), (const char *const[]){__VA_ARGS__}, sizeof((const char *const[]){__VA_ARGS__}) / sizeof(const char *))

static bool is_text(Reply reply, const char *wire) {
    return reply.type == REPLY_TEXT && reply.bytes.length == strlen(wire) &&
           memcmp(reply.bytes.data, wire, reply.bytes.length) == 0;
}

static bool text_starts_with(Reply reply, const char *prefix) {
    return reply.type == REPLY_TEXT && reply.bytes.length >= strlen(prefix) &&
           memcmp(reply.bytes.data, prefix, strlen(prefix)) == 0;
}

static bool is_bulk(Reply reply, const char *body) {
    return reply.type == REPLY_BULK && reply.bytes.length == strlen(body) &&
           memcmp(reply.bytes.data, body, reply.bytes.length) == 0;
}

static bool is_integer(Reply reply, int64_t number) {
    return reply.type == REPLY_INTEGER && reply.number == number;
}

/* 저장소에 key 가 들어 있고 값이 expected 인지 */
static bool holds(Env *env, const char *key, const char *expected) {
    Bytes value;
    return store_get(&env->store, (Bytes){key, strlen(key)}, env->context.now_ms, &value) &&
           value.length == strlen(expected) && memcmp(value.data, expected, value.length) == 0;
}

static bool absent(Env *env, const char *key) {
    Bytes value;
    return !store_get(&env->store, (Bytes){key, strlen(key)}, env->context.now_ms, &value);
}

/* 명령 이름은 대소문자를 가리지 않는다 */
static void test_command_names_ignore_case(void) {
    Env env;
    env_init(&env, true);
    assert(is_text(RUN(&env, "set", "k", "1"), "+OK\r\n"));
    assert(is_bulk(RUN(&env, "Get", "k"), "1"));
    assert(is_integer(RUN(&env, "iNcR", "k"), 2));
    assert(is_integer(RUN(&env, "dEl", "k"), 1));
    assert(is_text(RUN(&env, "ping"), "+PONG\r\n"));
    env_destroy(&env);
}

/* 모르는 명령과 빈 명령 이름은 unknown command 오류다 */
static void test_unknown_and_empty_command(void) {
    Env env;
    env_init(&env, true);
    assert(is_text(RUN(&env, "FLUSHALL"), "-ERR unknown command\r\n"));
    assert(is_text(RUN(&env, ""), "-ERR unknown command\r\n"));
    assert(is_text(RUN(&env, "SETX", "a", "b"), "-ERR unknown command\r\n"));
    assert(is_text(RUN(&env, "SE", "a", "b"), "-ERR unknown command\r\n"));
    assert(env.record_count == 0 && env.store.size == 0);
    env_destroy(&env);
}

/* 인자 수가 틀린 명령은 wrong number 오류이고 저장소와 기록이 그대로다 */
static void test_wrong_argument_counts_change_nothing(void) {
    Env env;
    env_init(&env, true);
    assert(is_text(RUN(&env, "SET", "k", "v"), "+OK\r\n"));
    env.record_count = 0;
    const char *const *cases[] = {
        (const char *const[]){"SET", "k"},
        (const char *const[]){"SET", "k", "x", "EX"},
        (const char *const[]){"SET", "k", "x", "EX", "5", "extra"},
        (const char *const[]){"GET"},
        (const char *const[]){"GET", "k", "k"},
        (const char *const[]){"DEL"},
        (const char *const[]){"INCR"},
        (const char *const[]){"INCR", "k", "k"},
        (const char *const[]){"EXPIRE", "k"},
        (const char *const[]){"EXPIRE", "k", "5", "5"},
        (const char *const[]){"PEXPIRE", "k"},
        (const char *const[]){"PTTL"},
        (const char *const[]){"PING", "a", "b"},
        (const char *const[]){"SAVE", "now"},
    };
    const size_t counts[] = {2, 4, 6, 1, 3, 1, 1, 3, 2, 4, 2, 1, 3, 2};
    for (size_t i = 0; i < sizeof counts / sizeof *counts; ++i) {
        assert(text_starts_with(run_words(&env, cases[i], counts[i]), "-ERR wrong number of arguments"));
    }
    assert(env.record_count == 0 && env.save_calls == 0);
    assert(env.store.size == 1 && holds(&env, "k", "v"));
    assert(RUN(&env, "PTTL", "k").number == -1);
    env_destroy(&env);
}

/* SET EX 는 초 단위, PX 는 ms 단위로 만료 시각을 잡고 옵션 이름은 소문자도 된다 */
static void test_set_ttl_units(void) {
    Env env;
    env_init(&env, true);
    assert(is_text(RUN(&env, "SET", "sec", "v", "EX", "10"), "+OK\r\n"));
    assert(is_integer(RUN(&env, "PTTL", "sec"), 10000));
    assert(is_text(RUN(&env, "SET", "milli", "v", "PX", "10"), "+OK\r\n"));
    assert(is_integer(RUN(&env, "PTTL", "milli"), 10));
    assert(is_text(RUN(&env, "SET", "low", "v", "ex", "3"), "+OK\r\n"));
    assert(is_integer(RUN(&env, "PTTL", "low"), 3000));
    assert(is_text(RUN(&env, "SET", "lowpx", "v", "px", "7"), "+OK\r\n"));
    assert(is_integer(RUN(&env, "PTTL", "lowpx"), 7));
    /* 기록에도 절대 만료 시각이 들어간다 */
    assert(env.record_count == 4 && env.records[0].type == CHANGE_SET && env.records[0].deadline_ms == START_MS + 10000);
    assert(env.records[1].deadline_ms == START_MS + 10);
    env_destroy(&env);
}

/* 잘못된 TTL 값 · 모르는 옵션이면 오류이고 값은 저장되지 않는다 */
static void test_set_invalid_options(void) {
    Env env;
    env_init(&env, true);
    const char *bad_ttl[] = {"0", "-1", "abc", "9223372036854775807", "9223372036854775808", "1.5", "", "01"};
    for (size_t i = 0; i < sizeof bad_ttl / sizeof *bad_ttl; ++i) {
        assert(text_starts_with(RUN(&env, "SET", "k", "v", "EX", bad_ttl[i]), "-ERR"));
        assert(text_starts_with(RUN(&env, "SET", "k", "v", "PX", bad_ttl[i]), "-ERR"));
    }
    assert(absent(&env, "k") && env.store.size == 0 && env.record_count == 0);
    assert(is_text(RUN(&env, "SET", "k", "v", "NX", "1"), "-ERR syntax error\r\n"));
    assert(is_text(RUN(&env, "SET", "k", "v", "EXAT", "1"), "-ERR syntax error\r\n"));
    assert(absent(&env, "k") && env.record_count == 0);
    env_destroy(&env);
}

/* 오류인 SET 은 기존 값과 TTL 을 건드리지 않는다 */
static void test_failed_set_keeps_old_value(void) {
    Env env;
    env_init(&env, true);
    assert(is_text(RUN(&env, "SET", "k", "old", "EX", "30"), "+OK\r\n"));
    env.record_count = 0;
    assert(text_starts_with(RUN(&env, "SET", "k", "new", "EX", "0"), "-ERR"));
    assert(text_starts_with(RUN(&env, "SET", "k", "new", "PX", "abc"), "-ERR"));
    assert(holds(&env, "k", "old"));
    assert(is_integer(RUN(&env, "PTTL", "k"), 30000));
    assert(env.record_count == 0);
    env_destroy(&env);
}

/* TTL 이 있는 키를 TTL 없이 다시 SET 하면 TTL 이 사라진다 */
static void test_set_without_ttl_clears_ttl(void) {
    Env env;
    env_init(&env, true);
    assert(is_text(RUN(&env, "SET", "k", "a", "EX", "10"), "+OK\r\n"));
    assert(RUN(&env, "PTTL", "k").number > 0);
    assert(is_text(RUN(&env, "SET", "k", "b"), "+OK\r\n"));
    assert(is_integer(RUN(&env, "PTTL", "k"), -1));
    assert(env.records[1].deadline_ms == 0 && env.store.expiring == 0);
    env_destroy(&env);
}

/* GET : 없는 키는 nil 텍스트, 빈 값은 길이 0 bulk 로 구분된다 */
static void test_get_missing_vs_empty(void) {
    Env env;
    env_init(&env, true);
    assert(is_text(RUN(&env, "GET", "none"), "$-1\r\n"));
    assert(is_text(RUN(&env, "SET", "empty", ""), "+OK\r\n"));
    Reply reply = RUN(&env, "GET", "empty");
    assert(reply.type == REPLY_BULK && reply.bytes.length == 0);
    assert(is_text(RUN(&env, "SET", "", "emptykey"), "+OK\r\n"));
    assert(is_bulk(RUN(&env, "GET", ""), "emptykey"));
    env_destroy(&env);
}

/* DEL : 있는 키만 세고 같은 키를 두 번 적으면 한 번만 센다 */
static void test_del_counts_only_existing(void) {
    Env env;
    env_init(&env, true);
    RUN(&env, "SET", "a", "1");
    RUN(&env, "SET", "b", "2");
    env.record_count = 0;
    assert(is_integer(RUN(&env, "DEL", "a", "none", "b", "other"), 2));
    assert(env.store.size == 0);
    RUN(&env, "SET", "a", "1");
    env.record_count = 0;
    assert(is_integer(RUN(&env, "DEL", "a", "a"), 1));
    assert(is_integer(RUN(&env, "DEL", "a"), 0));
    assert(env.record_count == 1);
    env_destroy(&env);
}

/* DEL : 지운 키마다 CHANGE_DEL 이 한 번씩, 없는 키는 기록되지 않는다 */
static void test_del_records_each_deleted_key(void) {
    Env env;
    env_init(&env, true);
    RUN(&env, "SET", "a", "1");
    RUN(&env, "SET", "b", "2");
    env.record_count = 0;
    assert(is_integer(RUN(&env, "DEL", "a", "none", "b"), 2));
    assert(env.record_count == 2);
    assert(env.records[0].type == CHANGE_DEL && strcmp(env.records[0].key, "a") == 0);
    assert(env.records[1].type == CHANGE_DEL && strcmp(env.records[1].key, "b") == 0);
    env.record_count = 0;
    assert(is_integer(RUN(&env, "DEL", "none"), 0));
    assert(env.record_count == 0);
    env_destroy(&env);
}

/* INCR : 음수 경계와 0 으로 넘어가는 값 */
static void test_incr_negative_values(void) {
    Env env;
    env_init(&env, true);
    RUN(&env, "SET", "a", "-1");
    assert(is_integer(RUN(&env, "INCR", "a"), 0));
    assert(holds(&env, "a", "0"));
    RUN(&env, "SET", "min", "-9223372036854775808");
    assert(is_integer(RUN(&env, "INCR", "min"), -9223372036854775807));
    assert(holds(&env, "min", "-9223372036854775807"));
    env_destroy(&env);
}

/* INCR : 정수가 아닌 값은 오류이고 값 그대로, 기록 없음 */
static void test_incr_rejects_non_integers(void) {
    Env env;
    env_init(&env, true);
    const char *bad[] = {"007", " 1", "1 ", "+1", "", "1.5", "abc", "-", "0x10"};
    for (size_t i = 0; i < sizeof bad / sizeof *bad; ++i) {
        RUN(&env, "SET", "k", bad[i]);
        env.record_count = 0;
        assert(is_text(RUN(&env, "INCR", "k"), "-ERR value is not an integer or out of range\r\n"));
        assert(holds(&env, "k", bad[i]));
        assert(env.record_count == 0);
    }
    env_destroy(&env);
}

/* INCR : 최댓값에서 넘침 오류이고 값 그대로, 범위 밖 숫자도 정수 오류 */
static void test_incr_overflow(void) {
    Env env;
    env_init(&env, true);
    RUN(&env, "SET", "k", "9223372036854775807");
    env.record_count = 0;
    assert(is_text(RUN(&env, "INCR", "k"), "-ERR increment or decrement would overflow\r\n"));
    assert(holds(&env, "k", "9223372036854775807") && env.record_count == 0);
    RUN(&env, "SET", "k", "9223372036854775808");
    assert(text_starts_with(RUN(&env, "INCR", "k"), "-ERR value is not an integer"));
    assert(holds(&env, "k", "9223372036854775808"));
    env_destroy(&env);
}

/* INCR 성공 : CHANGE_SET 으로 새 값과 기존 만료 시각이 기록된다 */
static void test_incr_records_set_with_deadline(void) {
    Env env;
    env_init(&env, true);
    RUN(&env, "SET", "t", "5", "EX", "100");
    env.record_count = 0;
    assert(is_integer(RUN(&env, "INCR", "t"), 6));
    assert(env.record_count == 1 && env.records[0].type == CHANGE_SET);
    assert(strcmp(env.records[0].key, "t") == 0 && strcmp(env.records[0].value, "6") == 0);
    assert(env.records[0].deadline_ms == START_MS + 100000);
    assert(is_integer(RUN(&env, "PTTL", "t"), 100000));
    env.record_count = 0;
    assert(is_integer(RUN(&env, "INCR", "fresh"), 1));
    assert(env.record_count == 1 && env.records[0].deadline_ms == 0 && strcmp(env.records[0].value, "1") == 0);
    env_destroy(&env);
}

/* EXPIRE · PEXPIRE : 없는 키는 0 이고 기록하지 않는다 */
static void test_expire_missing_key(void) {
    Env env;
    env_init(&env, true);
    assert(is_integer(RUN(&env, "EXPIRE", "none", "10"), 0));
    assert(is_integer(RUN(&env, "PEXPIRE", "none", "10"), 0));
    assert(is_integer(RUN(&env, "EXPIRE", "none", "0"), 0));
    assert(env.record_count == 0);
    env_destroy(&env);
}

/* EXPIRE · PEXPIRE : 0 이하 TTL 은 즉시 삭제하고 CHANGE_DEL 로 기록한다 */
static void test_expire_non_positive_deletes(void) {
    Env env;
    env_init(&env, true);
    const char *zero_or_less[] = {"0", "-1", "-9223372036854775808"};
    const char *commands[] = {"EXPIRE", "PEXPIRE"};
    for (size_t c = 0; c < 2; ++c) {
        for (size_t i = 0; i < 3; ++i) {
            RUN(&env, "SET", "k", "v");
            env.record_count = 0;
            assert(is_integer(RUN(&env, commands[c], "k", zero_or_less[i]), 1));
            assert(absent(&env, "k") && env.store.size == 0 && env.store.expiring == 0);
            assert(env.record_count == 1 && env.records[0].type == CHANGE_DEL && strcmp(env.records[0].key, "k") == 0);
        }
    }
    env_destroy(&env);
}

/* EXPIRE · PEXPIRE : 양수는 CHANGE_EXPIRE 와 새 만료 시각을 기록하고 PEXPIRE 는 ms 단위다 */
static void test_expire_positive_records_deadline(void) {
    Env env;
    env_init(&env, true);
    RUN(&env, "SET", "k", "v");
    env.record_count = 0;
    assert(is_integer(RUN(&env, "EXPIRE", "k", "10"), 1));
    assert(env.record_count == 1 && env.records[0].type == CHANGE_EXPIRE);
    assert(env.records[0].deadline_ms == START_MS + 10000 && strcmp(env.records[0].key, "k") == 0);
    assert(is_integer(RUN(&env, "PTTL", "k"), 10000));
    assert(is_integer(RUN(&env, "PEXPIRE", "k", "10"), 1));
    assert(env.records[1].type == CHANGE_EXPIRE && env.records[1].deadline_ms == START_MS + 10);
    assert(is_integer(RUN(&env, "PTTL", "k"), 10));
    assert(holds(&env, "k", "v"));
    env_destroy(&env);
}

/* EXPIRE · PEXPIRE : 정수가 아니거나 넘치면 오류이고 키는 그대로다 */
static void test_expire_invalid_value(void) {
    Env env;
    env_init(&env, true);
    RUN(&env, "SET", "k", "v");
    env.record_count = 0;
    const char *bad[] = {"abc", "1.5", "", "+5", "9223372036854775808", "9223372036854775807"};
    const char *commands[] = {"EXPIRE", "PEXPIRE"};
    for (size_t c = 0; c < 2; ++c) {
        for (size_t i = 0; i < sizeof bad / sizeof *bad; ++i) {
            assert(is_text(RUN(&env, commands[c], "k", bad[i]), "-ERR value is not an integer or out of range\r\n"));
        }
    }
    assert(holds(&env, "k", "v") && env.record_count == 0 && RUN(&env, "PTTL", "k").number == -1);
    env_destroy(&env);
}

/* PTTL : 없는 키 -2, TTL 없음 -1, 아니면 남은 ms */
static void test_pttl_values(void) {
    Env env;
    env_init(&env, true);
    assert(is_integer(RUN(&env, "PTTL", "none"), -2));
    RUN(&env, "SET", "plain", "v");
    assert(is_integer(RUN(&env, "PTTL", "plain"), -1));
    RUN(&env, "SET", "ttl", "v", "PX", "500");
    assert(is_integer(RUN(&env, "PTTL", "ttl"), 500));
    env.context.now_ms = START_MS + 123;
    assert(is_integer(RUN(&env, "PTTL", "ttl"), 377));
    env_destroy(&env);
}

/* PING : 인자 없으면 +PONG, 하나면 그 값을 bulk 로 돌려준다 */
static void test_ping(void) {
    Env env;
    env_init(&env, true);
    assert(is_text(RUN(&env, "PING"), "+PONG\r\n"));
    assert(is_bulk(RUN(&env, "PING", "hello"), "hello"));
    Reply empty = RUN(&env, "PING", "");
    assert(empty.type == REPLY_BULK && empty.bytes.length == 0);
    assert(env.record_count == 0 && env.store.size == 0);
    env_destroy(&env);
}

/* SAVE : 꺼져 있으면 오류, 성공 함수면 +OK, 실패 함수면 save failed */
static void test_save_variants(void) {
    Env env;
    env_init(&env, false);
    assert(text_starts_with(RUN(&env, "SAVE"), "-ERR snapshot is disabled"));
    env_destroy(&env);

    env_init(&env, true);
    assert(is_text(RUN(&env, "SAVE"), "+OK\r\n") && env.save_calls == 1);
    env.save_result = false;
    assert(is_text(RUN(&env, "SAVE"), "-ERR snapshot save failed\r\n") && env.save_calls == 2);
    assert(env.record_count == 0);
    env_destroy(&env);
}

/* 읽기 명령과 실패한 명령은 record_change 를 부르지 않는다 */
static void test_reads_and_failures_do_not_record(void) {
    Env env;
    env_init(&env, true);
    RUN(&env, "SET", "k", "v");
    RUN(&env, "SET", "n", "abc");
    env.record_count = 0;
    RUN(&env, "GET", "k");
    RUN(&env, "GET", "none");
    RUN(&env, "PTTL", "k");
    RUN(&env, "PING");
    RUN(&env, "SAVE");
    RUN(&env, "INCR", "n");
    RUN(&env, "SET", "k", "x", "EX", "0");
    RUN(&env, "EXPIRE", "none", "5");
    RUN(&env, "DEL", "none");
    RUN(&env, "BOGUS");
    assert(env.record_count == 0);
    env_destroy(&env);
}

/* record_change 가 NULL 이어도 명령이 정상 동작한다 */
static void test_null_hooks_are_safe(void) {
    Env env;
    env_init(&env, false);
    assert(is_text(RUN(&env, "SET", "k", "1", "EX", "5"), "+OK\r\n"));
    assert(is_integer(RUN(&env, "INCR", "k"), 2));
    assert(is_integer(RUN(&env, "EXPIRE", "k", "9"), 1));
    assert(is_integer(RUN(&env, "DEL", "k"), 1));
    env_destroy(&env);
}

/* 만료 시각이 지난 키는 모든 명령에서 없는 키로 보인다 (시각이 같으면 이미 만료) */
static void test_expired_key_looks_missing(void) {
    Env env;
    env_init(&env, true);
    const uint64_t expired_at = START_MS + 100;

    RUN(&env, "SET", "k", "v", "PX", "100");
    env.context.now_ms = expired_at - 1;
    assert(is_bulk(RUN(&env, "GET", "k"), "v"));
    env.context.now_ms = expired_at;
    assert(is_text(RUN(&env, "GET", "k"), "$-1\r\n"));

    env.context.now_ms = START_MS;
    RUN(&env, "SET", "k", "41", "PX", "100");
    env.context.now_ms = expired_at;
    env.record_count = 0;
    assert(is_integer(RUN(&env, "INCR", "k"), 1));
    assert(is_integer(RUN(&env, "PTTL", "k"), -1));
    assert(env.records[0].type == CHANGE_SET && env.records[0].deadline_ms == 0);

    env.context.now_ms = START_MS;
    RUN(&env, "SET", "k", "v", "PX", "100");
    env.context.now_ms = expired_at;
    env.record_count = 0;
    assert(is_integer(RUN(&env, "EXPIRE", "k", "10"), 0));
    assert(env.record_count == 0);

    env.context.now_ms = START_MS;
    RUN(&env, "SET", "k", "v", "PX", "100");
    env.context.now_ms = expired_at;
    env.record_count = 0;
    assert(is_integer(RUN(&env, "DEL", "k"), 0));
    assert(env.record_count == 0);

    env.context.now_ms = START_MS;
    RUN(&env, "SET", "k", "v", "PX", "100");
    env.context.now_ms = expired_at + 5;
    assert(is_integer(RUN(&env, "PTTL", "k"), -2));
    env_destroy(&env);
}

int main(void) {
    test_command_names_ignore_case();
    test_unknown_and_empty_command();
    test_wrong_argument_counts_change_nothing();
    test_set_ttl_units();
    test_set_invalid_options();
    test_failed_set_keeps_old_value();
    test_set_without_ttl_clears_ttl();
    test_get_missing_vs_empty();
    test_del_counts_only_existing();
    test_del_records_each_deleted_key();
    test_incr_negative_values();
    test_incr_rejects_non_integers();
    test_incr_overflow();
    test_incr_records_set_with_deadline();
    test_expire_missing_key();
    test_expire_non_positive_deletes();
    test_expire_positive_records_deadline();
    test_expire_invalid_value();
    test_pttl_values();
    test_ping();
    test_save_variants();
    test_reads_and_failures_do_not_record();
    test_null_hooks_are_safe();
    test_expired_key_looks_missing();
    puts("24 command unit scenarios passed");
    return 0;
}
