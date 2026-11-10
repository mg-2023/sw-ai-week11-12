/* 함수형 컴포넌트를 펼쳐 컨테이너에 그리고 측정 결과를 보고하는 모듈 */
/*
 * 흐름 지도
 *   mount  : renderTree(run → expand) → 컨테이너로 감싸기 → 커밋(P.mount → effect → 보고) → settle
 *   update : updateOnce → settle (밀린 setState 가 있으면 updateOnce 를 되풀이)
 *   updateOnce : 시작 시각 → 렌더(renderOrUndo) → diff → 커밋(applyOrRecover → effect → 보고)
 *   실패 처리 : 렌더 예외는 undo, patch 예외는 새 vdom 으로 복구(그것도 실패하면 직전 vdom + undo)
 *   파일 순서 : 펼치기 → 정상 흐름 → 실패 처리 → 측정
 */
(function (root) {
  'use strict';

  const V = typeof require === 'function' ? require('./vdom.js') : root.MiniReact;
  const P = typeof require === 'function' ? require('./patch.js') : root.MiniReact;
  const D = typeof require === 'function' ? require('./diff.js') : root.MiniReact;
  const H = typeof require === 'function' ? require('./hooks.js') : root.MiniReact;

  // ───────── 1. 펼치기 : 함수 컴포넌트를 부르며 vnode 트리로 만든다 ─────────

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
    // ───────── 2. 정상 흐름 : 만들기 → 그리기 → 갱신 → 정리 ─────────

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
      this.queued = [];
    }

    /* 함수를 실행해 펼친 트리로 컨테이너를 처음 그리고 보고하는 함수 */
    mount() {
      if (this.mounted) throw new Error('FunctionComponent: 이미 mount 되었습니다');
      const start = performance.now();
      const vdom = this.wrapInContainer(this.renderTree());
      const errors = this.inCommitPhase(() => {
        P.mount(this.container, vdom);
        P.syncFormState(this.container, vdom, { controlledOnly: true });
        this.vdom = vdom;
        this.mounted = true;
        return this.runEffects().concat(this.report('mount', start, 0, [], 0));
      });
      this.settle(errors);
    }

    /* 한 번 갱신하고 커밋 중 밀린 setState 가 있으면 이어서 갱신하는 함수 */
    update(undo) {
      // undo 는 내부용 선택 인자다 (공개 사용은 update())
      this.settle(this.updateOnce(undo));
    }

    /* 다시 렌더해 diff 한 patch 만 적용하고 effect 를 돌린 뒤 보고하는 함수 (effect · onCommit 예외는 목록으로 돌려줌) */
    updateOnce(undo) {
      const start = performance.now();
      const vdom = this.wrapInContainer(this.renderOrUndo(undo));
      const stats = { compared: 0, eventOnly: 0 };
      const patches = D.diff(this.vdom, vdom, stats);
      return this.inCommitPhase(() => {
        const recovered = this.applyOrRecover(patches, vdom, undo);
        this.vdom = vdom;
        return this.runEffects().concat(this.report('update', start, stats.compared, patches, stats.eventOnly, recovered));
      });
    }

    /* 펼친 트리를 컨테이너 태그로 감싼 최상위 vdom 으로 만드는 함수 */
    wrapInContainer(tree) {
      return { type: this.container.localName, props: {}, children: tree ? [tree] : [] };
    }

    /* phase 를 commit 으로 두고 fn 을 실행한 뒤 (예외여도) idle 로 되돌리는 함수 */
    inCommitPhase(fn) {
      this.phase = 'commit';
      try {
        return fn();
      } finally {
        this.phase = 'idle';
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

    /* 모은 effect 를 훅 순서대로 돌리고 던진 예외를 목록으로 돌려주는 함수 */
    runEffects() {
      const errors = [];
      const list = this.pendingEffects;
      this.pendingEffects = [];
      for (const effect of list) {
        if (this.destroyed) break;
        try {
          this.runOneEffect(effect);
        } catch (err) {
          errors.push(err);
        }
      }
      return errors;
    }

    /* effect 하나를 (이전 cleanup → 실행 → 새 cleanup 저장) 순서로 돌리는 함수 (예외는 부른 쪽이 모은다) */
    runOneEffect({ slot, fn, deps }) {
      const old = slot.cleanup;
      slot.cleanup = undefined;
      if (typeof old === 'function') old();
      // deps 를 fn 보다 먼저 갱신한다: 던진 effect 는 같은 deps 로 다시 시도하지 않는다 (의도)
      slot.deps = deps;
      const result = fn();
      const cleanup = typeof result === 'function' ? result : undefined;
      // effect 안에서 destroy 가 불렸다면 이 cleanup 은 저장되지 못하니 바로 실행한다
      if (this.destroyed) { if (cleanup) cleanup(); } else slot.cleanup = cleanup;
    }

    /* 모든 effect cleanup 을 훅 순서로 실행하고 컨테이너를 비우는 함수 (cleanup 예외는 모아서 마지막에 던진다) */
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.listeners = [];
      this.queued = [];
      this.pendingUpdate = false;
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

    // ───────── 3. 실패 처리 : 되돌리기 · 복구 · 밀린 갱신 · 예외 모으기 ─────────

    /* 렌더하다 던지면 undo 로 값을 되돌리고 같은 예외를 다시 던지는 함수 */
    renderOrUndo(undo) {
      try {
        return this.renderTree();
      } catch (err) {
        if (undo) undo();
        throw err;
      }
    }

    /* patch 를 적용하고 실패하면 새 vdom 으로 다시 그려 복구했는지(true) 돌려주는 함수 (그것도 실패하면 직전 vdom 으로 맞추고 undo 한 뒤 던짐) */
    applyOrRecover(patches, vdom, undo) {
      try {
        P.applyPatches(this.container, patches);
        P.syncFormState(this.container, vdom, { controlledOnly: true });
        return false;
      } catch (err) {
        try {
          this.swapChildren(vdom);
          return true;
        } catch (err2) {
          // 새 vdom 도 못 그리면 직전 vdom 으로 화면을 맞추고 값을 되돌린 뒤 다시 던진다
          // (사용자가 비제어 input 에 친 글자는 통째로 다시 만들어지므로 남지 않는다)
          this.swapChildren(this.vdom);
          if (undo) undo();
          throw err2;
        }
      }
    }

    /* vdom 의 자식을 먼저 조각(fragment)에 다 만든 뒤에야 컨테이너와 바꿔 끼우는 함수 (만들다 던지면 화면은 그대로) */
    swapChildren(vdom) {
      const doc = this.container.ownerDocument;
      const target = this.container.localName === 'template' && this.container.content ? this.container.content : this.container;
      const ns = V.childNamespace(this.container);
      const fragment = doc.createDocumentFragment();
      for (const child of vdom.children) fragment.appendChild(V.render(child, doc, ns));
      while (target.firstChild) target.removeChild(target.firstChild);
      target.appendChild(fragment);
      P.syncFormState(this.container, vdom, { controlledOnly: true });
    }

    /* 커밋 중 setState 로 밀린 갱신을 먼저 처리한 뒤 붙잡아 둔 effect · onCommit 예외를 던지는 함수 (갱신 자체의 예외가 이기고, 붙잡은 예외는 heldErrors 에 붙인다) */
    settle(held) {
      try {
        this.flushPending(held);
      } catch (err) {
        if (held.length > 0 && err && typeof err === 'object') err.heldErrors = held;
        throw err;
      }
      this.finishCommit(held);
    }

    /* 밀린 갱신을 update 한 번씩으로 처리하는 함수 (렌더 예외 · 연쇄 50 번 초과면 그 묶음의 값을 되돌림) */
    flushPending(held) {
      let chain = 0;
      while (this.pendingUpdate && !this.destroyed) {
        const batch = this.queued;
        this.queued = [];
        this.pendingUpdate = false;
        chain += 1;
        if (chain > 50) {
          this.restoreQueued(batch);
          throw new Error('update loop');
        }
        held.push(...this.updateOnce(() => this.restoreQueued(batch)));
      }
    }

    /* 밀린 값을 되돌리는 함수 (같은 Hook 은 맨 처음 값으로) */
    restoreQueued(batch) {
      for (const { hook, prev } of batch) hook.value = prev;
    }

    /* 커밋 중 예외(effect · onCommit · destroy cleanup)가 하나면 그대로, 여럿이면 AggregateError 로 던지는 함수 */
    finishCommit(errors) {
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, '커밋 중 예외 여러 개');
    }

    /* 상태가 그대로인 setState 뒤 제어 입력의 화면 값을 지금 vdom 대로 되돌리는 함수 (렌더 · 보고 없음) */
    resyncForms() {
      if (!this.mounted || this.destroyed || this.phase !== 'idle') return;
      P.syncFormState(this.container, this.vdom, { controlledOnly: true });
    }

    // ───────── 4. 측정 : 보고 · 구독 · 들여다보기 ─────────

    /* 측정값을 모아 등록된 콜백에 보내고 콜백이 던진 예외 목록을 돌려주는 함수 */
    report(kind, start, compared, patches, eventOnly, recovered = false) {
      const report = {
        kind,
        ms: performance.now() - start, // effect 실행 시간 포함
        compared,
        eventOnly,
        patches: countPatches(patches),
        hookCount: this.hooks.length,
        recovered,
      };
      const errors = [];
      for (const cb of this.listeners.slice()) {
        try { cb(report); } catch (err) { errors.push(err); }
      }
      return errors;
    }

    /* 커밋 보고를 받을 콜백을 등록하고 구독 해제 함수를 돌려주는 함수 */
    onCommit(cb) {
      this.listeners.push(cb);
      return () => { this.listeners = this.listeners.filter((l) => l !== cb); };
    }

    /* 훅 값과 vdom 의 복사본을 돌려주는 함수 */
    inspect() {
      return {
        hooks: this.hooks.map((hook) => ({ kind: hook.kind, value: hook.value })),
        vdom: this.vdom ? V.clone(this.vdom) : null,
      };
    }
  }

  /* 패치 종류별 개수를 세어 다섯 키가 모두 있는 객체로 돌려주는 함수 */
  function countPatches(patches) {
    const counts = { CREATE: 0, REMOVE: 0, REPLACE: 0, TEXT: 0, PROPS: 0 };
    for (const p of patches) counts[p.type] += 1;
    return counts;
  }

  const api = { FunctionComponent, expand };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MiniReact = Object.assign(root.MiniReact || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
