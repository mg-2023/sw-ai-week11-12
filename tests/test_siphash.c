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

int main(void) {
    test_official_vectors();
    puts("1 SipHash unit scenario passed (64 official vectors)");
    return 0;
}
