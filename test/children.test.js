// 자식 컴포넌트(M4) 테스트: props 전달 · children · 배열/null 반환 · 자식 Hook 금지 · Lifting State Up
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { h } = require('../src/vdom');
const { useState } = require('../src/hooks');
const { FunctionComponent, expand } = require('../src/component');

// 컴포넌트를 만들어 mount 한다
function mountComp(fn) {
  const { rootEl, window } = setup();
  const comp = new FunctionComponent(fn, {}, rootEl);
  comp.mount();
  return { comp, rootEl, window };
}

// 클릭 이벤트를 보낸다
function click(window, el) {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

test('자식은 props 와 빈 children 을 받는다', () => {
  let got;
  const Item = (p) => { got = p; return h('i', null, p.text); };
  mountComp(() => h('div', null, h(Item, { text: 'a' })));
  assert.deepEqual(got, { text: 'a', children: [] });
});

test('props 를 안 넘기면 { children: [] }', () => {
  let got;
  const Item = (p) => { got = p; return null; };
  mountComp(() => h('div', null, h(Item)));
  assert.deepEqual(got, { children: [] });
});

test('자식 vnode 가 props.children 으로 전달된다', () => {
  const Box = (p) => h('section', null, p.children);
  const { rootEl } = mountComp(() => h('div', null, h(Box, null, h('b', null, 'x'))));
  assert.equal(rootEl.innerHTML, '<div><section><b>x</b></section></div>');
});

test('자식 안 useState 는 에러', () => {
  const Bad = () => { useState(1); return null; };
  assert.throws(() => mountComp(() => h('div', null, h(Bad))), /자식/);
});

test('루트 Hook 은 자식 렌더 뒤에도 동작한다', () => {
  const Item = () => h('i', null, 'c');
  const { rootEl } = mountComp(() => {
    const [n] = useState(1);
    return h('div', null, h(Item), String(n));
  });
  assert.equal(rootEl.innerHTML, '<div><i>c</i>1</div>');
});

test('자식이 배열을 돌려주면 부모 자식 목록에 펼쳐진다', () => {
  const Two = () => [h('a', null, '1'), h('b', null, '2')];
  const { rootEl } = mountComp(() => h('div', null, h(Two), h('i', null, '3')));
  assert.equal(rootEl.innerHTML, '<div><a>1</a><b>2</b><i>3</i></div>');
});

test('자식이 null 이면 빠지고 글자 · 숫자는 텍스트가 된다', () => {
  const Nil = () => null;
  const Num = () => 7;
  const { rootEl } = mountComp(() => h('div', null, h(Nil), h(Num), h(() => 'hi')));
  assert.equal(rootEl.innerHTML, '<div>7hi</div>');
});

test('expand 결과에는 함수 type 이 없다', () => {
  const Item = () => h('i', null, 'x');
  const tree = expand(h('div', null, h(Item), h(Item)));
  const walk = (n) => { assert.equal(typeof n.type, 'string'); n.children.forEach(walk); };
  walk(tree);
});

test('함수 props 로 부모 상태를 바꾼다 (Lifting State Up)', () => {
  const Btn = (p) => h('button', { onClick: p.onInc }, '+');
  const { rootEl, window } = mountComp(() => {
    const [n, setN] = useState(0);
    return h('div', null, h('span', null, String(n)), h(Btn, { onInc: () => setN(n + 1) }));
  });
  click(window, rootEl.querySelector('button'));
  assert.equal(rootEl.querySelector('span').textContent, '1');
});

test('자식이 props 를 고쳐도 부모가 넘긴 객체는 그대로', () => {
  const given = { text: 'a' };
  const Item = (p) => { p.text = 'x'; return null; };
  mountComp(() => h('div', null, h(Item, given)));
  assert.equal(given.text, 'a');
});

test('가운데 삭제 뒤 핸들러가 맞는 항목을 가리킨다', () => {
  const Row = (p) => h('li', null, h('span', null, p.name), h('button', { onClick: p.onDel }, 'x'));
  const { rootEl, window } = mountComp(() => {
    const [items, setItems] = useState(['a', 'b', 'c']);
    return h('ul', null, items.map((name) =>
      h(Row, { name, onDel: () => setItems(items.filter((v) => v !== name)) })));
  });
  const names = () => [...rootEl.querySelectorAll('span')].map((s) => s.textContent);
  click(window, rootEl.querySelectorAll('button')[1]);
  assert.deepEqual(names(), ['a', 'c']);
  click(window, rootEl.querySelectorAll('button')[0]);
  assert.deepEqual(names(), ['c']);
});

test('루트 → 자식이 배열(2개 이상)을 돌려주면 mount 에서 에러', () => {
  const Two = () => [h('a'), h('b')];
  assert.throws(() => mountComp(() => h(Two)), /루트/);
});

test('루트 → 자식이 요소 하나인 배열을 돌려주면 그 요소가 그려진다', () => {
  const One = () => [h('a', null, 'x')];
  const { rootEl } = mountComp(() => h(One));
  assert.equal(rootEl.innerHTML, '<a>x</a>');
});

test('루트 → 자식이 빈 배열을 돌려주면 컨테이너가 빈다', () => {
  const None = () => [];
  const { rootEl } = mountComp(() => h(None));
  assert.equal(rootEl.innerHTML, '');
});

test('자식이 던진 뒤에도 Hook 금지 표시가 풀린다', () => {
  const Boom = () => { throw new Error('boom'); };
  assert.throws(() => expand(h(Boom)), /boom/);
  assert.throws(() => useState(1), /밖/);
  const { rootEl } = mountComp(() => { const [n] = useState(2); return h('p', null, String(n)); });
  assert.equal(rootEl.innerHTML, '<p>2</p>');
});

test('같은 vnode 를 두 번 expand 해도 vnode.props 는 그대로', () => {
  const Item = (p) => { p.text = 'x'; return null; };
  const vnode = h('div', null, h(Item, { text: 'a' }));
  expand(vnode);
  expand(vnode);
  assert.equal(vnode.children[0].props.text, 'a');
  assert.deepEqual(vnode.children[0].children, []);
});
