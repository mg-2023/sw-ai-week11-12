/* ======================================================================
 * demo/App.js — 예제 컴포넌트 (카운터)
 *
 *   state
 *     count     : 카운터 값
 *     step      : 한 번에 증가하는 폭 (1 → 2 → 5 순환)
 *     autoPlay  : 1초마다 자동 증가 여부
 *     highlight : 제목 강조 여부. count 와 무관한 state — useMemo 가 계산을 건너뛰는 것을 확인하는 용도
 *
 *   useMemo   : count 이하 소수 개수. deps [count] → highlight / step / autoPlay 만 바뀐 렌더에서는 다시 계산하지 않는다
 *   useEffect : ① []                마운트 때 원래 문서 제목을 기억해 두고, 언마운트 때 되돌린다
 *               ② [count]           count 가 바뀔 때마다 문서 제목(document.title)에 반영
 *               ③ [autoPlay, step]  자동 증가 타이머 시작, cleanup 에서 해제
 *
 *   훅은 루트 컴포넌트(App)에서만 호출한다. 자식 컴포넌트는 props 만 받는 순수 함수다.
 *   요소 사이에 공백만 있는 텍스트를 만들지 않는다 (실제 DOM 에서 읽은 VDOM 과 모양을 맞추기 위해).
 * ====================================================================== */

import { h } from '../src/compo.js';
import { useState, useMemo, useEffect } from '../src/hooks.js';

const STEPS = [1, 2, 5];

/** n 이하 소수 개수 (일부러 단순하게 구현한 "비용이 드는 계산") */
function countPrimes(n) {
  console.log('[useMemo] ' + n + ' 이하 소수 개수 계산');
  let total = 0;
  for (let x = 2; x <= n; x++) {
    let prime = true;
    for (let d = 2; d * d <= x; d++) if (x % d === 0) { prime = false; break; }
    if (prime) total++;
  }
  return total;
}

function Counter({ count }) {
  return h('p', { class: 'desc' }, '카운터: ', h('b', null, count));
}

function PrimeInfo({ primes }) {
  return h('p', { class: 'desc' }, '카운터 이하 소수: ', h('b', null, primes), ' 개');
}

function Controls({ step, autoPlay, highlight, onPlus, onStep, onAuto, onHighlight }) {
  return h('div', { class: 'btn-row' },
    h('button', { class: 'btn primary', onClick: onPlus }, '+', step),
    h('button', { class: 'btn', onClick: onStep }, '증가 폭: ', step),
    h('button', { class: 'btn', onClick: onAuto }, autoPlay ? '자동 증가 끄기' : '자동 증가 켜기'),
    h('button', { class: 'btn', onClick: onHighlight }, highlight ? '제목 강조 끄기' : '제목 강조 켜기'));
}

export function App() {
  const [count, setCount] = useState(0);
  const [step, setStep] = useState(1);
  const [autoPlay, setAutoPlay] = useState(false);
  const [highlight, setHighlight] = useState(false);

  const primes = useMemo(() => countPrimes(count), [count]);

  useEffect(() => {
    const original = document.title;
    return () => { document.title = original; };
  }, []);

  useEffect(() => {
    document.title = '카운터: ' + count;
  }, [count]);

  useEffect(() => {
    if (!autoPlay) return;
    console.log('[useEffect] 타이머 시작 (1초마다 +' + step + ')');
    const id = setInterval(() => setCount((c) => c + step), 1000);
    return () => { clearInterval(id); console.log('[useEffect] 타이머 해제'); };
  }, [autoPlay, step]);

  return h('div', { class: 'card', id: 'profile' },
    h('h2', { class: highlight ? 'title hl' : 'title' }, 'Virtual DOM 연습'),
    h(Counter, { count }),
    h(PrimeInfo, { primes }),
    h('ul', { class: 'list' },
      h('li', null, 'React'),
      h('li', { class: 'done' }, 'Virtual DOM'),
      h('li', null, 'Diff 알고리즘')),
    h('button', { class: 'btn', disabled: true }, '저장'),
    h(Controls, {
      step, autoPlay, highlight,
      onPlus: () => setCount((c) => c + step),
      onStep: () => setStep((s) => STEPS[(STEPS.indexOf(s) + 1) % STEPS.length]),
      onAuto: () => setAutoPlay((on) => !on),
      onHighlight: () => setHighlight((on) => !on),
    }));
}
