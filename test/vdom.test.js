// 변환 모듈 단위 테스트: DOM → VDOM, VDOM → DOM, VDOM → HTML
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const V = require('../src/vdom');

const { h, text } = V;

// ───────── 정상 ─────────

test('요소 · 속성 · 텍스트를 type/props/children 으로 읽는다', () => {
  const { rootEl } = setup('<p class="x" id="a">hi <b>yo</b></p>');
  const v = V.domToVdom(rootEl.firstChild);
  assert.deepEqual(v, h('p', { class: 'x', id: 'a' }, text('hi '), h('b', null, text('yo'))));
});

test('텍스트 노드도 요소와 같은 세 칸 모양이다', () => {
  const t = text('hi');
  assert.deepEqual(Object.keys(t).sort(), ['children', 'props', 'type']);
  assert.equal(t.type, '#text');
  assert.equal(t.props.nodeValue, 'hi');
  assert.deepEqual(t.children, []);
});

test('태그 이름은 소문자로 적는다 (tagName 은 대문자)', () => {
  const { rootEl } = setup('<DIV><SPAN>a</SPAN></DIV>');
  const v = V.domToVdom(rootEl.firstChild);
  assert.equal(v.type, 'div');
  assert.equal(v.children[0].type, 'span');
});

test('render → domToVdom 을 거치면 원래 VDOM 이 그대로 나온다 (왕복)', () => {
  const { document } = setup();
  const v = h('ul', { class: 'list' }, h('li', { 'data-id': '1' }, 'a'), h('li', null, 'b ', h('em', null, 'c')));
  const el = V.render(v, document);
  assert.deepEqual(V.domToVdom(el), v);
});

// ───────── 경계 ─────────

test('들여쓰기 공백(줄바꿈 포함)은 버리고, 같은 줄의 공백 한 칸은 남긴다', () => {
  const { rootEl } = setup('<ul>\n  <li>a</li>\n  <li><b>x</b> <i>y</i></li>\n</ul>');
  const v = V.domToVdom(rootEl.firstChild);
  assert.equal(v.children.length, 2, '들여쓰기 텍스트 노드 3개가 빠진다');
  const li2 = v.children[1];
  assert.deepEqual(li2.children.map((c) => c.type), ['b', '#text', 'i']);
  assert.equal(li2.children[1].props.nodeValue, ' ');
});

test('글자 앞뒤 공백은 지우지 않는다 (공백만 있는 노드만 판단)', () => {
  const { rootEl } = setup('<p>\n  hello  \n</p>');
  const v = V.domToVdom(rootEl.firstChild);
  assert.equal(v.children[0].props.nodeValue, '\n  hello  \n');
});

test('<pre> 안의 공백 · 줄바꿈은 그대로 남긴다', () => {
  const { rootEl } = setup('<pre><b>a</b>\n  <i>b</i>\n</pre>');
  const v = V.domToVdom(rootEl.firstChild);
  assert.deepEqual(v.children.map((c) => c.type), ['b', '#text', 'i', '#text']);
});

test('주석은 버린다', () => {
  const { rootEl } = setup('<ul><li>a</li><!-- memo --><li>b</li></ul>');
  const v = V.domToVdom(rootEl.firstChild);
  assert.equal(v.children.length, 2);
});

test('주석 노드 자체를 넘기면 null', () => {
  const { document } = setup();
  assert.equal(V.domToVdom(document.createComment('x')), null);
});

test('빈 요소 · 빈 문자열 속성(불리언 속성) · 자식 없는 루트', () => {
  const { rootEl } = setup('<input disabled><div></div>');
  const v = V.childrenToVdom(rootEl);
  assert.deepEqual(v[0], h('input', { disabled: '' }));
  assert.deepEqual(v[1].children, []);
  assert.deepEqual(V.htmlToChildren('', rootEl.ownerDocument), []);
});

test('특수 문자 · 한글 · 이모지 · &nbsp; 텍스트를 그대로 읽는다', () => {
  const { rootEl } = setup('<p>&lt;b&gt; &amp; 한글 😀&nbsp;</p>');
  const v = V.domToVdom(rootEl.firstChild);
  assert.equal(v.children[0].props.nodeValue, '<b> & 한글 😀 ');
});

test('SVG 는 대소문자를 지키고, render 하면 SVG 이름공간으로 만든다', () => {
  const { rootEl, document } = setup('<svg viewBox="0 0 10 10"><linearGradient id="g"></linearGradient><circle r="1"></circle></svg>');
  const v = V.domToVdom(rootEl.firstChild);
  assert.equal(v.children[0].type, 'linearGradient');
  const el = V.render(v, document);
  assert.equal(el.namespaceURI, V.SVG_NS);
  assert.equal(el.childNodes[1].namespaceURI, V.SVG_NS);
});

test('foreignObject 안은 다시 HTML 이름공간', () => {
  const { document } = setup();
  const el = V.render(h('svg', null, h('foreignObject', null, h('div', null, 'x'))), document);
  assert.equal(el.firstChild.firstChild.namespaceURI, V.HTML_NS);
});

test('table 조각도 htmlToChildren 으로 읽힌다 (template 파싱)', () => {
  const { document } = setup();
  const kids = V.htmlToChildren('<tr><td>1</td></tr>', document);
  assert.equal(kids[0].type, 'tr');
});

// ───────── 이상 (잘못된 입력 · 위험한 입력) ─────────

test('닫히지 않은 HTML 은 브라우저 파서가 고친 모양을 따른다', () => {
  const { document } = setup();
  const kids = V.htmlToChildren('<p>a<p>b', document);
  assert.deepEqual(kids.map((k) => k.type), ['p', 'p']);
});

test('htmlToChildren 은 스크립트 · onerror 를 실행하지 않는다', () => {
  const { document, window } = setup();
  window.__hit = false;
  const kids = V.htmlToChildren('<img src="x" onerror="window.__hit=true"><script>window.__hit=true</script>', document);
  assert.equal(window.__hit, false);
  assert.equal(kids[0].props.onerror, 'window.__hit=true', '속성 글자는 그대로 읽는다');
});

test('render 는 텍스트를 HTML 로 해석하지 않는다 (innerHTML 미사용)', () => {
  const { document } = setup();
  const el = V.render(h('p', null, '<img src=x onerror=alert(1)>'), document);
  assert.equal(el.childNodes.length, 1);
  assert.equal(el.firstChild.nodeType, 3);
});

// ───────── setProp: 속성 vs 프로퍼티 ─────────

test('setProp: false · null 이면 속성을 지운다 (setAttribute("disabled","false") 함정)', () => {
  const { document } = setup();
  const btn = document.createElement('button');
  V.setProp(btn, 'disabled', '');
  assert.equal(btn.disabled, true);
  V.setProp(btn, 'disabled', false);
  assert.equal(btn.hasAttribute('disabled'), false);
  assert.equal(btn.disabled, false);
});

test('setProp: checked · value 는 프로퍼티(지금 상태)까지 맞춘다', () => {
  const { document } = setup();
  const box = document.createElement('input');
  box.type = 'checkbox';
  V.setProp(box, 'checked', '');
  assert.equal(box.checked, true);
  box.checked = false; // 사용자가 손으로 끔
  V.setProp(box, 'checked', '');
  assert.equal(box.checked, true, '속성만 다시 넣으면 안 켜지므로 프로퍼티도 넣는다');
  V.setProp(box, 'checked', null);
  assert.equal(box.checked, false);

  const inp = document.createElement('input');
  inp.value = '사용자 입력';
  V.setProp(inp, 'value', 'b');
  assert.equal(inp.value, 'b');
  assert.equal(inp.getAttribute('value'), 'b');
});

test('setProp: on… 함수는 이벤트로 붙이고, 바꾸면 옛 함수를 떼어 낸다 (Phase 2 대비)', () => {
  const { document, window } = setup();
  const btn = document.createElement('button');
  const calls = [];
  V.setProp(btn, 'onClick', () => calls.push('a'));
  btn.dispatchEvent(new window.Event('click'));
  V.setProp(btn, 'onClick', () => calls.push('b'));
  btn.dispatchEvent(new window.Event('click'));
  V.setProp(btn, 'onClick', null);
  btn.dispatchEvent(new window.Event('click'));
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(btn.hasAttribute('onclick'), false);
});

// ───────── toHtml: 테스트 영역에 보여 줄 HTML ─────────

test('toHtml → htmlToChildren 왕복이 같은 VDOM 을 준다 (들여쓰기를 넣어도)', () => {
  const { document } = setup();
  const kids = [
    h('h1', { class: 't' }, '제목 & <태그>'),
    h('ul', null, h('li', null, 'a'), h('li', null, h('b', null, 'x'), ' ', h('i', null, 'y'))),
    h('input', { type: 'checkbox', checked: '' }),
    h('p', { title: 'a "q"' }, 'hi ', h('b', null, 'yo')),
    h('pre', null, '\n  code\n'),
    h('textarea', null, 'line1\nline2'),
    h('style', null, 'p > b { color: red }'),
  ];
  const html = V.toHtml(kids);
  assert.deepEqual(V.htmlToChildren(html, document), kids);
  assert.match(html, /\n  <li>/, '요소만 있는 자식은 들여쓴다');
});

test('clone 은 깊은 복사다', () => {
  const v = h('div', { a: '1' }, h('p', null, 'x'));
  const c = V.clone(v);
  c.children[0].children[0].props.nodeValue = 'changed';
  c.props.a = '2';
  assert.equal(v.children[0].children[0].props.nodeValue, 'x');
  assert.equal(v.props.a, '1');
});
