/* 함수형 컴포넌트를 펼쳐 컨테이너에 그리고 측정 결과를 보고하는 모듈 */
(function (root) {
  'use strict';

  const V = typeof require === 'function' ? require('./vdom.js') : root.MiniReact;
  const P = typeof require === 'function' ? require('./patch.js') : root.MiniReact;
  const D = typeof require === 'function' ? require('./diff.js') : root.MiniReact;
  const H = typeof require === 'function' ? require('./hooks.js') : root.MiniReact;

  /* 패치 종류별 개수를 세어 다섯 키가 모두 있는 객체로 돌려주는 함수 */
  function countPatches(patches) {
    const counts = { CREATE: 0, REMOVE: 0, REPLACE: 0, TEXT: 0, PROPS: 0 };
    for (const p of patches) counts[p.type] += 1;
    return counts;
  }

  /* 함수가 돌려준 값(글자·숫자 포함)을 vnode 나 null 로 맞추는 함수 */
  function normalize(value) {
    if (value === null || value === undefined || value === false || value === true) return null;
    if (typeof value === 'object') return value;
    return V.text(String(value));
  }

  /* 자식 함수를 Hook 금지 상태로 props 복사본과 함께 불러 결과를 돌려주는 함수 */
  function callChild(vnode) {
    const prev = H.setInChild(true);
    try {
      return vnode.type({ ...vnode.props, children: vnode.children });
    } finally {
      H.setInChild(prev);
    }
  }

  /* 값 하나를 펼쳐 vnode 목록(배열·null 은 풀거나 뺌)으로 돌려주는 함수 */
  function expandAll(node) {
    if (Array.isArray(node)) return node.flatMap(expandAll);
    const vnode = normalize(node);
    if (vnode === null) return [];
    if (typeof vnode.type === 'function') return expandAll(callChild(vnode));
    const children = vnode.children.flatMap(expandAll);
    return [{ type: vnode.type, props: vnode.props, children }];
  }

  /* vnode 트리를 훑어 자식 컴포넌트를 부르고 null · 불리언 · 글자를 정리한 새 트리를 만드는 함수 */
  function expand(node) {
    const out = expandAll(node);
    if (out.length > 1) throw new Error('FunctionComponent: 루트가 배열을 돌려줄 수 없습니다 (하나의 요소로 감싸세요)');
    return out.length === 0 ? null : out[0];
  }

  class FunctionComponent {
    /* 함수 · props · 그릴 컨테이너를 받아 컴포넌트를 만드는 생성자 */
    constructor(fn, props = {}, container) {
      if (!container) throw new Error('FunctionComponent: container 가 필요합니다');
      this.fn = fn;
      this.props = props;
      this.container = container;
      this.vdom = null;
      this.hooks = [];
      this.hookIndex = 0;
      this.hookCount = null;
      this.mounted = false;
      this.listeners = [];
      this.phase = 'idle';
      this.destroyed = false;
      this.pendingEffects = [];
      this.pendingUpdate = false;
    }

    /* 함수를 실행해 펼친 트리로 컨테이너를 처음 그리고 보고하는 함수 */
    mount() {
      if (this.mounted) throw new Error('FunctionComponent: 이미 mount 되었습니다');
      const start = performance.now();
      const tree = this.renderTree();
      const vdom = { type: this.container.localName, props: {}, children: tree ? [tree] : [] };
      this.phase = 'commit';
      try {
        P.mount(this.container, vdom);
        P.syncFormState(this.container, vdom, { controlledOnly: true });
        this.vdom = vdom;
        this.mounted = true;
        const errors = this.runEffects();
        this.report('mount', start, 0, [], 0);
        this.finishCommit(errors);
      } finally {
        this.phase = 'idle';
      }
      this.flushPending();
    }

    /* 모은 effect 를 훅 순서대로 (이전 cleanup → 실행 → 새 cleanup 저장) 돌리고 던진 예외를 목록으로 돌려주는 함수 */
    runEffects() {
      const errors = [];
      const list = this.pendingEffects;
      this.pendingEffects = [];
      for (const { slot, fn, deps } of list) {
        try {
          const old = slot.cleanup;
          slot.cleanup = undefined;
          if (typeof old === 'function') old();
          slot.deps = deps;
          const result = fn();
          slot.cleanup = typeof result === 'function' ? result : undefined;
        } catch (err) {
          errors.push(err);
        }
      }
      return errors;
    }

    /* effect 예외가 하나면 그대로, 여럿이면 AggregateError 로 던지는 함수 */
    finishCommit(errors) {
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'effect 여러 개에서 예외가 났습니다');
    }

    /* 커밋 중 setState 로 밀린 갱신을 update 한 번씩으로 처리하는 함수 (연쇄 50 번 넘으면 에러) */
    flushPending() {
      let chain = 0;
      while (this.pendingUpdate && !this.destroyed) {
        this.pendingUpdate = false;
        chain += 1;
        if (chain > 50) throw new Error('update loop');
        this.updateOnce();
      }
    }

    /* 훅 번호를 0 으로 되돌려 함수를 한 번 실행하고 Hook 개수를 확인하는 함수 */
    run() {
      this.hookIndex = 0;
      H.setCurrent(this);
      try {
        const result = this.fn(this.props);
        if (Array.isArray(result)) throw new Error('FunctionComponent: 루트가 배열을 돌려줄 수 없습니다 (하나의 요소로 감싸세요)');
        if (this.hookCount === null) this.hookCount = this.hookIndex;
        else if (this.hookIndex !== this.hookCount) throw new Error('Hook 개수가 이전 렌더와 다릅니다 (조건문 · 반복문 안에서 Hook 을 부르지 마세요)');
        return result;
      } finally {
        H.setCurrent(null);
      }
    }

    /* render 단계로 함수를 실행해 펼친 트리를 돌려주는 함수 (끝나면 phase 를 idle 로) */
    renderTree() {
      this.phase = 'render';
      this.pendingEffects = [];
      try {
        return expand(this.run());
      } catch (err) {
        this.pendingEffects = [];
        throw err;
      } finally {
        this.phase = 'idle';
      }
    }

    /* 한 번 갱신하고 커밋 중 밀린 setState 가 있으면 이어서 갱신하는 함수 */
    update(undo) {
      this.updateOnce(undo);
      this.flushPending();
    }

    /* 다시 렌더해 diff 한 patch 만 적용하고 effect 를 돌린 뒤 보고하는 함수 (렌더 예외면 undo 로 값을 되돌리고, patch 실패 시 새 vdom 으로 다시 mount) */
    updateOnce(undo) {
      const start = performance.now();
      let tree;
      try {
        tree = this.renderTree();
      } catch (err) {
        if (undo) undo();
        throw err;
      }
      const vdom = { type: this.container.localName, props: {}, children: tree ? [tree] : [] };
      const stats = { compared: 0, eventOnly: 0 };
      const patches = D.diff(this.vdom, vdom, stats);
      let recovered = false;
      this.phase = 'commit';
      try {
        try {
          P.applyPatches(this.container, patches);
          P.syncFormState(this.container, vdom, { controlledOnly: true });
        } catch (err) {
          P.mount(this.container, vdom);
          P.syncFormState(this.container, vdom, { controlledOnly: true });
          recovered = true;
        }
        this.vdom = vdom;
        const errors = this.runEffects();
        this.report('update', start, stats.compared, patches, stats.eventOnly, recovered);
        this.finishCommit(errors);
      } finally {
        this.phase = 'idle';
      }
    }

    /* 모든 effect cleanup 을 훅 순서로 실행하고 컨테이너를 비우는 함수 (cleanup 예외는 모아서 마지막에 던진다) */
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.listeners = [];
      const errors = [];
      for (const hook of this.hooks) {
        if (hook.kind !== 'effect' || typeof hook.cleanup !== 'function') continue;
        const cleanup = hook.cleanup;
        hook.cleanup = undefined;
        try { cleanup(); } catch (err) { errors.push(err); }
      }
      this.container.innerHTML = '';
      this.finishCommit(errors);
    }

    /* 커밋 보고를 받을 콜백을 등록하고 구독 해제 함수를 돌려주는 함수 */
    onCommit(cb) {
      this.listeners.push(cb);
      return () => { this.listeners = this.listeners.filter((l) => l !== cb); };
    }

    /* 측정값을 모아 등록된 콜백에 보내는 함수 */
    report(kind, start, compared, patches, eventOnly, recovered = false) {
      const report = {
        kind,
        ms: performance.now() - start,
        compared,
        eventOnly,
        patches: countPatches(patches),
        hookCount: this.hooks.length,
        recovered,
      };
      for (const cb of this.listeners.slice()) cb(report);
    }

    /* 훅 값과 vdom 의 복사본을 돌려주는 함수 */
    inspect() {
      return {
        hooks: this.hooks.map((hook) => ({ kind: hook.kind, value: hook.value })),
        vdom: this.vdom ? V.clone(this.vdom) : null,
      };
    }
  }

  const api = { FunctionComponent, expand };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MiniReact = Object.assign(root.MiniReact || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
