/* ======================================================================
 * component.js — 함수형 컴포넌트를 감싸는 FunctionComponent 클래스
 *
 *   함수는 실행이 끝나면 지역 변수가 사라진다. 그래서 "렌더 사이에 남아야 하는 값"(state 등)은
 *   함수 바깥인 이 객체의 hooks 배열에 둔다. 함수는 매번 새로 실행되지만 배열은 그대로 남는다.
 *
 *     hooks    : 훅 슬롯 배열 (상태 저장용). hooks.js 의 useState / useMemo / useEffect 가 이 배열을 읽고 쓴다
 *     mount()  : 처음 렌더링.            hooks 를 비우고 함수를 실행한다
 *     update() : 상태 변경 후 다시 렌더링. hooks 는 그대로 두고 함수만 다시 실행한다
 *
 *   mount / update 는 둘 다 "새 VDOM" 을 돌려줄 뿐 DOM 을 건드리지 않는다.
 *   이전 VDOM 과 Diff 해서 실제 영역에 Patch 하는 일은 root.js 가 한다.
 * ====================================================================== */

import { ROOT } from './vdom.js';
import { h, expandToChildren } from './compo.js';
import { beginRender, resetHooks } from './hooks.js';

export class FunctionComponent {
  constructor(fn, props = null) {
    this.fn = fn;          // 감싸고 있는 함수형 컴포넌트 (예: App)
    this.props = props;
    this.hooks = [];       // 상태 저장용 훅 배열
    this.vdom = null;      // 마지막 렌더 결과
  }

  /** 처음 렌더링: 훅 배열을 비운 뒤 함수를 실행한다 → state 는 초기값부터 시작 */
  mount() {
    this.hooks = [];
    resetHooks(this.hooks);          // hooks.js 가 이 컴포넌트의 배열을 쓰도록 연결
    return this.render();
  }

  /** 상태 변경 후 다시 렌더링: 훅 배열은 그대로 → useState 가 저장해 둔 값을 다시 꺼낸다 */
  update() {
    return this.render();
  }

  /** 커서를 0 으로 되돌리고 함수를 실행해, 자식 컴포넌트까지 펼친 VDOM(#root 로 감쌈)을 만든다 */
  render() {
    beginRender();
    this.vdom = { type: ROOT, props: {}, children: expandToChildren(h(this.fn, this.props)) };
    return this.vdom;
  }
}
