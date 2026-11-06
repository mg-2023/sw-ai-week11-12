// Diff 단위 테스트: 두 VDOM → patches 목록
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/vdom');
const { diff, diffProps } = require('../src/diff');

const { h } = V;

// ───────── 정상 ─────────

test('같은 트리면 patches 가 비어 있다', () => {
  const a = h('div', { id: 'r' }, h('p', null, 'x'), h('ul', null, h('li', null, '1')));
  assert.deepEqual(diff(a, V.clone(a)), []);
});

test('텍스트만 바뀌면 TEXT 하나 (경로 포함)', () => {
  const a = h('div', null, h('p', null, 'old'));
  const b = h('div', null, h('p', null, 'new'));
  assert.deepEqual(diff(a, b), [{ type: 'TEXT', path: [0, 0], value: 'new' }]);
});

test('속성: 바뀐 것 · 생긴 것은 set, 없어진 것은 remove, 그대로인 것은 빠진다', () => {
  const a = h('p', { class: 'a', id: 'x', title: 't' });
  const b = h('p', { class: 'b', id: 'x', lang: 'ko' });
  assert.deepEqual(diff(a, b), [{ type: 'PROPS', path: [], set: { class: 'b', lang: 'ko' }, remove: ['title'] }]);
});

test('태그가 바뀌면 REPLACE 하나, 그 안은 더 비교하지 않는다', () => {
  const a = h('div', null, h('p', null, 'x', h('b', null, 'y')));
  const b = h('div', null, h('section', null, 'x', h('b', null, 'z')));
  const ps = diff(a, b);
  assert.equal(ps.length, 1);
  assert.equal(ps[0].type, 'REPLACE');
  assert.deepEqual(ps[0].path, [0]);
});

test('자식이 늘면 뒤에 CREATE (앞 번호부터)', () => {
  const a = h('ul', null, h('li', null, '1'));
  const b = h('ul', null, h('li', null, '1'), h('li', null, '2'), h('li', null, '3'));
  assert.deepEqual(diff(a, b).map((p) => [p.type, p.path]), [['CREATE', [1]], ['CREATE', [2]]]);
});

test('자식이 줄면 뒤 번호부터 REMOVE (번호 밀림 방지)', () => {
  const a = h('ul', null, h('li', null, '1'), h('li', null, '2'), h('li', null, '3'));
  const b = h('ul', null, h('li', null, '1'));
  assert.deepEqual(diff(a, b).map((p) => [p.type, p.path]), [['REMOVE', [2]], ['REMOVE', [1]]]);
});

// ───────── 경계 ─────────

test('텍스트 ↔ 요소로 바뀌면 REPLACE', () => {
  const a = h('p', null, 'x');
  const b = h('p', null, h('b', null, 'x'));
  assert.deepEqual(diff(a, b).map((p) => p.type), ['REPLACE']);
});

test('모든 자식이 없어지거나 빈 곳에 자식이 생기는 경우', () => {
  const full = h('div', null, h('p'), h('p'));
  const empty = h('div');
  assert.deepEqual(diff(full, empty).map((p) => p.type), ['REMOVE', 'REMOVE']);
  assert.deepEqual(diff(empty, full).map((p) => p.type), ['CREATE', 'CREATE']);
});

test('old 가 없으면 루트 CREATE, new 가 없으면 루트 REMOVE', () => {
  const a = h('div');
  assert.deepEqual(diff(undefined, a), [{ type: 'CREATE', path: [], node: a }]);
  assert.deepEqual(diff(a, undefined), [{ type: 'REMOVE', path: [] }]);
  assert.deepEqual(diff(undefined, undefined), []);
});

test('빈 문자열 속성(불리언) 생김 · 없어짐도 잡는다', () => {
  assert.deepEqual(diffProps({}, { disabled: '' }), { set: { disabled: '' }, remove: [] });
  assert.deepEqual(diffProps({ disabled: '' }, {}), { set: {}, remove: ['disabled'] });
  assert.equal(diffProps({ a: '' }, { a: '' }), null);
});

test('속성 값 "" 과 없음은 다르다 / 공백 하나 차이도 다르다', () => {
  assert.notEqual(diffProps({ class: '' }, {}), null);
  assert.deepEqual(diffProps({ class: 'a' }, { class: 'a ' }).set, { class: 'a ' });
});

test('이벤트 함수는 같은 함수면 그대로, 다른 함수면 set (Phase 2 대비)', () => {
  const f = () => {};
  assert.equal(diffProps({ onClick: f }, { onClick: f }), null);
  assert.deepEqual(diffProps({ onClick: f }, { onClick: () => {} }).set.onClick !== undefined, true);
});

test('hasOwnProperty 이름의 속성 · __proto__ 같은 이름도 안전하게 비교', () => {
  const a = { hasOwnProperty: 'x' };
  const b = { hasOwnProperty: 'y' };
  assert.deepEqual(diffProps(a, b).set, { hasOwnProperty: 'y' });
});

test('깊은 곳 변경은 깊은 경로로 나온다', () => {
  const a = h('div', null, h('section', null, h('ul', null, h('li', null, 'a'), h('li', null, 'b'))));
  const b = V.clone(a);
  b.children[0].children[0].children[1].children[0].props.nodeValue = 'B';
  assert.deepEqual(diff(a, b), [{ type: 'TEXT', path: [0, 0, 1, 0], value: 'B' }]);
});

// ───────── 알려진 한계 (key 없음): 문서에 적은 동작을 고정 ─────────

test('목록 맨 앞에 넣으면 같은 번호끼리 비교라 뒤 항목들이 TEXT 로 바뀌고 끝에 CREATE', () => {
  const a = h('ul', null, h('li', null, 'b'), h('li', null, 'c'));
  const b = h('ul', null, h('li', null, 'a'), h('li', null, 'b'), h('li', null, 'c'));
  assert.deepEqual(diff(a, b).map((p) => p.type), ['TEXT', 'TEXT', 'CREATE']);
});

test('diff 는 입력을 고치지 않는다', () => {
  const a = h('div', { a: '1' }, h('p', null, 'x'));
  const b = h('div', { a: '2' }, h('p', null, 'y'), h('i'));
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  diff(a, b);
  assert.equal(JSON.stringify(a), sa);
  assert.equal(JSON.stringify(b), sb);
});


// ───────── Codex 리뷰 ② 에서 나온 경우 ─────────

test('[C2-1] select value 는 option patch 뒤에 나온다 (값만 바뀌어도 · option 만 바뀌어도)', () => {
  const a = h('select', { value: 'a' }, h('option', { value: 'a' }, 'A'));
  const b = h('select', { value: 'b' }, h('option', { value: 'a' }, 'A'), h('option', { value: 'b' }, 'B'));
  const ps = diff(a, b);
  assert.deepEqual(ps.map((p) => p.type), ['CREATE', 'PROPS']);
  assert.deepEqual(ps[1].set, { value: 'b' });
  // value 는 그대로, option 순서만 바뀜 → value 를 다시 넣는다
  const c = h('select', { value: 'b' }, h('option', { value: 'b' }, 'B'), h('option', { value: 'a' }, 'A'));
  assert.equal(diff(b, c).at(-1).set.value, 'b');
  // 아무것도 안 바뀌면 아무 patch 도 없다
  assert.deepEqual(diff(b, V.clone(b)), []);
});

test('[C2-3] 이름이 __proto__ 인 속성도 set 에 들어간다', () => {
  const ps = diff(h('div'), h('div', JSON.parse('{"__proto__":"x"}')));
  assert.equal(ps.length, 1);
  assert.ok(Object.prototype.hasOwnProperty.call(ps[0].set, '__proto__'));
});
