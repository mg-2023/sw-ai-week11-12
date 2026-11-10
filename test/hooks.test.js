// useState · Hook 규칙(M2) 단위 테스트: 상태 유지 · 개수 · 종류 · 컴포넌트 밖 호출
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { h } = require('../src/vdom');
const { useState, getCurrent } = require('../src/hooks');
const { FunctionComponent } = require('../src/component');

// update() 는 다음 작업이라, 다시 렌더는 내부 run() 을 직접 불러 흉내 낸다
function mountComp(fn) {
  const { rootEl } = setup();
  const comp = new FunctionComponent(fn, {}, rootEl);
  comp.mount();
  return { comp, rootEl };
}

test('useState: 처음 값이 화면에 나온다', () => {
  const { rootEl } = mountComp(() => {
    const [n] = useState(5);
    return h('p', {}, String(n));
  });
  assert.equal(rootEl.innerHTML, '<p>5</p>');
});

test('useState: init 이 함수면 처음 한 번만 호출한다', () => {
  let calls = 0;
  const { comp } = mountComp(() => {
    useState(() => { calls += 1; return 1; });
    return null;
  });
  comp.run();
  comp.run();
  assert.equal(calls, 1);
});

test('useState: 두 개는 각자 값을 유지하고 inspect 순서는 호출 순서', () => {
  let setA;
  const seen = [];
  const { comp } = mountComp(() => {
    const [a, sa] = useState('a');
    const [b] = useState('b');
    setA = sa;
    seen.push([a, b]);
    return null;
  });
  setA('A');
  assert.deepEqual(seen, [['a', 'b'], ['A', 'b']]);
  assert.deepEqual(comp.inspect().hooks, [{ kind: 'state', value: 'A' }, { kind: 'state', value: 'b' }]);
});

test('setState: 함수 updater 는 이전 값을 받는다', () => {
  let set;
  const { comp } = mountComp(() => { [, set] = useState(1); return null; });
  set((prev) => prev + 10);
  assert.equal(comp.inspect().hooks[0].value, 11);
});

test('setState: 렌더마다 같은 함수다', () => {
  const setters = [];
  const { comp } = mountComp(() => { setters.push(useState(0)[1]); return null; });
  comp.run();
  assert.equal(setters[0], setters[1]);
});

test('useState: 컴포넌트 밖에서 부르면 에러', () => {
  assert.throws(() => useState(0), /컴포넌트/);
});

test('Hook 개수가 렌더마다 다르면 에러 (더 많이 / 더 적게)', () => {
  let more = false;
  const { comp } = mountComp(() => {
    useState(0);
    if (more) useState(1);
    return null;
  });
  more = true;
  assert.throws(() => comp.run(), /Hook/);

  let fewer = false;
  const second = mountComp(() => {
    useState(0);
    if (!fewer) useState(1);
    return null;
  });
  fewer = true;
  assert.throws(() => second.comp.run(), /Hook/);
});

test('같은 자리 Hook 종류가 바뀌면 에러', () => {
  const { comp } = mountComp(() => { useState(0); return null; });
  comp.hooks[0].kind = 'memo';
  assert.throws(() => comp.run(), /memo.*state|종류/);
});

test('다시 렌더할 때 hookIndex 가 0 부터 시작한다', () => {
  const indexes = [];
  const { comp } = mountComp(() => {
    indexes.push(getCurrent().hookIndex);
    useState(0);
    return null;
  });
  comp.run();
  assert.deepEqual(indexes, [0, 0]);
});

test('렌더 중 에러가 나도 현재 컴포넌트가 비워진다', () => {
  const { comp } = mountComp(() => { useState(0); return null; });
  comp.hooks[0].kind = 'memo';
  assert.throws(() => comp.run());
  assert.throws(() => useState(0), /컴포넌트/);
});
