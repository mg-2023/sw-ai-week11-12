// batch(M-배칭) 테스트: batch 안 setter 를 모아 한 번만 갱신 · 예외 계약 · 커밋 뒤 effect 연쇄
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { h } = require('../src/vdom');
const H = require('../src/hooks');
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

test('batch 안 setter 두 개 → 커밋 1회, 두 값 모두 반영', () => {
  let setA;
  let setB;
  const { rootEl, reports } = start(() => {
    const [a, sa] = H.useState(0);
    const [b, sb] = H.useState('');
    setA = sa;
    setB = sb;
    return h('p', null, a + '/' + b);
  });
  H.batch(() => { setA(1); setB('x'); });
  assert.equal(rootEl.textContent, '1/x');
  assert.equal(reports.length, 2);
});

test('batch 안 n => n + 1 세 번 → 최종 +3, 커밋 1회', () => {
  let set;
  const { rootEl, reports } = start(() => { const [n, s] = H.useState(0); set = s; return h('p', null, String(n)); });
  H.batch(() => { set((n) => n + 1); set((n) => n + 1); set((n) => n + 1); });
  assert.equal(rootEl.textContent, '3');
  assert.equal(reports.length, 2);
});

test('batch 밖 setter 는 지금처럼 바로 갱신 (setter 하나당 커밋 1회)', () => {
  let setA;
  let setB;
  const { rootEl, reports } = start(() => {
    const [a, sa] = H.useState(0);
    const [b, sb] = H.useState(0);
    setA = sa;
    setB = sb;
    return h('p', null, a + '/' + b);
  });
  setA(1);
  setB(2);
  assert.equal(rootEl.textContent, '1/2');
  assert.equal(reports.length, 3);
});

test('중첩 batch → 바깥이 끝날 때 커밋 1회', () => {
  let setA;
  let setB;
  const { rootEl, reports } = start(() => {
    const [a, sa] = H.useState(0);
    const [b, sb] = H.useState(0);
    setA = sa;
    setB = sb;
    return h('p', null, a + '/' + b);
  });
  H.batch(() => {
    H.batch(() => { setA(1); });
    assert.equal(reports.length, 1);
    setB(2);
  });
  assert.equal(rootEl.textContent, '1/2');
  assert.equal(reports.length, 2);
});

test('batch 안 setter 뒤 예외 → assert.throws 로 같은 예외, 값 반영 · 커밋 1회, 그 뒤 batch 가 다시 정상 동작', () => {
  let set;
  const { rootEl, reports } = start(() => { const [n, s] = H.useState(0); set = s; return h('p', null, String(n)); });
  const boom = new Error('handler boom');
  assert.throws(() => H.batch(() => { set(1); throw boom; }), (err) => err === boom);
  assert.equal(rootEl.textContent, '1');
  assert.equal(reports.length, 2);
  H.batch(() => { set(2); set(3); });
  assert.equal(rootEl.textContent, '3');
  assert.equal(reports.length, 3);
});

test('batch 커밋의 effect 가 setter → 커밋 2회, 최종값 반영', () => {
  let set;
  const { rootEl, reports } = start(() => {
    const [n, setN] = H.useState(0);
    set = setN;
    H.useEffect(() => { if (n === 1) setN(10); }, [n]);
    return h('p', null, String(n));
  });
  H.batch(() => { set(1); });
  assert.equal(rootEl.textContent, '10');
  assert.equal(reports.length, 3);
  assert.deepEqual(reports.map((r) => r.kind), ['mount', 'update', 'update']);
});

test('batch 커밋의 effect 가 끝없이 setter → update loop 예외, 값은 되돌림', () => {
  let set;
  const { comp, rootEl } = start(() => {
    const [n, setN] = H.useState(0);
    set = setN;
    H.useEffect(() => { if (n >= 1) setN(n + 1); });
    return h('p', null, String(n));
  });
  assert.throws(() => H.batch(() => { set(1); }), /update loop/);
  assert.equal(comp.pendingUpdate, false);
  assert.equal(rootEl.textContent, String(comp.inspect().hooks[0].value));
  assert.doesNotThrow(() => set(0));
  assert.equal(rootEl.textContent, '0');
});

test('batch 안 렌더 예외 → 예외가 나오고 batch 안에서 바꾼 값이 모두 되돌려짐', () => {
  let setA;
  let setB;
  const { comp, rootEl } = start(() => {
    const [a, sa] = H.useState(0);
    const [b, sb] = H.useState(0);
    setA = sa;
    setB = sb;
    if (a === 1) throw new Error('render boom');
    return h('p', null, a + '/' + b);
  });
  assert.throws(() => H.batch(() => { setA(1); setB(2); }), /render boom/);
  assert.deepEqual(comp.inspect().hooks.map((x) => x.value), [0, 0]);
  assert.equal(rootEl.textContent, '0/0');
});

/* 값이 1 이 되면 렌더가 던지는 컴포넌트를 만들어 setter 와 함께 돌려주는 도우미 */
function startThrowing(label) {
  const box = {};
  const env = start(() => {
    const [n, s] = H.useState(0);
    box.set = s;
    if (n === 1) throw new Error(label);
    return h('p', null, String(n));
  });
  return { ...env, set: box.set };
}

test('batch 안 핸들러도 던지고 컴포넌트 둘의 렌더도 던지면 → 핸들러 예외가 이기고 heldErrors 에 덧붙임, 값은 모두 되돌림', () => {
  const a = startThrowing('render A');
  const b = startThrowing('render B');
  const earlier = new Error('earlier');
  const boom = new Error('handler boom');
  boom.heldErrors = [earlier];
  assert.throws(() => H.batch(() => { a.set(1); b.set(1); throw boom; }), (err) => err === boom);
  assert.equal(boom.heldErrors.length, 3);
  assert.equal(boom.heldErrors[0], earlier);
  assert.deepEqual(boom.heldErrors.slice(1).map((e) => e.message), ['render A', 'render B']);
  assert.deepEqual(a.comp.inspect().hooks.map((x) => x.value), [0]);
  assert.deepEqual(b.comp.inspect().hooks.map((x) => x.value), [0]);
});

test('batch 핸들러는 정상인데 컴포넌트 둘의 렌더가 던지면 → AggregateError 2개, 값은 모두 되돌림', () => {
  const a = startThrowing('render A');
  const b = startThrowing('render B');
  assert.throws(
    () => H.batch(() => { a.set(1); b.set(1); }),
    (err) => err instanceof AggregateError && err.errors.length === 2,
  );
  assert.deepEqual(a.comp.inspect().hooks.map((x) => x.value), [0]);
  assert.deepEqual(b.comp.inspect().hooks.map((x) => x.value), [0]);
});
