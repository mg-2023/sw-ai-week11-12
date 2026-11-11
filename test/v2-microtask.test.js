// v2 마이크로태스크 배칭 엔진(engines/v2-microtask) 테스트: setter 는 예약만, 지금 코드가 끝나면 한 번 렌더한다
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { h } = require('../engines/v2-microtask/vdom');
const H = require('../engines/v2-microtask/hooks');
const { FunctionComponent } = require('../engines/v2-microtask/component');

/* 마이크로태스크 줄이 한 번 비워질 때까지 기다리는 함수 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/* 컴포넌트를 만들어 mount 하고, mount 보고를 뺀 커밋 보고 목록과 함께 돌려주는 도우미 */
function start(fn) {
  const env = setup();
  const comp = new FunctionComponent(fn, {}, env.rootEl);
  const reports = [];
  comp.onCommit((r) => reports.push(r));
  comp.mount();
  reports.length = 0;
  return { ...env, comp, reports };
}

test('setter 두 개 → 부른 직후엔 커밋 0, 마이크로태스크 뒤 커밋 1 · 두 값 반영', async () => {
  let setA; let setB;
  const { rootEl, reports } = start(() => {
    const [a, sa] = H.useState(0); const [b, sb] = H.useState(0);
    setA = sa; setB = sb;
    return h('p', null, `${a}/${b}`);
  });
  setA(1); setB(2);
  assert.equal(reports.length, 0);
  assert.equal(rootEl.textContent, '0/0');
  await tick();
  assert.equal(reports.length, 1);
  assert.equal(rootEl.textContent, '1/2');
});

test('함수형 +1 세 번 → +3, 커밋 1', async () => {
  let set;
  const { rootEl, reports } = start(() => { const [n, s] = H.useState(10); set = s; return h('p', null, String(n)); });
  set((n) => n + 1); set((n) => n + 1); set((n) => n + 1);
  await tick();
  assert.equal(rootEl.textContent, '13');
  assert.equal(reports.length, 1);
});

test('타이머 콜백 안 setter 두 개도 커밋 1 (엔진 이벤트 밖)', async () => {
  let setA; let setB;
  const { rootEl, reports } = start(() => {
    const [a, sa] = H.useState(0); const [b, sb] = H.useState(0);
    setA = sa; setB = sb;
    return h('p', null, `${a}/${b}`);
  });
  await new Promise((resolve) => setTimeout(() => { setA(1); setB(1); resolve(); }, 0));
  await tick();
  assert.equal(reports.length, 1);
  assert.equal(rootEl.textContent, '1/1');
});

test('클릭 핸들러 안 setter 두 개 → 클릭 직후 0, 뒤에 커밋 1', async () => {
  const { rootEl, window, reports } = start(() => {
    const [a, sa] = H.useState(0); const [b, sb] = H.useState(0);
    return h('button', { onClick: () => { sa(a + 1); sb(b + 1); } }, `${a}/${b}`);
  });
  rootEl.querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(reports.length, 0);
  await tick();
  assert.equal(reports.length, 1);
  assert.equal(rootEl.textContent, '1/1');
});

test('flushSync → 돌아온 직후 반영 · 커밋 1, 뒤에 추가 커밋 없음', async () => {
  let setA; let setB;
  const { rootEl, reports } = start(() => {
    const [a, sa] = H.useState(0); const [b, sb] = H.useState(0);
    setA = sa; setB = sb;
    return h('p', null, `${a}/${b}`);
  });
  H.flushSync(() => { setA(1); setB(2); });
  assert.equal(rootEl.textContent, '1/2');
  assert.equal(reports.length, 1);
  await tick();
  assert.equal(reports.length, 1);
});

test('flushSync 안 렌더 예외는 부른 쪽으로 던지고 값을 되돌린다', () => {
  let set;
  const { comp } = start(() => {
    const [n, s] = H.useState(0); set = s;
    if (n === 1) throw new Error('render boom');
    return h('p', null, String(n));
  });
  assert.throws(() => H.flushSync(() => set(1)), /render boom/);
  assert.equal(comp.inspect().hooks[0].value, 0);
});

test('커밋의 effect 가 setter → 후속 커밋 1 더, 최종값 반영', async () => {
  let set;
  const { rootEl, reports } = start(() => {
    const [n, s] = H.useState(0); set = s;
    H.useEffect(() => { if (n === 1) s(10); }, [n]);
    return h('p', null, String(n));
  });
  set(1);
  await tick();
  assert.equal(reports.length, 2);
  assert.equal(rootEl.textContent, '10');
});

test('예약된 렌더 예외 → 값을 되돌리고 오류를 보고한다 (부른 쪽은 이미 끝남)', async (t) => {
  const reported = [];
  t.mock.method(console, 'error', (err) => reported.push(err));
  let set;
  const { comp, rootEl } = start(() => {
    const [n, s] = H.useState(0); set = s;
    if (n === 1) throw new Error('render boom');
    return h('p', null, String(n));
  });
  set(1);
  await tick();
  assert.equal(comp.inspect().hooks[0].value, 0);
  assert.equal(rootEl.textContent, '0');
  assert.equal(reported.length, 1);
  assert.match(String(reported[0].message), /render boom/);
});

test('예약 뒤 destroy → 렌더하지 않는다', async () => {
  let set;
  const { comp, reports } = start(() => { const [n, s] = H.useState(0); set = s; return h('p', null, String(n)); });
  set(1);
  comp.destroy();
  await tick();
  assert.equal(reports.length, 0);
});

test('같은 값 setter 만 있으면 커밋 0, 제어 input 은 상태 값으로 돌아온다', async () => {
  const { rootEl, window, reports } = start(() => {
    const [v, setV] = H.useState('12');
    return h('input', { type: 'text', value: v, onInput: () => setV(v) });
  });
  const input = rootEl.querySelector('input');
  input.value = '12x';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick();
  assert.equal(reports.length, 0);
  assert.equal(input.value, '12');
});
