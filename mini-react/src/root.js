/* ======================================================================
 * root.js — 컴포넌트를 실제 영역에 마운트하고, state 가 바뀌면 리렌더한다
 *
 *   리렌더 흐름: beginRender → App() 실행 → expand 로 일반 VNode 트리 → #root 로 감쌈
 *              → patchToVdom(container, 이전 VDOM, 새 VDOM) → 이전 VDOM 갱신 → onCommit → flushEffects
 *
 *   UI(깜빡임·로그)는 다루지 않는다. 결과는 onCommit 으로만 내보낸다.
 *     onCommit({ reason: 'mount' | 'update', next, patches, mutated, touched, verified })
 *     onError(err, reason)   (없으면 예외를 그대로 던진다)
 * ====================================================================== */

import { ROOT } from './vdom.js';
import { h, expandToChildren } from './compo.js';
import { beginRender, resetHooks, onStateChange, flushEffects, cleanupEffects } from './hooks.js';
import { delegate } from './events.js';
import { patchToVdom } from './patch.js';

export function createRoot(container, { onCommit, onError } = {}) {
  let Component = null;
  let current = null;        // 지금 실제 영역에 그려져 있는 VDOM (= 다음 Diff 의 "이전 VDOM", 이벤트 핸들러를 찾는 곳)
  let undelegate = null;

  const render = () => {
    beginRender();
    return { type: ROOT, props: {}, children: expandToChildren(h(Component, null)) };
  };

  function commit(reason) {
    try {
      const next = render();
      const result = patchToVdom(container, current, next);
      current = next;
      if (onCommit) onCommit({ reason, next, ...result });
      flushEffects();                        // useEffect: 화면 반영이 끝난 뒤 실행 (effect 안의 setState 는 여기서 한 번 더 리렌더)
    } catch (err) {
      if (reason === 'mount') unmount();     // 첫 렌더 실패: 마운트하지 않은 상태로 되돌린다
      if (onError) onError(err, reason); else throw err;
    }
  }

  function unmount() {
    cleanupEffects();                        // useEffect 의 cleanup 실행 (타이머 해제 등)
    if (undelegate) undelegate();
    undelegate = null;
    onStateChange(null);
    Component = null;
  }

  return {
    /** Component 를 마운트한다. currentVdom: 지금 실제 영역에 그려져 있는 VDOM (첫 렌더의 Diff 기준) */
    mount(Comp, currentVdom) {
      unmount();
      Component = Comp;
      current = currentVdom;
      resetHooks();
      onStateChange(() => commit('update'));
      undelegate = delegate(container, () => current);
      commit('mount');
    },
    unmount,
    get mounted() { return Component !== null; },
    get vdom() { return current; },
  };
}
