/* 컴포넌트 안에서 쓰는 훅(useState · useMemo · useEffect)과 지금 그리는 컴포넌트를 알려 주는 모듈 */
(function (root) {
  'use strict';

  let current = null;

  /* 지금 렌더 중인 컴포넌트를 돌려주는 함수 */
  function getCurrent() {
    return current;
  }

  /* 지금 렌더 중인 컴포넌트를 정하는 함수 */
  function setCurrent(component) {
    current = component;
  }

  /* 지금 컴포넌트의 다음 훅 자리를 종류 검사와 함께 돌려주는 함수 (없으면 만든다) */
  function nextSlot(kind, make) {
    if (current === null) throw new Error('Hook 은 컴포넌트 함수 안에서만 부를 수 있습니다 (컴포넌트 밖 호출)');
    const i = current.hookIndex;
    if (current.hookCount !== null && i >= current.hookCount) {
      throw new Error('Hook 개수가 이전 렌더와 다릅니다 (조건문 · 반복문 안에서 Hook 을 부르지 마세요)');
    }
    current.hookIndex += 1;
    if (i >= current.hooks.length) {
      current.hooks.push(make());
    } else if (current.hooks[i].kind !== kind) {
      throw new Error('Hook 종류가 이전 렌더와 다릅니다 (' + i + '번째: ' + current.hooks[i].kind + ' → ' + kind + ')');
    }
    return current.hooks[i];
  }

  /* 상태 바꾸는 함수를 만드는 함수 (같은 값이면 무시, 렌더 예외면 update 가 값을 되돌림) */
  function makeSetter(hook, comp) {
    return (next) => {
      if (comp.phase === 'render') throw new Error('렌더 중에는 setState 를 부를 수 없습니다 (렌더 중 setState)');
      if (comp.destroyed) return;
      const prev = hook.value;
      const value = typeof next === 'function' ? next(prev) : next;
      if (Object.is(prev, value)) return;
      hook.value = value;
      comp.update(() => { hook.value = prev; });
    };
  }

  /* 상태를 기억하고 [값, 바꾸는 함수] 를 돌려주는 훅 (값이 바뀌면 컴포넌트를 다시 그린다) */
  function useState(init) {
    const slot = nextSlot('state', () => {
      const hook = { kind: 'state', value: typeof init === 'function' ? init() : init };
      hook.setter = makeSetter(hook, current);
      return hook;
    });
    return [slot.value, slot.setter];
  }

  /* 값 기억 훅 자리 (다음 작업에서 구현) */
  function useMemo() {
    throw new Error('useMemo: not implemented yet');
  }

  /* 부수 효과 훅 자리 (다음 작업에서 구현) */
  function useEffect() {
    throw new Error('useEffect: not implemented yet');
  }

  const api = { getCurrent, setCurrent, nextSlot, useState, useMemo, useEffect };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MiniReact = Object.assign(root.MiniReact || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
