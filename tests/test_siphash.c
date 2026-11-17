#include "siphash.h"

#include <assert.h>
#include <stdint.h>
#include <stdio.h>

#include "siphash_vectors.h"

/* 공식 벡터의 기대 출력은 8바이트 little-endian 이다. */
static uint64_t expected_hash(int length) {
    uint64_t value = 0;
    for (int i = 7; i >= 0; --i) {
        value = (value << 8) | vectors_sip64[length][i];
    }
    return value;
}

/* 키 00..0f, 입력 00,01,02.. 로 길이 0..63 전부를 공식 벡터와 대조한다(0, 1, 7, 8, 15, 16, 63 포함). */
static void test_official_vectors(void) {
    uint8_t key[16];
    uint8_t input[64];
    for (int i = 0; i < 16; ++i) {
        key[i] = (uint8_t)i;
    }
    for (int i = 0; i < 64; ++i) {
        input[i] = (uint8_t)i;
    }
    for (int length = 0; length < 64; ++length) {
        assert(siphash24(input, (size_t)length, key) == expected_hash(length));
    }
}

/* 키 16바이트 중 비트 하나만 바꿔도(128비트 전부) 같은 입력의 출력이 달라진다 */
static void test_key_bit_changes_output(void) {
    uint8_t key[16];
    const char input[] = "mini-redis key";
    for (int i = 0; i < 16; ++i) {
        key[i] = (uint8_t)(i * 17);
    }
    uint64_t base = siphash24(input, sizeof(input) - 1, key);
    for (int bit = 0; bit < 128; ++bit) {
        key[bit / 8] ^= (uint8_t)(1u << (bit % 8));
        assert(siphash24(input, sizeof(input) - 1, key) != base);
        key[bit / 8] ^= (uint8_t)(1u << (bit % 8));
    }
    assert(siphash24(input, sizeof(input) - 1, key) == base);
}

/* 입력 끝에 0 바이트를 붙이면 출력이 달라진다 (길이가 마지막 블록에 들어간다) */
static void test_trailing_zero_changes_output(void) {
    uint8_t key[16];
    uint8_t input[40] = {0};
    for (int i = 0; i < 16; ++i) {
        key[i] = (uint8_t)i;
    }
    for (size_t length = 0; length < 32; ++length) {
        assert(siphash24(input, length, key) != siphash24(input, length + 1, key));
    }
}

/* 같은 키 · 같은 입력이면 몇 번을 불러도 같은 출력이다 */
static void test_same_input_same_output(void) {
    const uint8_t key[16] = {9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 6};
    const char input[] = "stable";
    uint64_t first = siphash24(input, sizeof(input) - 1, key);
    for (int i = 0; i < 100; ++i) {
        assert(siphash24(input, sizeof(input) - 1, key) == first);
    }
    assert(siphash24(NULL, 0, key) == siphash24("ignored", 0, key));
}

int main(void) {
    test_official_vectors();
    test_key_bit_changes_output();
    test_trailing_zero_changes_output();
    test_same_input_same_output();
    puts("4 SipHash unit scenarios passed (64 official vectors)");
    return 0;
}
