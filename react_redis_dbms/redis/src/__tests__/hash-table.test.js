/* hash-table.js 단위 테스트 — 직접 구현한 해시 테이블 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HashTable, hashString } from '../hash-table.js';

/** 같은 버킷에 들어가는 서로 다른 키 n 개를 찾는다 (충돌을 일부러 만들기 위해) */
function collidingKeys(table, n) {
  const target = table.bucketIndex('k0');
  const keys = [];
  for (let i = 0; keys.length < n; i++) if (table.bucketIndex('k' + i) === target) keys.push('k' + i);
  return keys;
}

test('hashString: 같은 문자열은 항상 같은 값, 32비트 부호 없는 정수', () => {
  assert.equal(hashString('user:1'), hashString('user:1'));
  assert.notEqual(hashString('user:1'), hashString('user:2'));
  assert.equal(hashString(''), 0x811c9dc5);
  const h = hashString('아무 문자열');
  assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff);
});

test('저장한 값을 조회할 수 있고, 없는 키는 undefined', () => {
  const t = new HashTable();
  assert.equal(t.set('a', 1), true);
  assert.equal(t.get('a'), 1);
  assert.equal(t.has('a'), true);
  assert.equal(t.get('없는 키'), undefined);
  assert.equal(t.has('없는 키'), false);
  assert.equal(t.size, 1);
});

test('같은 키에 다시 저장하면 값만 바뀌고 개수는 그대로다', () => {
  const t = new HashTable();
  t.set('a', 1);
  assert.equal(t.set('a', 2), false);
  assert.equal(t.get('a'), 2);
  assert.equal(t.size, 1);
});

test('삭제하면 조회되지 않고, 없는 키를 지우면 false', () => {
  const t = new HashTable();
  t.set('a', 1);
  assert.equal(t.delete('a'), true);
  assert.equal(t.get('a'), undefined);
  assert.equal(t.delete('a'), false);
  assert.equal(t.size, 0);
});

test('충돌: 같은 버킷에 들어간 키들도 각각 저장·조회된다', () => {
  const t = new HashTable(64);
  const keys = collidingKeys(t, 5);
  keys.forEach((k, i) => t.set(k, i));
  assert.equal(t.stats().longestChain, 5);                 // 한 버킷에 5개가 이어져 있다
  keys.forEach((k, i) => assert.equal(t.get(k), i));
});

test('충돌: 연결 리스트의 머리 / 중간 / 끝 노드를 지워도 나머지는 남는다', () => {
  for (const victim of [0, 2, 4]) {                        // 리스트에서의 위치는 넣은 순서의 반대지만 세 위치를 모두 지나간다
    const t = new HashTable(64);
    const keys = collidingKeys(t, 5);
    keys.forEach((k, i) => t.set(k, i));
    assert.equal(t.delete(keys[victim]), true);
    keys.forEach((k, i) => assert.equal(t.get(k), i === victim ? undefined : i));
    assert.equal(t.size, 4);
  }
});

test('리사이즈: 적재율 0.75 를 넘으면 버킷이 2배로 늘고 모든 값이 그대로 조회된다', () => {
  const t = new HashTable();
  assert.equal(t.capacity, 16);
  for (let i = 0; i < 12; i++) t.set('k' + i, i);
  assert.equal(t.capacity, 16);                            // 12 / 16 = 0.75 → 아직 넘지 않았다
  t.set('k12', 12);
  assert.equal(t.capacity, 32);
  for (let i = 0; i <= 12; i++) assert.equal(t.get('k' + i), i);
});

test('리사이즈: 많이 지우면 버킷이 다시 줄어든다 (16 아래로는 줄지 않는다)', () => {
  const t = new HashTable();
  for (let i = 0; i < 1000; i++) t.set('k' + i, i);
  const grown = t.capacity;
  for (let i = 0; i < 1000; i++) t.delete('k' + i);
  assert.ok(grown >= 1024);
  assert.equal(t.capacity, 16);
  assert.equal(t.size, 0);
});

test('키 10만 개: 전부 조회되고 연결 리스트가 길어지지 않는다', () => {
  const t = new HashTable();
  for (let i = 0; i < 100000; i++) t.set('key:' + i, i);
  for (let i = 0; i < 100000; i += 997) assert.equal(t.get('key:' + i), i);
  const s = t.stats();
  assert.equal(s.size, 100000);
  assert.ok(s.loadFactor <= 0.75);
  assert.ok(s.longestChain <= 8, '가장 긴 연결 리스트: ' + s.longestChain);
});

test('entries / keys: 저장된 것을 빠짐없이 한 번씩 내보낸다', () => {
  const t = new HashTable();
  for (let i = 0; i < 50; i++) t.set('k' + i, i);
  assert.equal([...t.entries()].length, 50);
  assert.deepEqual(t.keys().sort(), Array.from({ length: 50 }, (_, i) => 'k' + i).sort());
});

test('scan: 조금씩 나눠 읽어도 한 바퀴 돌면 전부 읽는다', () => {
  const t = new HashTable();
  for (let i = 0; i < 200; i++) t.set('k' + i, i);
  const seen = new Set();
  let cursor = 0, calls = 0;
  do {
    const r = t.scan(cursor, 10);
    r.entries.forEach(([k]) => seen.add(k));
    cursor = r.cursor;
    calls++;
  } while (cursor !== 0);
  assert.equal(seen.size, 200);
  assert.ok(calls > 1);
});

test('clear: 전부 지우고 처음 크기로 돌아간다', () => {
  const t = new HashTable();
  for (let i = 0; i < 100; i++) t.set('k' + i, i);
  t.clear();
  assert.equal(t.size, 0);
  assert.equal(t.capacity, 16);
  assert.equal(t.get('k1'), undefined);
});

test('엣지: 빈 문자열·한글·이모지·아주 긴 키, Object 의 기본 속성 이름과 같은 키', () => {
  const t = new HashTable();
  const keys = ['', '한글 키', '😀', 'x'.repeat(10000), 'constructor', '__proto__', 'toString'];
  keys.forEach((k, i) => t.set(k, i));
  keys.forEach((k, i) => assert.equal(t.get(k), i));
  assert.equal(t.get('hasOwnProperty'), undefined);        // Object 를 저장소로 썼다면 함수가 나왔을 것이다
});

test('엣지: 값으로 undefined 가 아닌 무엇이든 저장된다 (0, false, null, 객체)', () => {
  const t = new HashTable();
  const obj = { a: [1, 2] };
  t.set('zero', 0); t.set('false', false); t.set('null', null); t.set('obj', obj);
  assert.equal(t.get('zero'), 0);
  assert.equal(t.get('false'), false);
  assert.equal(t.get('null'), null);
  assert.equal(t.get('obj'), obj);
  assert.equal(t.has('null'), true);
});
