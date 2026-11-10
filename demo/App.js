/* ======================================================================
 * demo/App.js — 예제 컴포넌트 (조회수 +1)
 *
 *   훅은 루트 컴포넌트(App)에서만 호출한다. 자식 컴포넌트는 props 만 받는 순수 함수다.
 *   요소 사이에 공백만 있는 텍스트를 만들지 않는다 (실제 DOM 에서 읽은 VDOM 과 모양을 맞추기 위해).
 * ====================================================================== */

import { h } from '../src/compo.js';
import { useState } from '../src/hooks.js';

function ViewCount({ views }) {
  return h('p', { class: 'desc' }, '조회수: ', h('b', null, views), ' 회');
}

function PlusButton({ onClick }) {
  return h('button', { class: 'btn', onClick }, '조회수 +1');
}

export function App() {
  const [views, setViews] = useState(10);
  return h('div', { class: 'card', id: 'profile' },
    h('h2', { class: 'title' }, 'Virtual DOM 연습'),
    h(ViewCount, { views }),
    h('ul', { class: 'list' },
      h('li', null, 'React'),
      h('li', { class: 'done' }, 'Virtual DOM'),
      h('li', null, 'Diff 알고리즘')),
    h('button', { class: 'btn', disabled: true }, '저장'),
    h(PlusButton, { onClick: () => setViews((v) => v + 1) }));
}
