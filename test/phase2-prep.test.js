// Phase 2 준비: h() 의 true 거르기, diff 측정 인자, syncFormState 의 controlledOnly 옵션 테스트
const test = require('node:test');
const assert = require('node:assert');
const { setup } = require('./helpers.js');
const V = require('../src/vdom.js');
const { diff } = require('../src/diff.js');
const { syncFormState } = require('../src/patch.js');

test('h() 는 true 를 자식에서 버린다', () => {
  const p = V.h('p', null, true, 'a');
  assert.strictEqual(p.children.length, 1);
  assert.strictEqual(p.children[0].props.nodeValue, 'a');
});

test('diff 의 stats.compared 는 비교한 노드 수를 센다', () => {
  const make = () => V.h('div', null, V.h('b', null), V.h('i', null));
  const s = { compared: 0, eventOnly: 0 };
  diff(make(), make(), s);
  assert.strictEqual(s.compared, 3);
});

test('핸들러만 다른 diff 는 eventOnly 를 1 올린다', () => {
  const a = V.h('button', { onclick: () => 1 });
  const b = V.h('button', { onclick: () => 2 });
  const s = { compared: 0, eventOnly: 0 };
  const patches = diff(a, b, s);
  assert.strictEqual(patches.length, 1);
  assert.strictEqual(patches[0].type, 'PROPS');
  assert.strictEqual(s.eventOnly, 1);
});

test('class 도 다르면 eventOnly 는 0 이다', () => {
  const a = V.h('button', { onclick: () => 1, class: 'a' });
  const b = V.h('button', { onclick: () => 2, class: 'b' });
  const s = { compared: 0, eventOnly: 0 };
  diff(a, b, s);
  assert.strictEqual(s.eventOnly, 0);
});

test('stats 없이 부른 diff 결과는 stats 를 줬을 때와 같다', () => {
  const a = V.h('div', { class: 'x' }, V.h('b', null, 'a'));
  const b = V.h('div', { class: 'y' }, V.h('b', null, 'b'), V.h('i', null));
  const s = { compared: 0, eventOnly: 0 };
  assert.deepStrictEqual(diff(a, b), diff(a, b, s));
});

test('controlledOnly: value 없는 input 의 입력값을 건드리지 않는다', () => {
  const { document, rootEl } = setup();
  const v = V.h('input', { type: 'text' });
  const el = V.render(v, document);
  rootEl.appendChild(el);
  el.value = 'typed';
  syncFormState(el, v, { controlledOnly: true });
  assert.strictEqual(el.value, 'typed');
});

test('controlledOnly: textarea 는 value prop 값이 된다', () => {
  const { document, rootEl } = setup();
  const v = V.h('textarea', { value: 'hi' });
  const el = V.render(v, document);
  rootEl.appendChild(el);
  el.value = 'other';
  syncFormState(el, v, { controlledOnly: true });
  assert.strictEqual(el.value, 'hi');
});

test('controlledOnly: 값이 같으면 value 를 대입하지 않는다', () => {
  const { window, document, rootEl } = setup();
  const v = V.h('input', { type: 'text', value: 'same' });
  const el = V.render(v, document);
  rootEl.appendChild(el);
  const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  let count = 0;
  Object.defineProperty(el, 'value', {
    configurable: true,
    get() { return desc.get.call(this); },
    set(x) { count += 1; desc.set.call(this, x); },
  });
  syncFormState(el, v, { controlledOnly: true });
  assert.strictEqual(count, 0);
});

test('controlledOnly: checked 없는 체크박스는 그대로, checked:false 는 해제', () => {
  const { document, rootEl } = setup();
  const free = V.h('input', { type: 'checkbox' });
  const a = V.render(free, document);
  rootEl.appendChild(a);
  a.checked = true;
  syncFormState(a, free, { controlledOnly: true });
  assert.strictEqual(a.checked, true);
  const ctl = V.h('input', { type: 'checkbox', checked: false });
  syncFormState(a, ctl, { controlledOnly: true });
  assert.strictEqual(a.checked, false);
});
