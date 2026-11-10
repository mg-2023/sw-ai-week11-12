// update(M3) 테스트: setState → diff → patch · 예외 복구 · 폼 상태 유지
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { h } = require('../src/vdom');
const H = require('../src/hooks');
const P = require('../src/patch');
const { FunctionComponent } = require('../src/component');

/* 컴포넌트를 만들어 mount 하고 보고 목록과 함께 돌려주는 도우미 */
function start(fn) {
  const env = setup();
  const comp = new FunctionComponent(fn, {}, env.rootEl);
  const reports = [];
  comp.onCommit((r) => reports.push(r));
  comp.mount();
  return { ...env, comp, reports };
}

test('클릭 → 바뀐 글자 노드 외 요소는 같은 객체', () => {
  const { rootEl, window } = start(() => {
    const [c, setC] = H.useState(0);
    return h('div', null, h('p', null, 'n=', String(c)), h('button', { onClick: () => setC((x) => x + 1) }, '+'));
  });
  const div = rootEl.firstChild;
  const p = div.firstChild;
  const button = div.lastChild;
  button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(rootEl.textContent, 'n=1+');
  assert.equal(rootEl.firstChild, div);
  assert.equal(div.firstChild, p);
  assert.equal(div.lastChild, button);
});

test('같은 값 setState 는 보고하지 않는다 (NaN · +0/-0 포함)', () => {
  let set;
  const { reports } = start(() => { const [v, s] = H.useState(NaN); set = s; return h('p', null, String(v)); });
  set(NaN);
  assert.equal(reports.length, 1);
  set(0);
  assert.equal(reports.length, 2);
  set(0);
  assert.equal(reports.length, 2);
  set(-0);
  assert.equal(reports.length, 3);
});

test('함수형 업데이트 두 번 연달아 → +2', () => {
  let set;
  const { rootEl } = start(() => { const [n, s] = H.useState(0); set = s; return h('p', null, String(n)); });
  set((n) => n + 1);
  set((n) => n + 1);
  assert.equal(rootEl.textContent, '2');
});

test('연속 10번 setState → 값 10, 보고 10번', () => {
  let set;
  const { rootEl, reports } = start(() => { const [n, s] = H.useState(0); set = s; return h('p', null, String(n)); });
  for (let i = 0; i < 10; i += 1) set((n) => n + 1);
  assert.equal(rootEl.textContent, '10');
  assert.equal(reports.filter((r) => r.kind === 'update').length, 10);
});

test('렌더 중 setState 는 에러', () => {
  const { comp } = start(() => {
    const [n, s] = H.useState(0);
    if (n === 1) s(2);
    return h('p', null, String(n));
  });
  const setter = comp.hooks[0].setter;
  assert.throws(() => setter(1), /렌더 중/);
});

test('destroy 뒤 setState 는 무시한다', () => {
  let set;
  const { comp, rootEl, reports } = start(() => { const [n, s] = H.useState(0); set = s; return h('p', null, String(n)); });
  comp.destroy();
  assert.doesNotThrow(() => set(5));
  assert.equal(rootEl.textContent, '0');
  assert.equal(reports.length, 1);
});

test('렌더 예외 뒤 복구: 화면 그대로, 값 되돌림, 이어서 정상', () => {
  let set;
  const { comp, rootEl } = start(() => {
    const [n, s] = H.useState(2);
    set = s;
    if (n === 3) throw new Error('boom');
    return h('p', null, String(n));
  });
  const p = rootEl.firstChild;
  assert.throws(() => set(3), /boom/);
  assert.equal(rootEl.innerHTML, '<p>2</p>');
  assert.equal(rootEl.firstChild, p);
  assert.equal(comp.inspect().hooks[0].value, 2);
  set(4);
  assert.equal(rootEl.innerHTML, '<p>4</p>');
});

test('patch 실패 → 새 vdom 으로 다시 mount, recovered: true', () => {
  let set;
  const { rootEl, reports } = start(() => { const [n, s] = H.useState(0); set = s; return h('p', null, String(n)); });
  const original = P.applyPatches;
  P.applyPatches = () => { P.applyPatches = original; throw new Error('patch fail'); };
  try {
    set(1);
  } finally {
    P.applyPatches = original;
  }
  assert.equal(rootEl.innerHTML, '<p>1</p>');
  const last = reports[reports.length - 1];
  assert.equal(last.kind, 'update');
  assert.equal(last.recovered, true);
  set(2);
  assert.equal(rootEl.innerHTML, '<p>2</p>');
});

test('입력 중 다시 그려도 value 없는 input 은 입력값 유지, value 있는 input 은 상태값', () => {
  let set;
  const { rootEl } = start(() => {
    const [n, s] = H.useState(0);
    set = s;
    return h('div', null, h('input', { type: 'text' }), h('input', { type: 'text', value: 'S' + n }), h('i', null, String(n)));
  });
  const [free, ctrl] = rootEl.querySelectorAll('input');
  free.value = 'abc';
  ctrl.value = 'zzz';
  set(1);
  assert.equal(free.value, 'abc');
  assert.equal(ctrl.value, 'S1');
});

test('핸들러만 바뀐 렌더 → eventOnly >= 1, 새 핸들러만 1회', () => {
  const calls = [];
  let set;
  const { rootEl, window, reports } = start(() => {
    const [n, s] = H.useState(0);
    set = s;
    return h('button', { onClick: () => calls.push(n) }, 'b');
  });
  set(1);
  assert.ok(reports[reports.length - 1].eventOnly >= 1);
  rootEl.firstChild.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(calls, [1]);
});

test('update 보고: kind 와 패치 개수', () => {
  let set;
  const { reports } = start(() => { const [n, s] = H.useState(0); set = s; return h('p', null, String(n)); });
  set(1);
  const r = reports[reports.length - 1];
  assert.equal(r.kind, 'update');
  assert.equal(r.patches.TEXT, 1);
  assert.ok(r.compared >= 1);
});

test('onCommit 리스너가 던져도 값은 새 값 그대로, 이어서 새 값에서 계산', () => {
  let set;
  const { comp, rootEl } = start(() => { const [n, s] = H.useState(0); set = s; return h('p', null, String(n)); });
  const off = comp.onCommit(() => { throw new Error('listener boom'); });
  assert.throws(() => set(1), /listener boom/);
  off();
  assert.equal(rootEl.innerHTML, '<p>1</p>');
  assert.equal(comp.inspect().hooks[0].value, 1);
  set((n) => n + 1);
  assert.equal(rootEl.innerHTML, '<p>2</p>');
  assert.equal(comp.inspect().hooks[0].value, 2);
});
