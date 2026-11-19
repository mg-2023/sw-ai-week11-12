/* bplus-tree.js 단위 테스트 — B+ 트리
 *
 *   order 를 작게(4) 잡아 적은 데이터로도 쪼개기가 많이 일어나게 한다.
 *   넣을 때마다 validate() 로 B+ 트리의 규칙이 지켜지는지 검사한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BPlusTree } from '../bplus-tree.js';

/** 매번 같은 순서가 나오는 난수 (테스트가 실행할 때마다 달라지지 않게) */
function seeded(seed) {
  return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
}
function shuffled(n, seed = 1) {
  const rand = seeded(seed), list = Array.from({ length: n }, (_, i) => i + 1);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  return list;
}

test('빈 트리: 검색하면 undefined, 높이 1', () => {
  const tree = new BPlusTree(4);
  assert.equal(tree.search(1), undefined);
  assert.equal(tree.size, 0);
  assert.equal(tree.height, 1);
  assert.equal(tree.maxKey(), undefined);
  assert.deepEqual([...tree.range()], []);
  tree.validate();
});

test('넣은 키를 찾을 수 있고, 없는 키는 undefined', () => {
  const tree = new BPlusTree(4);
  tree.insert(10, 'a'); tree.insert(20, 'b'); tree.insert(5, 'c');
  assert.equal(tree.search(10), 'a');
  assert.equal(tree.search(5), 'c');
  assert.equal(tree.search(15), undefined);
  assert.equal(tree.has(20), true);
  assert.equal(tree.size, 3);
});

test('리프 쪼개기: 키가 order 개가 되면 둘로 나뉘고 높이가 2가 된다', () => {
  const tree = new BPlusTree(4);
  [1, 2, 3].forEach((k) => tree.insert(k, k));
  assert.equal(tree.height, 1);
  tree.insert(4, 4);
  assert.equal(tree.height, 2);
  assert.deepEqual(tree.root.keys, [3]);                               // 오른쪽 리프의 첫 키가 부모로 복사됐다
  assert.deepEqual(tree.root.children.map((c) => c.keys), [[1, 2], [3, 4]]);
  assert.equal(tree.root.children[0].next, tree.root.children[1]);     // 리프끼리 이어져 있다
  tree.validate();
});

test('내부 노드 쪼개기: 계속 넣으면 높이가 3 이상으로 자라고 규칙이 유지된다', () => {
  const tree = new BPlusTree(4);
  for (let k = 1; k <= 100; k++) { tree.insert(k, k * 10); tree.validate(); }
  assert.ok(tree.height >= 3);
  for (let k = 1; k <= 100; k++) assert.equal(tree.search(k), k * 10);
});

test('넣는 순서가 달라도 (오름차순 / 내림차순 / 무작위) 전부 찾을 수 있다', () => {
  const orders = { 오름차순: shuffled(500).sort((a, b) => a - b), 내림차순: shuffled(500).sort((a, b) => b - a), 무작위: shuffled(500, 7) };
  for (const [name, keys] of Object.entries(orders)) {
    const tree = new BPlusTree(5);
    keys.forEach((k) => tree.insert(k, 'v' + k));
    tree.validate();
    assert.equal(tree.size, 500, name);
    for (let k = 1; k <= 500; k++) assert.equal(tree.search(k), 'v' + k, name);
    assert.equal(tree.search(0), undefined);
    assert.equal(tree.search(501), undefined);
  }
});

test('같은 키를 다시 넣으면 값만 바뀌고 개수는 그대로다', () => {
  const tree = new BPlusTree(4);
  for (let k = 1; k <= 20; k++) tree.insert(k, 'old');
  tree.insert(7, 'new');
  assert.equal(tree.search(7), 'new');
  assert.equal(tree.size, 20);
  tree.validate();
});

test('range: 리프를 옆으로 따라가며 범위 안의 키를 순서대로 준다', () => {
  const tree = new BPlusTree(4);
  shuffled(200, 3).forEach((k) => tree.insert(k * 2, k));                // 짝수 키 2 ~ 400
  assert.deepEqual([...tree.range(10, 20)].map(([k]) => k), [10, 12, 14, 16, 18, 20]);
  assert.deepEqual([...tree.range(11, 15)].map(([k]) => k), [12, 14]);  // 경계가 없는 키여도 된다
  assert.deepEqual([...tree.range(395)].map(([k]) => k), [396, 398, 400]);
  assert.deepEqual([...tree.range(-Infinity, 5)].map(([k]) => k), [2, 4]);
  assert.deepEqual([...tree.range(500, 600)], []);
  assert.deepEqual([...tree.range(20, 10)], []);
  assert.equal([...tree.range()].length, 200);
});

test('maxKey: 가장 큰 키 (다음 자동 ID 를 정할 때 쓴다)', () => {
  const tree = new BPlusTree(4);
  shuffled(300, 9).forEach((k) => tree.insert(k, k));
  assert.equal(tree.maxKey(), 300);
});

test('10만 건: 무작위로 넣어도 높이가 낮게 유지되고 전부 찾는다 (order 64)', () => {
  const tree = new BPlusTree();
  const keys = shuffled(100000, 42);
  keys.forEach((k) => tree.insert(k, k + 0.5));
  tree.validate();
  assert.equal(tree.size, 100000);
  assert.ok(tree.height <= 4, '높이: ' + tree.height);
  for (let k = 1; k <= 100000; k += 37) assert.equal(tree.search(k), k + 0.5);
});

test('엣지: order 는 3 이상의 정수여야 한다, 가장 작은 order 3 에서도 동작한다', () => {
  assert.throws(() => new BPlusTree(2));
  assert.throws(() => new BPlusTree(3.5));
  const tree = new BPlusTree(3);
  shuffled(300, 5).forEach((k) => { tree.insert(k, k); });
  tree.validate();
  for (let k = 1; k <= 300; k++) assert.equal(tree.search(k), k);
});

test('엣지: 값이 0 이어도 (파일의 첫 줄 위치) 찾을 수 있다', () => {
  const tree = new BPlusTree(4);
  tree.insert(1, 0);
  assert.equal(tree.search(1), 0);
  assert.equal(tree.has(1), true);
});
