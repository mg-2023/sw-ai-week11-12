/* store.js 단위 테스트 — 저장 · 조회 · 삭제 · 만료 · 무효화
 *
 *   시간은 실제로 기다리지 않는다. now 를 바꿔 끼운 가짜 시계(clock.t)를 직접 움직인다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, CommandError } from '../store.js';

function setup() {
  const clock = { t: 1_000_000 };
  const records = [];
  const store = createStore({ now: () => clock.t, onWrite: (r) => records.push(r) });
  return { store, clock, records };
}

/* ---------------------------------------------------------------- 저장 / 조회 / 삭제 */

test('set → get: 저장한 값을 그대로 돌려준다 (문자열, 숫자, 객체, 배열)', () => {
  const { store } = setup();
  store.set('s', '문자열'); store.set('n', 42); store.set('o', { name: '철수', tags: ['a'] }); store.set('z', 0); store.set('f', false);
  assert.equal(store.get('s'), '문자열');
  assert.equal(store.get('n'), 42);
  assert.deepEqual(store.get('o'), { name: '철수', tags: ['a'] });
  assert.equal(store.get('z'), 0);
  assert.equal(store.get('f'), false);
});

test('get: 없는 키는 null', () => {
  assert.equal(setup().store.get('없음'), null);
});

test('set: 같은 키에 다시 저장하면 덮어쓴다', () => {
  const { store } = setup();
  store.set('a', 1);
  store.set('a', 2);
  assert.equal(store.get('a'), 2);
  assert.equal(store.size, 1);
});

test('del: 지운 개수를 돌려주고, 지운 키는 조회되지 않는다', () => {
  const { store } = setup();
  store.set('a', 1); store.set('b', 2);
  assert.equal(store.del('a', 'b', '없는 키'), 2);
  assert.equal(store.get('a'), null);
  assert.equal(store.exists('b'), false);
  assert.equal(store.del('a'), 0);
});

test('set 옵션 nx: 키가 없을 때만 저장한다 / xx: 키가 있을 때만 저장한다', () => {
  const { store } = setup();
  assert.equal(store.set('lock', 'A', { nx: true }), true);
  assert.equal(store.set('lock', 'B', { nx: true }), false);
  assert.equal(store.get('lock'), 'A');
  assert.equal(store.set('없음', 1, { xx: true }), false);
  assert.equal(store.set('lock', 'C', { xx: true }), true);
  assert.equal(store.get('lock'), 'C');
});

test('incr: 없는 키는 0 에서 시작하고, 정수가 아니면 오류', () => {
  const { store } = setup();
  assert.equal(store.incr('views'), 1);
  assert.equal(store.incr('views', 10), 11);
  assert.equal(store.incr('views', -1), 10);
  store.set('name', '철수');
  assert.throws(() => store.incr('name'), CommandError);
  assert.throws(() => store.incr('views', 1.5), CommandError);
});

test('keys: 접두사로 걸러 준다', () => {
  const { store } = setup();
  store.set('user:1', 1); store.set('user:2', 2); store.set('post:1', 3);
  assert.deepEqual(store.keys('user:').sort(), ['user:1', 'user:2']);
  assert.equal(store.keys().length, 3);
});

/* ---------------------------------------------------------------- 만료 */

test('만료: 보관 기간이 지나기 전에는 조회되고, 지나면 null 이 되며 저장소에서도 지워진다 (지연 삭제)', () => {
  const { store, clock } = setup();
  store.set('session', 'abc', { ttl: 1000 });
  clock.t += 999;
  assert.equal(store.get('session'), 'abc');
  clock.t += 1;
  assert.equal(store.size, 1);                    // 아직 아무도 찾지 않아 남아 있다
  assert.equal(store.get('session'), null);       // 찾는 순간 만료를 확인하고 지운다
  assert.equal(store.size, 0);
  assert.equal(store.info().expired, 1);
});

test('만료: 만료된 키는 exists / keys / del / incr 에서도 없는 키로 취급한다', () => {
  const { store, clock } = setup();
  store.set('a', 5, { ttl: 100 });
  clock.t += 100;
  assert.equal(store.exists('a'), false);
  store.set('b', 5, { ttl: 100 }); store.set('c', 5, { ttl: 100 }); store.set('d', 5, { ttl: 100 });
  clock.t += 100;
  assert.deepEqual(store.keys(), []);
  store.set('c', 5, { ttl: 100 }); store.set('d', 5, { ttl: 100 });
  clock.t += 100;
  assert.equal(store.del('c'), 0);
  assert.equal(store.incr('d'), 1);               // 만료된 5 가 아니라 0 에서 다시 시작
});

test('ttl: 남은 시간 / 만료 없음 -1 / 없는 키 -2', () => {
  const { store, clock } = setup();
  store.set('a', 1, { ttl: 5000 });
  store.set('b', 1);
  clock.t += 2000;
  assert.equal(store.ttl('a'), 3000);
  assert.equal(store.ttl('b'), -1);
  assert.equal(store.ttl('없음'), -2);
});

test('expire / persist: 나중에 만료를 걸거나 없앨 수 있다', () => {
  const { store, clock } = setup();
  store.set('a', 1);
  assert.equal(store.expire('a', 1000), true);
  assert.equal(store.expire('없음', 1000), false);
  assert.equal(store.persist('a'), true);
  assert.equal(store.persist('a'), false);        // 이미 만료가 없다
  clock.t += 5000;
  assert.equal(store.get('a'), 1);
});

test('set 으로 덮어쓰면 이전 만료는 사라지고, incr 는 만료를 유지한다', () => {
  const { store, clock } = setup();
  store.set('a', 1, { ttl: 1000 });
  store.set('a', 2);
  store.set('n', 1, { ttl: 1000 });
  store.incr('n');
  assert.equal(store.ttl('a'), -1);
  assert.equal(store.ttl('n'), 1000);
  clock.t += 1000;
  assert.equal(store.get('a'), 2);
  assert.equal(store.get('n'), null);
});

test('주기 삭제: 아무도 찾지 않는 만료 키도 sweepExpired 가 지운다', () => {
  const { store, clock } = setup();
  for (let i = 0; i < 500; i++) store.set('temp:' + i, i, { ttl: 1000 });
  for (let i = 0; i < 100; i++) store.set('keep:' + i, i);
  clock.t += 1000;
  assert.equal(store.size, 600);
  let removed = 0;
  for (let tick = 0; tick < 20 && store.size > 100; tick++) removed += store.sweepExpired();
  assert.equal(removed, 500);
  assert.equal(store.size, 100);
  assert.equal(store.get('keep:7'), 7);
});

test('주기 삭제: 만료되지 않은 키는 건드리지 않는다', () => {
  const { store } = setup();
  for (let i = 0; i < 100; i++) store.set('k' + i, i, { ttl: 1000 });
  assert.equal(store.sweepExpired(), 0);
  assert.equal(store.size, 100);
});

/* ---------------------------------------------------------------- 무효화 */

test('무효화: delByPrefix 는 접두사가 같은 키만 지운다', () => {
  const { store } = setup();
  store.set('post:1', 1); store.set('post:2', 2); store.set('user:1', 3);
  assert.equal(store.delByPrefix('post:'), 2);
  assert.deepEqual(store.keys(), ['user:1']);
});

test('무효화: flushAll 은 전부 지운다', () => {
  const { store } = setup();
  store.set('a', 1); store.set('b', 2, { ttl: 1000 });
  assert.equal(store.flushAll(), 2);
  assert.equal(store.size, 0);
  assert.equal(store.info().keysWithTtl, 0);
});

/* ---------------------------------------------------------------- 엣지 케이스 */

test('엣지: 잘못된 키 (빈 문자열, 문자열이 아님, 너무 긺) 는 오류', () => {
  const { store } = setup();
  for (const key of ['', 123, null, undefined, {}, 'x'.repeat(513)]) {
    assert.throws(() => store.set(key, 1), CommandError);
    assert.throws(() => store.get(key), CommandError);
    assert.throws(() => store.del(key), CommandError);
  }
  store.set('x'.repeat(512), 1);                  // 512자까지는 된다
});

test('엣지: 값이 없거나(undefined / null) ttl 이 잘못되면 오류이고 저장되지 않는다', () => {
  const { store } = setup();
  assert.throws(() => store.set('a', undefined), CommandError);
  assert.throws(() => store.set('a', null), CommandError);
  for (const ttl of [0, -1, NaN, Infinity, '1000']) assert.throws(() => store.set('a', 1, { ttl }), CommandError);
  assert.throws(() => store.expire('a', 0), CommandError);
  assert.throws(() => store.delByPrefix(''), CommandError);
  assert.equal(store.exists('a'), false);
});

test('엣지: 한글·공백·특수문자가 들어간 키', () => {
  const { store } = setup();
  for (const key of ['사용자:1', 'a b c', 'a/b?c=d&e', '😀', '__proto__']) {
    store.set(key, key);
    assert.equal(store.get(key), key);
  }
});

test('info: 조회 적중 / 실패 횟수를 센다', () => {
  const { store } = setup();
  store.set('a', 1);
  store.get('a'); store.get('a'); store.get('없음');
  const info = store.info();
  assert.equal(info.hits, 2);
  assert.equal(info.misses, 1);
  assert.equal(info.keys, 1);
});

/* ---------------------------------------------------------------- 기록 (영속성용) */

test('데이터를 바꾼 명령만 onWrite 로 기록되고, 만료는 절대 시각으로 적힌다', () => {
  const { store, records, clock } = setup();
  store.set('a', 1, { ttl: 500 });
  store.get('a');
  store.del('a');
  store.del('a');                                 // 지운 것이 없으면 기록하지 않는다
  assert.deepEqual(records, [
    { op: 'set', key: 'a', value: 1, expireAt: clock.t + 500 },
    { op: 'del', key: 'a' },
  ]);
});

test('apply: 기록을 다시 실행하면 같은 상태가 된다', () => {
  const a = setup();
  a.store.set('x', 1); a.store.set('y', { v: 2 }, { ttl: 5000 }); a.store.incr('x'); a.store.set('z', 3); a.store.del('z'); a.store.expire('x', 9000);
  const b = setup();
  a.records.forEach((r) => b.store.apply(r));
  assert.equal(b.store.get('x'), 2);
  assert.deepEqual(b.store.get('y'), { v: 2 });
  assert.equal(b.store.get('z'), null);
  assert.equal(b.store.ttl('x'), 9000);
  assert.equal(b.store.ttl('y'), 5000);
  assert.equal(b.records.length, 0);              // apply 는 다시 기록하지 않는다
});
