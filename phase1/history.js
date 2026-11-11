/* Virtual DOM 스냅샷을 쌓고 뒤로 · 앞으로 오가는 State History 모듈 */
(function (root) {
  'use strict';

  const V = typeof require === 'function' ? require('../engines/v1-batch/vdom.js') : root.MiniReact;

  /* 첫 Virtual DOM 으로 기록 객체를 만드는 함수 */
  function createHistory(initial) {
    const stack = [V.clone(initial)];
    let index = 0;

    return {
      current: () => V.clone(stack[index]),
      push(vnode) {
        stack.splice(index + 1);
        stack.push(V.clone(vnode));
        index = stack.length - 1;
        return V.clone(stack[index]);
      },
      canBack: () => index > 0,
      canForward: () => index < stack.length - 1,
      back() {
        if (index === 0) return null;
        index--;
        return V.clone(stack[index]);
      },
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
