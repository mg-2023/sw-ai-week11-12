/* ======================================================================
 * hooks.js — useState (훅 배열 + 커서)
 *
 *   hooks  : 렌더 사이에 유지되는 state 저장소. 호출 순서(커서)가 곧 인덱스다.
 *   cursor : 이번 렌더에서 몇 번째 훅을 읽을 차례인지. 렌더 직전 beginRender() 로 0 이 된다.
 *
 *   setter 가 값을 바꾸면 onStateChange 로 등록된 리렌더 함수를 즉시(동기) 호출한다. (배칭 없음)
 *   훅은 루트 컴포넌트에서만 호출한다는 전제다. DOM/UI 를 다루지 않는다.
 * ====================================================================== */

let hooks = [];
let cursor = 0;
let rerender = null;
let generation = 0;   // resetHooks 마다 증가. 이전 마운트에서 만든 setter 가 새 저장소를 건드리지 못하게 한다.

/** 렌더 직전: 커서를 0 으로 */
export function beginRender() { cursor = 0; }

/** 마운트할 때: 저장소 비우기 */
export function resetHooks() { hooks = []; cursor = 0; generation++; }

/** setter 가 부를 리렌더 함수 등록 (null 이면 해제) */
export function onStateChange(fn) { rerender = fn; }

/** [값, setter]. setter 는 값 또는 prev => next 함수를 받는다 */
export function useState(initial) {
  const i = cursor++;
  if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial;
  const gen = generation;
  const setState = (action) => {
    if (gen !== generation) return;                                   // 이미 언마운트/재마운트된 렌더의 setter
    const prev = hooks[i];
    const next = typeof action === 'function' ? action(prev) : action;
    if (Object.is(prev, next)) return;                                // 같은 값이면 리렌더하지 않는다
    hooks[i] = next;
    if (rerender) rerender();
  };
  return [hooks[i], setState];
}
