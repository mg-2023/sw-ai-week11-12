// useEffect(M6) 테스트: 실행 시점 · deps · cleanup 순서 · 커밋 중 setState · destroy · 예외 모으기
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { h } = require('../src/vdom');
const H = require('../src/hooks');
const { FunctionComponent } = require('../src/component');

/* 컴포넌트를 만들어 mount 하고 보고 목록과 함께 돌려주는 도우미 */
function start(fn, onEnv) {
  const env = setup();
  if (onEnv) onEnv(env.rootEl);
  const comp = new FunctionComponent(fn, {}, env.rootEl);
  const reports = [];
  comp.onCommit((r) => reports.push(r));
  comp.mount();
  return { ...env, comp, reports };
}

test('effect 실행 시점에 DOM 이 이미 새 값이다', () => {
  const seen = [];
  let set;
  let root;
  const { comp } = start(() => {
    const [n, setN] = H.useState(0);
    set = setN;
    H.useEffect(() => { seen.push(root.textContent); });
    return h('p', null, 'n=', String(n));
  }, (el) => { root = el; });
  set(1);
  assert.deepEqual(seen, ['n=0', 'n=1']);
  assert.ok(comp);
});

test('deps 없음 → 매 렌더마다 실행', () => {
  let runs = 0;
  let set;
  start(() => {
    const [n, setN] = H.useState(0);
    set = setN;
    H.useEffect(() => { runs += 1; });
    return h('p', null, String(n));
  });
  set(1);
  set(2);
  assert.equal(runs, 3);
});

test('deps [] → mount 때 한 번만', () => {
  let runs = 0;
  let set;
  start(() => {
    const [n, setN] = H.useState(0);
    set = setN;
    H.useEffect(() => { runs += 1; }, []);
    return h('p', null, String(n));
  });
  set(1);
  set(2);
  assert.equal(runs, 1);
});

test('deps 가 바뀔 때만 실행', () => {
  const seen = [];
  let setA;
  let setB;
  start(() => {
    const [a, sa] = H.useState(0);
    const [b, sb] = H.useState(0);
    setA = sa;
    setB = sb;
    H.useEffect(() => { seen.push(a); }, [a]);
    return h('p', null, String(a), String(b));
  });
  setB(1);
  setA(1);
  setB(2);
  assert.deepEqual(seen, [0, 1]);
});

test('순서: 이전 cleanup → 새 effect', () => {
  const log = [];
  let set;
  start(() => {
    const [n, setN] = H.useState(0);
    set = setN;
    H.useEffect(() => {
      log.push('run' + n);
      return () => log.push('clean' + n);
    });
    return h('p', null, String(n));
  });
  set(1);
  set(2);
  assert.deepEqual(log, ['run0', 'clean0', 'run1', 'clean1', 'run2']);
});

test('effect 는 훅 순서대로 실행한다', () => {
  const log = [];
  start(() => {
    H.useEffect(() => { log.push('a'); });
    H.useEffect(() => { log.push('b'); });
    return null;
  });
  assert.deepEqual(log, ['a', 'b']);
});

test('cleanup 이 함수가 아니면 무시한다', () => {
  let set;
  start(() => {
    const [n, setN] = H.useState(0);
    set = setN;
    H.useEffect(() => 42);
    return h('p', null, String(n));
  });
  assert.doesNotThrow(() => set(1));
});

test('effect 안 setState 는 한 번: 보고 2번, 최종 1', () => {
  const { comp, reports, rootEl } = start(() => {
    const [n, setN] = H.useState(0);
    H.useEffect(() => { if (n < 1) setN(1); }, [n]);
    return h('p', null, String(n));
  });
  assert.deepEqual(reports.map((r) => r.kind), ['mount', 'update']);
  assert.equal(rootEl.textContent, '1');
  assert.equal(comp.inspect().hooks[0].value, 1);
});

test('deps 없는 effect 가 무조건 setState → 50 번 뒤 update loop 에러', () => {
  const env = setup();
  const comp = new FunctionComponent(() => {
    const [n, setN] = H.useState(0);
    H.useEffect(() => { setN(n + 1); });
    return h('p', null, String(n));
  }, {}, env.rootEl);
  assert.throws(() => comp.mount(), /update loop/);
});

test('onCommit 콜백 안 setState → 커밋 뒤 한 번 다시 그린다', () => {
  const env = setup();
  let set;
  const comp = new FunctionComponent(() => {
    const [n, setN] = H.useState(0);
    set = setN;
    return h('p', null, String(n));
  }, {}, env.rootEl);
  const kinds = [];
  comp.onCommit((r) => {
    kinds.push(r.kind);
    if (r.kind === 'mount') set(5);
  });
  comp.mount();
  assert.deepEqual(kinds, ['mount', 'update']);
  assert.equal(env.rootEl.textContent, '5');
});

test('렌더가 던지면 그 렌더의 effect 표시는 버려진다', () => {
  let runs = 0;
  let set;
  let fail = false;
  start(() => {
    const [n, setN] = H.useState(0);
    set = setN;
    H.useEffect(() => { runs += 1; });
    if (fail) throw new Error('boom');
    return h('p', null, String(n));
  });
  fail = true;
  assert.throws(() => set(1), /boom/);
  assert.equal(runs, 1);
});

test('destroy → 모든 cleanup 을 훅 순서로 실행하고 컨테이너를 비운다', () => {
  const log = [];
  const { comp, rootEl } = start(() => {
    H.useEffect(() => () => log.push('a'), []);
    H.useEffect(() => () => log.push('b'), []);
    return h('p', null, 'x');
  });
  comp.destroy();
  assert.deepEqual(log, ['a', 'b']);
  assert.equal(rootEl.innerHTML, '');
});

test('effect 하나가 throw 해도 다음 effect 가 실행되고 예외는 마지막에 던진다', () => {
  const log = [];
  const env = setup();
  const comp = new FunctionComponent(() => {
    H.useEffect(() => { throw new Error('first'); });
    H.useEffect(() => { log.push('second'); });
    return null;
  }, {}, env.rootEl);
  assert.throws(() => comp.mount(), /first/);
  assert.deepEqual(log, ['second']);
});

test('effect 가 여럿 throw 하면 AggregateError 로 모아 던진다', () => {
  const env = setup();
  const comp = new FunctionComponent(() => {
    H.useEffect(() => { throw new Error('e1'); });
    H.useEffect(() => { throw new Error('e2'); });
    return null;
  }, {}, env.rootEl);
  assert.throws(() => comp.mount(), (err) => err instanceof AggregateError && err.errors.length === 2);
});
