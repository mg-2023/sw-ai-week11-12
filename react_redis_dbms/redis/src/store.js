/* ======================================================================
 * store.js — 키-값 저장소 (해시 테이블 + 만료 + 무효화)
 *
 *   해시 테이블 두 개를 쓴다. (실제 Redis 와 같은 구성)
 *     data    : key → value
 *     expires : key → 만료 시각(ms, 절대 시각). 만료를 건 키만 들어 있다
 *
 *   만료 처리 (보관 기간이 지난 값)
 *     - 지연 삭제 (lazy)   : 키에 접근할 때마다 만료 시각을 확인하고, 지났으면 그 자리에서 지운 뒤 "없음"으로 답한다
 *     - 주기 삭제 (active) : sweepExpired 가 expires 테이블을 조금씩 훑어, 아무도 찾지 않는 만료 키도 지운다
 *
 *   무효화 (저장된 값을 더는 쓰지 않게 하기)
 *     del(key)  ·  delByPrefix('user:')  ·  expire(key, ms)  ·  flushAll()
 *
 *   동시성
 *     모든 명령은 중간에 await 가 없는 동기 함수다. Node.js 는 자바스크립트를 스레드 하나로 실행하므로
 *     명령 하나가 끝나기 전에 다른 명령이 끼어들 수 없다 → 락이 필요 없다.
 *     "읽고 → 계산하고 → 쓰는" 동작은 incr, set 의 nx 옵션처럼 명령 하나로 제공한다.
 *
 *   영속성
 *     데이터를 바꾼 명령은 onWrite(record) 로 알린다. aof.js 가 이것을 파일에 이어 쓴다.
 *     apply(record) 는 그 기록을 다시 실행한다 (서버를 다시 켤 때).
 *
 *   파일·네트워크를 다루지 않는다.
 * ====================================================================== */

import { HashTable } from './hash-table.js';

const MAX_KEY_LENGTH = 512;

/** 잘못된 인자. API 서버는 이 오류를 400 응답으로 바꾼다 */
export class CommandError extends Error {}

function checkKey(key) {
  if (typeof key !== 'string' || key === '') throw new CommandError('key 는 비어 있지 않은 문자열이어야 합니다');
  if (key.length > MAX_KEY_LENGTH) throw new CommandError('key 는 ' + MAX_KEY_LENGTH + '자 이하여야 합니다');
}

function checkTtl(ttl) {
  if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) throw new CommandError('ttl 은 0 보다 큰 숫자(ms)여야 합니다');
}

/**
 * 저장소를 만든다.
 *   now     : 현재 시각(ms)을 돌려주는 함수. 테스트에서 시간을 직접 움직이려고 바꿔 끼울 수 있다
 *   onWrite : 데이터를 바꾼 명령의 기록을 받는 함수 (없으면 기록하지 않음)
 */
export function createStore({ now = Date.now, onWrite = null } = {}) {
  const data = new HashTable();
  const expires = new HashTable();
  const stats = { hits: 0, misses: 0, expired: 0 };
  let sweepCursor = 0;       // 주기 삭제가 expires 테이블을 어디까지 훑었는지

  const log = (record) => { if (onWrite) onWrite(record); };

  /** key 를 두 테이블에서 모두 지운다. 지웠으면 true */
  function remove(key) {
    expires.delete(key);
    return data.delete(key);
  }

  /** 지연 삭제: key 의 만료 시각이 지났으면 지우고 true */
  function removeIfExpired(key) {
    const at = expires.get(key);
    if (at === undefined || at > now()) return false;
    remove(key);
    stats.expired++;
    return true;
  }

  /** 살아 있는 키인가 (만료됐으면 지운다) */
  function alive(key) {
    return !removeIfExpired(key) && data.has(key);
  }

  const store = {
    /**
     * 저장. 옵션: ttl(ms) 보관 기간, nx 키가 없을 때만, xx 키가 있을 때만.
     * 저장했으면 true. ttl 없이 저장하면 이전에 걸려 있던 만료는 사라진다.
     */
    set(key, value, { ttl, nx = false, xx = false } = {}) {
      checkKey(key);
      if (value === undefined || value === null) throw new CommandError('value 가 없습니다');
      if (ttl !== undefined) checkTtl(ttl);
      const exists = alive(key);
      if ((nx && exists) || (xx && !exists)) return false;
      const expireAt = ttl === undefined ? null : now() + ttl;
      data.set(key, value);
      if (expireAt === null) expires.delete(key); else expires.set(key, expireAt);
      log({ op: 'set', key, value, expireAt });
      return true;
    },

    /** 조회. 없거나 만료됐으면 null */
    get(key) {
      checkKey(key);
      if (!alive(key)) { stats.misses++; return null; }
      stats.hits++;
      return data.get(key);
    },

    /** 삭제. 지운 개수를 돌려준다 */
    del(...keys) {
      let count = 0;
      for (const key of keys) {
        checkKey(key);
        if (!alive(key)) continue;
        remove(key);
        log({ op: 'del', key });
        count++;
      }
      return count;
    },

    exists(key) {
      checkKey(key);
      return alive(key);
    },

    /** 지금부터 ttl(ms) 뒤에 만료되게 한다. 키가 없으면 false */
    expire(key, ttl) {
      checkKey(key);
      checkTtl(ttl);
      if (!alive(key)) return false;
      const expireAt = now() + ttl;
      expires.set(key, expireAt);
      log({ op: 'expire', key, expireAt });
      return true;
    },

    /** 만료를 없앤다. 만료가 걸려 있었으면 true */
    persist(key) {
      checkKey(key);
      if (!alive(key) || !expires.delete(key)) return false;
      log({ op: 'persist', key });
      return true;
    },

    /** 남은 시간(ms). 만료가 없는 키는 -1, 없는 키는 -2 (Redis 의 규칙) */
    ttl(key) {
      checkKey(key);
      if (!alive(key)) return -2;
      const at = expires.get(key);
      return at === undefined ? -1 : at - now();
    },

    /** 정수 값을 by 만큼 더한다. 키가 없으면 0 에서 시작한다. 읽기와 쓰기가 한 명령이라 요청이 겹쳐도 숫자가 빠지지 않는다 */
    incr(key, by = 1) {
      checkKey(key);
      if (!Number.isInteger(by)) throw new CommandError('증가량은 정수여야 합니다');
      const current = alive(key) ? data.get(key) : 0;
      if (!Number.isInteger(current)) throw new CommandError('정수가 아닌 값은 증가시킬 수 없습니다');
      const value = current + by;
      data.set(key, value);                                    // 만료 시각은 그대로 둔다
      log({ op: 'set', key, value, expireAt: expires.get(key) ?? null });
      return value;
    },

    /** prefix 로 시작하는 살아 있는 키 목록 (prefix 를 생략하면 전체) */
    keys(prefix = '') {
      return data.keys().filter((key) => key.startsWith(prefix) && alive(key));
    },

    /** prefix 로 시작하는 키를 모두 지운다 (묶음 무효화). 지운 개수를 돌려준다 */
    delByPrefix(prefix) {
      if (typeof prefix !== 'string' || prefix === '') throw new CommandError('prefix 는 비어 있지 않은 문자열이어야 합니다');
      let count = 0;
      for (const key of store.keys(prefix)) count += store.del(key);
      return count;
    },

    /** 전부 지운다 */
    flushAll() {
      const count = data.size;
      data.clear();
      expires.clear();
      sweepCursor = 0;
      log({ op: 'flush' });
      return count;
    },

    /**
     * 주기 삭제: expires 테이블을 sample 개쯤 훑어 만료된 키를 지운다.
     * 훑은 것 중 1/4 넘게 만료돼 있었으면 만료 키가 많이 쌓였다는 뜻이므로 한 번 더 훑는다 (최대 rounds 번).
     * 지운 개수를 돌려준다.
     */
    sweepExpired(sample = 20, rounds = 10) {
      let removed = 0;
      for (let round = 0; round < rounds; round++) {
        const { cursor, entries } = expires.scan(sweepCursor, sample);
        sweepCursor = cursor;
        let expired = 0;
        for (const [key] of entries) if (removeIfExpired(key)) expired++;
        removed += expired;
        if (entries.length === 0 || expired * 4 <= entries.length) break;
      }
      return removed;
    },

    /** 저장된 키 수 (아직 청소되지 않은 만료 키가 포함될 수 있다) */
    get size() { return data.size; },

    /** 조회 적중·실패 횟수와 해시 테이블 상태 */
    info() {
      return { keys: data.size, keysWithTtl: expires.size, ...stats, table: data.stats() };
    },

    /* ------------------------------------------------------------ 영속성용 */

    /** 기록 하나를 다시 실행한다 (onWrite 를 부르지 않는다). 이미 만료 시각이 지난 set 은 건너뛴다 */
    apply(record) {
      const { op, key } = record;
      if (op === 'set') {
        if (record.expireAt !== null && record.expireAt <= now()) { remove(key); return; }
        data.set(key, record.value);
        if (record.expireAt === null) expires.delete(key); else expires.set(key, record.expireAt);
      } else if (op === 'del') {
        remove(key);
      } else if (op === 'expire') {
        if (data.has(key)) expires.set(key, record.expireAt);
      } else if (op === 'persist') {
        expires.delete(key);
      } else if (op === 'flush') {
        data.clear();
        expires.clear();
      } else {
        throw new Error('알 수 없는 기록: ' + JSON.stringify(record));
      }
    },

    /** 지금 살아 있는 데이터를 set 기록 목록으로 (로그 파일을 줄여 다시 쓸 때 사용) */
    snapshot() {
      return store.keys().map((key) => ({ op: 'set', key, value: data.get(key), expireAt: expires.get(key) ?? null }));
    },
  };
  return store;
}

/** interval(ms)마다 주기 삭제를 돌린다. 멈추는 함수를 돌려준다 */
export function startSweeper(store, interval = 100) {
  const timer = setInterval(() => store.sweepExpired(), interval);
  timer.unref();                       // 이 타이머 때문에 프로세스가 끝나지 못하는 일이 없게 한다
  return () => clearInterval(timer);
}
