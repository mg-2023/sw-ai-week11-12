/*
 * siphash.h : 키 있는 해시 SipHash-2-4 (64비트 출력). 키를 모르는 공격자가 같은 버킷으로 몰리는 입력을 미리 계산하지 못하게 한다.
 */

#ifndef MINI_REDIS_SIPHASH_H
#define MINI_REDIS_SIPHASH_H

#include <stddef.h>
#include <stdint.h>

/* data 의 length 바이트를 16바이트 key 로 해시한다. length 가 0 이면 data 는 읽지 않는다. */
uint64_t siphash24(const void *data, size_t length, const uint8_t key[16]);

#endif
