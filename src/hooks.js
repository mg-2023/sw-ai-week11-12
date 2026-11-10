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

  /* 상태 훅 자리 (다음 작업에서 구현) */
  function useState() {
    throw new Error('useState: not implemented yet');
  }

  /* 값 기억 훅 자리 (다음 작업에서 구현) */
  function useMemo() {
    throw new Error('useMemo: not implemented yet');
  }

  /* 부수 효과 훅 자리 (다음 작업에서 구현) */
  function useEffect() {
    throw new Error('useEffect: not implemented yet');
  }

  const api = { getCurrent, setCurrent, useState, useMemo, useEffect };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MiniReact = Object.assign(root.MiniReact || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
