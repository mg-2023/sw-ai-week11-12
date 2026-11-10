/* 함수형 컴포넌트를 펼쳐 컨테이너에 그리고 측정 결과를 보고하는 모듈 */
(function (root) {
  'use strict';

  const V = typeof require === 'function' ? require('./vdom.js') : root.MiniReact;
  const P = typeof require === 'function' ? require('./patch.js') : root.MiniReact;
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

  /* vnode 트리를 훑어 자식의 null · 불리언 · 글자를 정리한 새 트리를 만드는 함수 */
  function expand(node) {
    const vnode = normalize(node);
    if (vnode === null) return null;
    const children = [];
    for (const child of vnode.children) {
      const out = expand(child);
      if (out !== null) children.push(out);
    }
    return { type: vnode.type, props: vnode.props, children };
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
    }

    /* 함수를 실행해 펼친 트리로 컨테이너를 처음 그리고 보고하는 함수 */
    mount() {
      if (this.mounted) throw new Error('FunctionComponent: 이미 mount 되었습니다');
      const start = performance.now();
      const result = this.run();
      const tree = expand(result);
      const vdom = { type: this.container.localName, props: {}, children: tree ? [tree] : [] };
      P.mount(this.container, vdom);
      P.syncFormState(this.container, vdom, { controlledOnly: true });
      this.vdom = vdom;
      this.mounted = true;
      // effect 단계 자리 (다음 작업에서 채움)
      this.report('mount', start, 0, [], 0);
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

    /* 다시 그리는 함수 (다음 작업에서 구현) */
    update() {
      throw new Error('update: not implemented yet');
    }

    /* 컴포넌트를 정리하는 함수 (구독 해제만, effect 정리는 다음 작업) */
    destroy() {
      this.listeners = [];
    }

    /* 커밋 보고를 받을 콜백을 등록하고 구독 해제 함수를 돌려주는 함수 */
    onCommit(cb) {
      this.listeners.push(cb);
      return () => { this.listeners = this.listeners.filter((l) => l !== cb); };
    }

    /* 측정값을 모아 등록된 콜백에 보내는 함수 */
    report(kind, start, compared, patches, eventOnly) {
      const report = {
        kind,
        ms: performance.now() - start,
        compared,
        eventOnly,
        patches: countPatches(patches),
        hookCount: this.hooks.length,
        recovered: false,
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
