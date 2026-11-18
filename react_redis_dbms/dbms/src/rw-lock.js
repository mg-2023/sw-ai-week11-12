/* ======================================================================
 * rw-lock.js — 스레드끼리 함께 쓰는 읽기-쓰기 잠금 (테이블마다 하나)
 *
 *   규칙
 *     - 읽기(SELECT)끼리는 동시에 여러 스레드가 들어갈 수 있다
 *     - 쓰기(INSERT)는 혼자만 들어간다. 쓰는 동안에는 읽기도 다른 쓰기도 기다린다
 *     - 기다리는 쓰기가 있으면 새 읽기는 들어가지 않고 양보한다 (읽기가 끊이지 않아 쓰기가 영영 못 들어가는 일을 막는다)
 *
 *   워커 스레드는 변수를 공유하지 않는다. 그래서 잠금 상태를 SharedArrayBuffer(모든 스레드가 같이 보는 메모리)에 둔다.
 *   테이블 하나당 정수 2칸:
 *     state   :  0 = 아무도 없음,  n > 0 = 읽는 스레드 n 개,  -1 = 쓰는 스레드 1 개
 *     waiting :  쓰려고 기다리는 스레드 수
 *
 *   Atomics 를 쓰는 이유
 *     "값을 읽고 → 비교하고 → 바꾸는" 사이에 다른 스레드가 끼어들면 두 스레드가 동시에 잠금을 잡게 된다.
 *     Atomics.compareExchange 는 이 세 단계를 끼어들 수 없는 한 동작으로 실행한다.
 *     Atomics.wait / notify 는 잠금이 풀릴 때까지 스레드를 재워 두었다가 깨운다 (CPU 를 쓰며 돌지 않는다).
 * ====================================================================== */

const SLOT_INTS = 2;
const RECHECK_MS = 10;               // 자다가도 이 시간마다 한 번씩 깨어 다시 확인한다

/** 테이블 count 개 분량의 공유 메모리를 만든다 (메인 스레드가 만들어 워커들에게 넘긴다) */
export function createLockBuffer(count) {
  return new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * SLOT_INTS * count);
}

/** 잠금을 너무 오래 기다렸을 때 */
export class LockTimeoutError extends Error {}

/** buffer 의 slot 번째 잠금을 다루는 객체를 만든다. timeout(ms) 안에 잡지 못하면 LockTimeoutError */
export function createRwLock(buffer, slot, { timeout = 10_000 } = {}) {
  const ints = new Int32Array(buffer);
  const STATE = slot * SLOT_INTS, WAITING = STATE + 1;

  /** 지금 바로 읽기 잠금을 잡을 수 있으면 잡고 true */
  function tryRead() {
    const state = Atomics.load(ints, STATE);
    if (state < 0 || Atomics.load(ints, WAITING) > 0) return false;
    return Atomics.compareExchange(ints, STATE, state, state + 1) === state;   // 그 사이 값이 바뀌었으면 실패
  }

  /** 지금 바로 쓰기 잠금을 잡을 수 있으면 잡고 true (아무도 없을 때만) */
  function tryWrite() {
    return Atomics.compareExchange(ints, STATE, 0, -1) === 0;
  }

  /** attempt 가 성공할 때까지 기다린다 */
  function acquire(attempt, what) {
    const deadline = Date.now() + timeout;
    while (!attempt()) {
      if (Date.now() > deadline) throw new LockTimeoutError(what + ' 잠금을 ' + timeout + 'ms 안에 잡지 못했습니다');
      const state = Atomics.load(ints, STATE);
      Atomics.wait(ints, STATE, state, state === 0 ? 1 : RECHECK_MS);           // state 가 바뀌거나 시간이 지날 때까지 잔다
    }
  }

  return {
    tryRead,
    tryWrite,

    lockRead() { acquire(tryRead, '읽기'); },

    unlockRead() {
      if (Atomics.sub(ints, STATE, 1) === 1) Atomics.notify(ints, STATE);       // 마지막 읽기가 나갔다 → 기다리는 스레드를 깨운다
    },

    lockWrite() {
      Atomics.add(ints, WAITING, 1);                                            // "쓰려고 기다리는 중" 표시 → 새 읽기가 양보한다
      try { acquire(tryWrite, '쓰기'); } finally { Atomics.sub(ints, WAITING, 1); }
    },

    unlockWrite() {
      Atomics.store(ints, STATE, 0);
      Atomics.notify(ints, STATE);
    },

    /** 현재 상태 (테스트·확인용) */
    peek() { return { state: Atomics.load(ints, STATE), waitingWriters: Atomics.load(ints, WAITING) }; },
  };
}
