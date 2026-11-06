/**
 * history.js — State History: Virtual DOM 스냅샷을 순서대로 쌓고 앞뒤로 오간다
 *
 *   [v0, v1, v2]   index = 2 (지금)
 *   back()    → index 1, v1 을 돌려준다
 *   push(v3)  → 지금 뒤에 있던 기록(앞으로가기 대상)은 버리고 v3 을 쌓는다 (브라우저 뒤로가기와 같음)
 *
 * 넣을 때와 꺼낼 때 깊은 복사를 해서, 바깥에서 객체를 고쳐도 기록이 바뀌지 않는다.
 */
(function (root) {
  'use strict';

  const V = typeof require === 'function' ? require('./vdom.js') : root.MiniReact;

  function createHistory(initial) {
    const stack = [V.clone(initial)];
    let index = 0;

    return {
      current: () => V.clone(stack[index]),
      push(vnode) {
        stack.splice(index + 1); // 앞으로가기 기록 버림
        stack.push(V.clone(vnode));
        index = stack.length - 1;
        return V.clone(stack[index]);
      },
      canBack: () => index > 0,
      canForward: () => index < stack.length - 1,
      /** 한 칸 뒤로. 더 갈 수 없으면 null */
      back() {
        if (index === 0) return null;
        index--;
        return V.clone(stack[index]);
      },
      /** 한 칸 앞으로. 더 갈 수 없으면 null */
      forward() {
        if (index === stack.length - 1) return null;
        index++;
        return V.clone(stack[index]);
      },
      get index() { return index; },
      get length() { return stack.length; },
    };
  }

  const api = { createHistory };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MiniReact = Object.assign(root.MiniReact || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
