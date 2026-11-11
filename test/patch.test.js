// Patch · History 단위 테스트: diff 결과를 실제 DOM 에 적용
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const V = require('../engines/v1-batch/vdom');
const { diff } = require('../engines/v1-batch/diff');
const { applyPatches, findNode, mount, syncFormState } = require('../engines/v1-batch/patch');
const { createHistory } = require('../phase1/history');

const { h } = V;

/** old 로 그린 DOM 에 diff(old, new) 를 적용하고, 결과 DOM 을 다시 읽어 돌려준다 */
function patchAndRead(oldV, newV) {
  const { document } = setup();
  const el = V.render(oldV, document);
  document.body.appendChild(el);
  const out = applyPatches(el, diff(oldV, newV));
  return { el: out, read: V.domToVdom(out, false), document };
}

// ───────── 정상 ─────────

test('TEXT: 글자만 바꾸고 노드는 그대로 둔다 (같은 객체)', () => {
  const a = h('div', null, h('p', null, 'old'), h('p', null, 'keep'));
  const b = h('div', null, h('p', null, 'new'), h('p', null, 'keep'));
  const { document } = setup();
  const el = V.render(a, document);
  const textNode = el.firstChild.firstChild;
  const second = el.childNodes[1];
  applyPatches(el, diff(a, b));
  assert.equal(el.firstChild.firstChild, textNode, '텍스트 노드를 새로 만들지 않는다');
  assert.equal(textNode.nodeValue, 'new');
  assert.equal(el.childNodes[1], second, '안 바뀐 형제도 그대로');
});

test('PROPS: 바뀐 속성만, 없어진 속성은 지운다', () => {
  const a = h('p', { class: 'a', title: 't' }, 'x');
  const b = h('p', { class: 'b', lang: 'ko' }, 'x');
  const { read } = patchAndRead(a, b);
  assert.deepEqual(read, b);
});

test('CREATE · REMOVE: 뒤에 붙이고 뒤에서 뺀다', () => {
  const a = h('ul', null, h('li', null, '1'), h('li', null, '2'), h('li', null, '3'));
  const b = h('ul', null, h('li', null, '1'));
  assert.deepEqual(patchAndRead(a, b).read, b);
  assert.deepEqual(patchAndRead(b, a).read, a);
});

test('REPLACE: 태그가 바뀌면 그 노드만 바꾼다', () => {
  const a = h('div', null, h('p', null, 'x'), h('span', null, 'y'));
  const b = h('div', null, h('h2', null, 'x'), h('span', null, 'y'));
  const { document } = setup();
  const el = V.render(a, document);
  const span = el.childNodes[1];
  applyPatches(el, diff(a, b));
  assert.equal(el.firstChild.localName, 'h2');
  assert.equal(el.childNodes[1], span);
});

// ───────── 경계 ─────────

test('루트 자체가 REPLACE 되면 새 루트를 돌려주고 문서에서도 바뀐다', () => {
  const a = h('div', null, 'x');
  const b = h('section', null, 'x');
  const { el, document } = patchAndRead(a, b);
  assert.equal(el.localName, 'section');
  assert.equal(document.body.lastChild, el);
});

test('불리언 속성: 지우면 실제로 꺼진다 / checked 는 프로퍼티까지', () => {
  const a = h('div', null, h('button', { disabled: '' }, 'b'), h('input', { type: 'checkbox' }));
  const b = h('div', null, h('button', null, 'b'), h('input', { type: 'checkbox', checked: '' }));
  const { el } = patchAndRead(a, b);
  assert.equal(el.firstChild.disabled, false);
  assert.equal(el.childNodes[1].checked, true);
});

test('사용자가 바꾼 input 값도 Patch 가 value 로 덮는다', () => {
  const a = h('div', null, h('input', { value: 'a' }));
  const b = h('div', null, h('input', { value: 'b' }));
  const { document } = setup();
  const el = V.render(a, document);
  el.firstChild.value = '사용자가 친 값';
  applyPatches(el, diff(a, b));
  assert.equal(el.firstChild.value, 'b');
});

test('SVG 안에 새로 넣는 노드는 SVG 이름공간으로 만든다', () => {
  const a = h('div', null, h('svg', null, h('circle', { r: '1' })));
  const b = h('div', null, h('svg', null, h('circle', { r: '1' }), h('rect', { width: '2' })));
  const { el } = patchAndRead(a, b);
  assert.equal(el.firstChild.childNodes[1].namespaceURI, V.SVG_NS);
});

test('mount: 들여쓰기 · 주석이 있는 실제 영역을 VDOM 과 1:1 로 맞춘다', () => {
  const { rootEl, document } = setup('\n  <p>a</p>\n  <!-- c -->\n  <p>b</p>\n');
  const v = V.domToVdom(rootEl);
  assert.equal(rootEl.childNodes.length, 7, "텍스트·p·텍스트·주석·텍스트·p·텍스트");
  mount(rootEl, v);
  assert.equal(rootEl.childNodes.length, 2);
  assert.equal(document.getElementById('root'), rootEl, '루트 요소는 그대로');
  // 그 뒤 patch 가 정확한 노드를 고친다
  const b = V.clone(v);
  b.children[1].children[0].props.nodeValue = 'B';
  applyPatches(rootEl, diff(v, b));
  assert.equal(rootEl.childNodes[1].textContent, 'B');
});

test('patches 가 비면 DOM 을 건드리지 않는다', () => {
  const a = h('div', null, h('p', null, 'x'));
  const { document } = setup();
  const el = V.render(a, document);
  const before = el.firstChild;
  applyPatches(el, []);
  assert.equal(el.firstChild, before);
});

// ───────── 이상 ─────────

test('DOM 과 VDOM 이 어긋나면 알 수 있는 에러를 낸다', () => {
  const { document } = setup();
  const el = V.render(h('div'), document);
  assert.throws(() => findNode(el, [3]), /노드를 찾지 못했습니다/);
  assert.throws(() => applyPatches(el, [{ type: 'NOPE', path: [] }]), /모르는 patch/);
});

// ───────── 무작위: render(old) + patch == render(new) ─────────

function rand(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function randomTree(r, depth) {
  const tags = ['div', 'p', 'span', 'ul', 'li', 'b'];
  const attrs = ['class', 'id', 'title', 'data-x', 'hidden'];
  if (depth === 0 || r() < 0.25) return V.text(['a', 'b', ' ', 'c d', '한'][Math.floor(r() * 5)]);
  const props = {};
  for (const a of attrs) if (r() < 0.3) props[a] = r() < 0.2 ? '' : String(Math.floor(r() * 3));
  const n = Math.floor(r() * 4);
  const kids = [];
  for (let i = 0; i < n; i++) {
    const k = randomTree(r, depth - 1);
    // 붙은 텍스트 두 개는 DOM 에서 한 덩어리로 읽힐 수 있어 피한다 (render 는 두 개로 만들지만 실제 페이지 입력에서는 생기지 않음)
    if (V.isText(k) && kids.length && V.isText(kids[kids.length - 1])) continue;
    kids.push(k);
  }
  return { type: tags[Math.floor(r() * tags.length)], props, children: kids };
}

/** 붙은 텍스트 두 개를 빼서, 실제 HTML 에서 생길 수 있는 모양만 남긴다 */
function noAdjacentText(kids) {
  return kids.filter((k, i) => !(V.isText(k) && i > 0 && V.isText(kids[i - 1])));
}

test('무작위 트리 500쌍: patch 결과를 다시 읽으면 새 VDOM 과 같다', () => {
  const r = rand(42);
  for (let i = 0; i < 500; i++) {
    const a = { type: 'div', props: {}, children: noAdjacentText([randomTree(r, 4), randomTree(r, 4)]) };
    const b = { type: 'div', props: {}, children: noAdjacentText([randomTree(r, 4), randomTree(r, 4), randomTree(r, 3)].slice(0, 1 + Math.floor(r() * 3))) };
    const { document } = setup();
    const el = V.render(a, document);
    applyPatches(el, diff(a, b));
    // keepWhitespace=true: 공백 텍스트도 그대로 비교
    assert.deepEqual(V.domToVdom(el, true), b, `seed 42, ${i} 번째`);
  }
});

// ───────── History ─────────

test('History: push · back · forward, 끝에서는 null', () => {
  const v0 = h('div', null, '0');
  const v1 = h('div', null, '1');
  const v2 = h('div', null, '2');
  const hs = createHistory(v0);
  assert.equal(hs.canBack(), false);
  assert.equal(hs.back(), null);
  hs.push(v1);
  hs.push(v2);
  assert.deepEqual(hs.back(), v1);
  assert.deepEqual(hs.back(), v0);
  assert.equal(hs.back(), null);
  assert.deepEqual(hs.forward(), v1);
  assert.equal(hs.canForward(), true);
  assert.deepEqual(hs.forward(), v2);
  assert.equal(hs.forward(), null);
});

test('History: 뒤로 간 다음 push 하면 앞으로가기 기록을 버린다', () => {
  const hs = createHistory(h('i', null, '0'));
  hs.push(h('i', null, '1'));
  hs.push(h('i', null, '2'));
  hs.back();
  hs.back();
  hs.push(h('i', null, 'x'));
  assert.equal(hs.length, 2);
  assert.equal(hs.canForward(), false);
  assert.deepEqual(hs.current(), h('i', null, 'x'));
});

test('History: 넣은 객체 · 꺼낸 객체를 고쳐도 기록은 안 바뀐다', () => {
  const v = h('div', null, 'a');
  const hs = createHistory(v);
  v.children[0].props.nodeValue = 'mutated';
  const got = hs.current();
  assert.equal(got.children[0].props.nodeValue, 'a');
  got.props.x = '1';
  assert.deepEqual(hs.current().props, {});
});

test('History 를 오가며 patch 하면 실제 DOM 이 그 시점 VDOM 과 같다', () => {
  const { rootEl } = setup();
  const v0 = { type: 'div', props: { id: 'root' }, children: [h('p', null, 'a')] };
  const v1 = { type: 'div', props: { id: 'root' }, children: [h('p', { class: 'x' }, 'b'), h('ul', null, h('li', null, '1'))] };
  const v2 = { type: 'div', props: { id: 'root' }, children: [] };
  mount(rootEl, v0);
  const hs = createHistory(v0);
  let shown = v0;
  const go = (next) => { applyPatches(rootEl, diff(shown, next)); shown = next; };
  go(hs.push(v1));
  go(hs.push(v2));
  go(hs.back());
  assert.deepEqual(V.domToVdom(rootEl), v1);
  go(hs.back());
  assert.deepEqual(V.domToVdom(rootEl), v0);
  go(hs.forward());
  go(hs.forward());
  assert.deepEqual(V.domToVdom(rootEl), v2);
});

// ───────── Codex 리뷰 ② · ③ 에서 나온 경우 ─────────

test('[C2-1/C3-1] select: option 이 생긴 뒤 value 를 고른다', () => {
  const a = h('div', null, h('select', { value: 'a' }, h('option', { value: 'a' }, 'A')));
  const b = h('div', null, h('select', { value: 'b' }, h('option', { value: 'a' }, 'A'), h('option', { value: 'b' }, 'B')));
  assert.equal(patchAndRead(a, b).el.firstChild.value, 'b');
});

test('[C2-2] 루트 CREATE: rootEl 없이 doc 만으로 새 루트를 만들어 돌려준다 / 루트 REMOVE 는 null', () => {
  const { document } = setup();
  const v = h('div', null, 'X');
  const el = applyPatches(null, diff(undefined, v), document);
  assert.equal(el.outerHTML, '<div>X</div>');
  document.body.appendChild(el);
  assert.equal(applyPatches(el, diff(v, undefined)), null);
  assert.equal(el.parentNode, null, '문서에서도 빠진다');
});

test('[C3-2] <template> 안에서 REPLACE 하면 HTML 이름공간으로 만든다', () => {
  const { document } = setup();
  const a = h('div', null, h('template', null, h('svg')));
  const b = h('div', null, h('template', null, h('p', null, 'x')));
  const el = V.render(a, document);
  applyPatches(el, diff(a, b));
  assert.equal(el.firstChild.content.firstChild.namespaceURI, V.HTML_NS);
});

test('[C3-3] 사용자가 입력한 textarea 도 Patch · 뒤로가기에 따라 화면 값이 바뀐다', () => {
  const { document } = setup();
  const a = h('div', null, h('textarea', null, 'a'));
  const b = h('div', null, h('textarea', null, 'b'));
  const el = V.render(a, document);
  el.firstChild.value = 'typed';
  applyPatches(el, diff(a, b));
  assert.equal(el.firstChild.value, 'b');
  applyPatches(el, diff(b, a));
  assert.equal(el.firstChild.value, 'a');
});

test('테스트 영역 입력의 <script> · on…="문자열" 은 빠진다 (htmlToVdom 기본)', () => {
  const { document } = setup();
  const root = h('div', { id: 'actual' });
  const v = V.htmlToVdom('<p onclick="x()">a<script>evil()</script></p><script>y()</script>', root, document);
  assert.deepEqual(v.children, [h('p', null, 'a')]);
});

// ───────── Codex 리뷰 ④ 에서 나온 경우 ─────────

test('[C4-2] syncFormState: 실제 영역에서 손으로 바꾼 입력값 · 체크를 VDOM 대로 되돌린다 (DOM 변경 없이)', () => {
  const { document, window } = setup();
  const v = h('div', null,
    h('input', { value: 'a' }),
    h('input', { type: 'checkbox', checked: '' }),
    h('textarea', null, 't'),
    h('select', { value: 'b' }, h('option', { value: 'a' }, 'A'), h('option', { value: 'b' }, 'B')));
  const el = V.render(v, document);
  document.body.appendChild(el);
  el.childNodes[0].value = 'manual';
  el.childNodes[1].checked = false;
  el.childNodes[2].value = 'typed';
  el.childNodes[3].value = 'a';
  const mo = new window.MutationObserver(() => {});
  mo.observe(el, { subtree: true, attributes: true, childList: true, characterData: true });
  syncFormState(el, v);
  assert.equal(el.childNodes[0].value, 'a');
  assert.equal(el.childNodes[1].checked, true);
  assert.equal(el.childNodes[2].value, 't');
  assert.equal(el.childNodes[3].value, 'b');
  assert.equal(mo.takeRecords().length, 0, '속성 · 노드는 건드리지 않는다');
});

test('[C4-1] setAttribute 가 거부하는 속성 이름은 예외 → 페이지가 잡아서 되돌릴 수 있다', () => {
  const { document } = setup();
  const a = h('div', null, h('p', null, 'before'));
  const b = h('div', null, h('p', null, 'after'), h('div', JSON.parse('{"a@":"x"}')));
  const el = V.render(a, document);
  assert.throws(() => applyPatches(el, diff(a, b)));
  // 앱은 이때 mount(el, a) 로 되돌린다
  mount(el, a);
  assert.deepEqual(V.domToVdom(el), a);
});
