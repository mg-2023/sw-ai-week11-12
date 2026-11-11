/* 컴포넌트 안에서 쓰는 훅(useState · useMemo · useEffect)과 지금 그리는 컴포넌트를 알려 주는 모듈
 *
 * 흐름 지도 — "번호표 사물함"
 * 1. 렌더마다 컴포넌트는 사물함 0번, 1번, 2번… 을 훅을 부른 순서대로 연다 (nextSlot)
 * 2. 처음 열면 칸을 만들어 넣고, 다시 열면 같은 번호의 칸을 꺼내 쓴다 (개수나 종류가 달라지면 예외, 같은 종류끼리 순서만 바뀌면 못 잡고 값이 뒤섞인다)
 * 3. useState 의 setter 는 칸의 값을 바꾼 뒤 컴포넌트를 다시 그리게 한다 (makeSetter)
 * 4. useMemo · useEffect 는 deps 가 달라졌을 때만 계산하거나 실행할 것으로 표시한다 (depsChanged)
 * 5. [v2] setter 는 값만 저장하고 줄을 세운 뒤 렌더를 마이크로태스크로 한 번만 예약한다.
 *    지금 실행 중인 코드가 모두 끝나면(호출 스택이 비면) 예약된 컴포넌트를 한 번에 갱신한다 (schedule · flushScheduled)
 *    바로 반영해야 하면 flushSync(fn) 로 그 자리에서 비운다
 */
(function (root) {
  'use strict';

  let current = null;
  let inChild = false;
  let syncDepth = 0;
  let microtaskQueued = false;
  const scheduled = new Set();
  const enqueue = typeof root.queueMicrotask === 'function'
    ? (fn) => root.queueMicrotask(fn)
    : (fn) => Promise.resolve().then(fn);

  /* 자식 렌더 중 표시를 바꾸고 이전 값을 돌려주는 함수 */
  function setInChild(value) {
    const prev = inChild;
    inChild = value;
    return prev;
  }

  /* 지금 렌더 중인 컴포넌트를 돌려주는 함수 */
  function getCurrent() {
    return current;
  }

  /* 지금 렌더 중인 컴포넌트를 정하는 함수 */
  function setCurrent(component) {
    current = component;
  }

  /* 훅을 부를 수 없는 자리(자식 안 · 컴포넌트 밖)면 예외를 던지는 함수 */
  function assertHookAllowed() {
    if (inChild) throw new Error('자식 컴포넌트 안에서는 Hook 을 부를 수 없습니다 (State 는 루트에만 둡니다)');
    if (current === null) throw new Error('Hook 은 컴포넌트 함수 안에서만 부를 수 있습니다 (컴포넌트 밖 호출)');
  }

  /* 이번에 열 사물함 번호를 돌려주고 다음 번호로 넘기는 함수 (이전 렌더보다 많이 열면 예외) */
  function takeIndex(comp) {
    const i = comp.hookIndex;
    if (comp.hookCount !== null && i >= comp.hookCount) {
      throw new Error('Hook 개수가 이전 렌더와 다릅니다 (조건문 · 반복문 안에서 Hook 을 부르지 마세요)');
    }
    comp.hookIndex += 1;
    return i;
  }

  /* i 번 칸을 돌려주는 함수 (비어 있으면 make 로 만들어 넣고, 있으면 종류가 같은지 검사한다) */
  function slotAt(comp, i, kind, make) {
    if (i >= comp.hooks.length) {
      comp.hooks.push(make());
    } else if (comp.hooks[i].kind !== kind) {
      throw new Error('Hook 종류가 이전 렌더와 다릅니다 (' + i + '번째: ' + comp.hooks[i].kind + ' → ' + kind + ')');
    }
    return comp.hooks[i];
  }

  /* 지금 컴포넌트의 다음 훅 자리를 종류 검사와 함께 돌려주는 함수 (없으면 만든다) */
  function nextSlot(kind, make) {
    assertHookAllowed();
    const i = takeIndex(current);
    return slotAt(current, i, kind, make);
  }

  /* setState 에 넘긴 값이 함수면 이전 값으로 계산하고, 아니면 그대로 돌려주는 함수 */
  function resolveNext(next, prev) {
    return typeof next === 'function' ? next(prev) : next;
  }

  /* 바뀐 값을 줄 세우는 함수 (같은 hook 은 한 번만 넣고, 커밋 뒤 · 예약을 비울 때 이어서 갱신하게 표시한다) */
  function queueDeferred(comp, hook, prev) {
    if (!comp.queued.some((q) => q.hook === hook)) comp.queued.push({ hook, prev });
    comp.pendingUpdate = true;
  }

  /* 목록의 컴포넌트마다 밀린 갱신을 반영하고 던진 예외를 목록으로 돌려주는 함수 */
  function flushAll(list) {
    const errors = [];
    for (const comp of list) {
      try { comp.flushBatched(); } catch (err) { errors.push(err); }
    }
    return errors;
  }

  /* 예외 목록을 하나로 던지는 함수 (1개는 그대로 · 여럿은 AggregateError · 없으면 아무것도 안 함) */
  function throwAll(errors) {
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, '예약된 갱신 반영 중 예외 여러 개');
  }

  /* 예약된 컴포넌트를 모두 꺼내 비운 뒤 한 번씩 반영하는 함수 (예외는 모아서 던짐) */
  function flushScheduled() {
    const list = Array.from(scheduled);
    scheduled.clear();
    throwAll(flushAll(list));
  }

  /* 마이크로태스크에서 예약을 비우는 함수 (부른 쪽이 이미 끝났으니 예외는 던지지 않고 보고한다) */
  function flushFromMicrotask() {
    microtaskQueued = false;
    try {
      flushScheduled();
    } catch (err) {
      if (typeof root.reportError === 'function') root.reportError(err);
      else console.error(err);
    }
  }

  /* 컴포넌트를 예약 목록에 넣고, 처음일 때만 마이크로태스크를 거는 함수 (flushSync 안이면 그쪽이 비운다) */
  function schedule(comp) {
    scheduled.add(comp);
    if (syncDepth > 0 || microtaskQueued) return;
    microtaskQueued = true;
    enqueue(flushFromMicrotask);
  }

  /* fn 안의 setter 를 기다리지 않고 그 자리에서 반영하고 fn 의 반환값을 돌려주는 함수 (예외는 부른 쪽으로) */
  function flushSync(fn) {
    syncDepth += 1;
    let result;
    try {
      result = fn();
    } finally {
      syncDepth -= 1;
    }
    if (syncDepth === 0) flushScheduled();
    return result;
  }

  /* 상태 바꾸는 함수를 만드는 함수 (값만 저장하고 렌더는 예약 — 같은 값이면 예약을 비울 때 입력값만 맞춤) */
  function makeSetter(hook, comp) {
    return (next) => {
      if (comp.phase === 'render') throw new Error('렌더 중에는 setState 를 부를 수 없습니다 (렌더 중 setState)');
      if (comp.destroyed) return;
      const prev = hook.value;
      const value = resolveNext(next, prev);
      if (Object.is(prev, value)) {
        // 바로 맞추면 옛 vdom 으로 입력값을 되감을 수 있으니 예약을 비울 때 flushBatched 가 맞춘다
        schedule(comp);
        return;
      }
      hook.value = value;
      queueDeferred(comp, hook, prev);
      // 커밋 중이면 지금 도는 settle 이 커밋 뒤 이어서 갱신하니 예약하지 않는다
      if (comp.phase !== 'commit') schedule(comp);
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

  /* 이전 deps 와 새 deps 가 다른지 알려 주는 함수 (deps 없음 · 길이 다름 · Object.is 다름이면 true) */
  function depsChanged(prev, next) {
    if (prev === undefined || next === undefined) return true;
    if (prev.length !== next.length) return true;
    return next.some((dep, i) => !Object.is(dep, prev[i]));
  }

  /* 계산 결과를 기억하고 deps 가 같으면 계산을 건너뛰는 훅 */
  function useMemo(fn, deps) {
    let created = false;
    const slot = nextSlot('memo', () => {
      created = true;
      return { kind: 'memo', value: fn(), deps };
    });
    if (!created && depsChanged(slot.deps, deps)) {
      slot.value = fn();
      slot.deps = deps;
    }
    return slot.value;
  }

  /* 부수 효과를 등록하는 훅 (렌더 중엔 실행할 것만 표시하고, 커밋 뒤 컴포넌트가 실행한다) */
  function useEffect(fn, deps) {
    const slot = nextSlot('effect', () => ({ kind: 'effect', deps: undefined, cleanup: undefined }));
    if (depsChanged(slot.deps, deps)) current.pendingEffects.push({ slot, fn, deps });
  }

  const api = { flushSync, getCurrent, setCurrent, setInChild, nextSlot, depsChanged, useState, useMemo, useEffect };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MiniReact = Object.assign(root.MiniReact || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
