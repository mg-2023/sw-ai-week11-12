// FunctionComponent(M1) 단위 테스트: mount · expand · 측정 보고 · inspect
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { h } = require('../engines/v1-batch/vdom');
const { FunctionComponent, expand } = require('../engines/v1-batch/component');

const PATCH_KEYS = ['CREATE', 'REMOVE', 'REPLACE', 'TEXT', 'PROPS'];

test('mount: 함수를 펼쳐 컨테이너에 처음 그린다', () => {
  const { rootEl } = setup();
  new FunctionComponent(() => h('p', { class: 'a' }, '안녕'), {}, rootEl).mount();
  assert.equal(rootEl.innerHTML, '<p class="a">안녕</p>');
});

test('mount: null 을 돌려주면 비어 있다', () => {
  const { rootEl } = setup('<b>old</b>');
  new FunctionComponent(() => null, {}, rootEl).mount();
  assert.equal(rootEl.innerHTML, '');
});

test('mount: 글자와 숫자는 글자 노드 하나', () => {
  for (const [value, expected] of [['hi', 'hi'], [3, '3']]) {
    const { rootEl } = setup();
    new FunctionComponent(() => value, {}, rootEl).mount();
    assert.equal(rootEl.childNodes.length, 1);
    assert.equal(rootEl.firstChild.nodeType, 3);
    assert.equal(rootEl.textContent, expected);
  }
});

test('mount: 배열을 돌려주는 루트는 에러', () => {
  const { rootEl } = setup();
  const c = new FunctionComponent(() => [h('p'), h('p')], {}, rootEl);
  assert.throws(() => c.mount(), /배열/);
});

test('생성자: container 가 없으면 에러', () => {
  assert.throws(() => new FunctionComponent(() => null, {}), /container/);
});

test('mount: 두 번 부르면 에러', () => {
  const { rootEl } = setup();
  const c = new FunctionComponent(() => h('p'), {}, rootEl);
  c.mount();
  assert.throws(() => c.mount(), /이미/);
});

test('onCommit: kind mount, patches 다섯 키가 숫자, ms >= 0 으로 한 번 불린다', () => {
  const { rootEl } = setup();
  const reports = [];
  const c = new FunctionComponent(() => h('p', null, 'x'), {}, rootEl);
  c.onCommit((r) => reports.push(r));
  c.mount();
  assert.equal(reports.length, 1);
  const r = reports[0];
  assert.equal(r.kind, 'mount');
  assert.deepEqual(Object.keys(r.patches).sort(), [...PATCH_KEYS].sort());
  for (const k of PATCH_KEYS) assert.equal(typeof r.patches[k], 'number');
  assert.ok(r.ms >= 0);
  assert.equal(r.compared, 0);
  assert.equal(r.hookCount, 0);
  assert.equal(r.recovered, false);
});

test('onCommit: 돌려받은 함수로 구독을 끊을 수 있다', () => {
  const { rootEl } = setup();
  let n = 0;
  const c = new FunctionComponent(() => h('p'), {}, rootEl);
  c.onCommit(() => { n += 1; })();
  c.mount();
  assert.equal(n, 0);
});

test('inspect: vdom 을 고쳐도 내부 vdom 은 그대로 (복사본)', () => {
  const { rootEl } = setup();
  const c = new FunctionComponent(() => h('p', null, 'x'), {}, rootEl);
  c.mount();
  const first = c.inspect();
  assert.equal(first.vdom.type, 'div');
  assert.deepEqual(first.hooks, []);
  first.vdom.children[0].type = 'span';
  first.vdom.children.length = 0;
  assert.equal(c.inspect().vdom.children[0].type, 'p');
});

test('inspect: 트리가 null 이면 children 은 빈 배열', () => {
  const { rootEl } = setup();
  const c = new FunctionComponent(() => null, {}, rootEl);
  c.mount();
  assert.deepEqual(c.inspect().vdom, { type: 'div', props: {}, children: [] });
});

test('expand: null · false · true 를 빼고 글자 \'x\' 하나만 남긴다', () => {
  const out = expand(h('ul', null, null, false, true, 'x'));
  assert.equal(out.type, 'ul');
  assert.equal(out.children.length, 1);
  assert.equal(out.children[0].props.nodeValue, 'x');
});

test('expand: null 은 null', () => {
  assert.equal(expand(null), null);
});
