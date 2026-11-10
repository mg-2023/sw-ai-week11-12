/* ======================================================================
 * hooks.js — useState / useMemo / useEffect (훅 배열 + 커서)
 *
 *   hooks  : 렌더 사이에 유지되는 슬롯 저장소. 호출 순서(커서)가 곧 인덱스다.
 *              useState  슬롯 : { value }
 *              useMemo   슬롯 : { value, deps }
 *              useEffect 슬롯 : { deps, cleanup }
 *   cursor : 이번 렌더에서 몇 번째 훅을 읽을 차례인지. 렌더 직전 beginRender() 로 0 이 된다.
 *
 *   deps (dependencies) : "이 콜백이 의존하는 값" 배열. 이전 렌더의 deps 와 같은 자리끼리 Object.is 로 비교해
 *                         하나라도 다르면 콜백을 다시 실행한다. [] 는 첫 렌더에만, 생략하면 매 렌더마다 실행.
 *
 *   setter 가 값을 바꾸면 onStateChange 로 등록된 리렌더 함수를 즉시(동기) 호출한다. (배칭 없음)
 *   단, effect 실행 중의 setState 는 effect 를 모두 돌린 뒤 한 번만 리렌더한다.
 *   훅은 루트 컴포넌트에서만 호출한다는 전제다. DOM/UI 를 다루지 않는다.
 * ====================================================================== */

let hooks = [];
let cursor = 0;
let rerender = null;
let generation = 0;        // resetHooks 마다 증가. 이전 마운트에서 만든 setter 가 새 저장소를 건드리지 못하게 한다.
let pendingEffects = [];   // 이번 렌더에서 "실행해야 한다"고 판정된 effect 들. 커밋 뒤 flushEffects 가 실행한다.
let flushing = false;      // effect 실행 중인지
let rerenderQueued = false;

/** 렌더 직전: 커서를 0 으로, 지난 렌더가 남긴 effect 대기열 비우기 */
export function beginRender() { cursor = 0; pendingEffects = []; }

/** 마운트할 때: 저장소 비우기 */
export function resetHooks() { hooks = []; cursor = 0; pendingEffects = []; rerenderQueued = false; generation++; }

/** setter 가 부를 리렌더 함수 등록 (null 이면 해제) */
export function onStateChange(fn) { rerender = fn; }

/** deps 가 바뀌었는가. 첫 렌더(prev 없음)이거나 deps 를 생략했으면 항상 true */
function depsChanged(prev, next) {
  if (!prev || !next) return true;
  if (prev.length !== next.length) return true;
  return next.some((dep, i) => !Object.is(dep, prev[i]));
}

/** [값, setter]. setter 는 값 또는 prev => next 함수를 받는다 */
export function useState(initial) {
  const i = cursor++;
  if (!hooks[i]) hooks[i] = { value: typeof initial === 'function' ? initial() : initial };
  const slot = hooks[i];
  const gen = generation;
  const setState = (action) => {
    if (gen !== generation) return;                                   // 이미 언마운트/재마운트된 렌더의 setter
    const prev = slot.value;
    const next = typeof action === 'function' ? action(prev) : action;
    if (Object.is(prev, next)) return;                                // 같은 값이면 리렌더하지 않는다
    slot.value = next;
    if (flushing) { rerenderQueued = true; return; }                  // effect 안에서 부른 경우: effect 가 끝난 뒤 한 번만
    if (rerender) rerender();
  };
  return [slot.value, setState];
}

/** deps 가 바뀐 렌더에서만 factory 를 다시 실행하고, 아니면 저장해 둔 값을 돌려준다 */
export function useMemo(factory, deps) {
  const i = cursor++;
  const slot = hooks[i];
  if (!slot || depsChanged(slot.deps, deps)) hooks[i] = { value: factory(), deps };
  return hooks[i].value;
}

/**
 * deps 가 바뀐 렌더가 화면에 반영(커밋)된 뒤 effect 를 실행한다.
 * effect 가 함수를 돌려주면 cleanup 으로 저장해 두었다가, 다음 실행 직전과 언마운트 때 부른다.
 */
export function useEffect(effect, deps) {
  const i = cursor++;
  if (!hooks[i]) hooks[i] = { deps: undefined, cleanup: null };
  const slot = hooks[i];
  // 새 deps 는 effect 를 실제로 실행할 때 저장한다 (렌더가 중간에 실패해도 effect 를 잃지 않도록)
  if (depsChanged(slot.deps, deps)) pendingEffects.push({ slot, effect, deps });
}

/** 커밋 직후: 대기 중인 effect 를 호출 순서대로 실행한다 (이전 cleanup → effect) */
export function flushEffects() {
  const queue = pendingEffects;
  pendingEffects = [];
  flushing = true;
  try {
    for (const { slot, effect, deps } of queue) {
      if (typeof slot.cleanup === 'function') slot.cleanup();
      slot.cleanup = null;
      slot.deps = deps;
      const cleanup = effect();
      slot.cleanup = typeof cleanup === 'function' ? cleanup : null;
    }
  } finally {
    flushing = false;
  }
  if (rerenderQueued) { rerenderQueued = false; if (rerender) rerender(); }
}

/** 언마운트할 때: 남아 있는 cleanup 을 모두 실행한다 */
export function cleanupEffects() {
  pendingEffects = [];
  rerenderQueued = false;
  for (const slot of hooks) {
    if (slot && typeof slot.cleanup === 'function') {
      const cleanup = slot.cleanup;
      slot.cleanup = null;
      cleanup();
    }
  }
}
