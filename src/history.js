/* ======================================================================
 * history.js — Patch 기록(State History) 관리
 *
 *   State : { vdom, label, summary, time }
 *   - 초기 State 하나로 시작하고, Patch 할 때마다 push 한다.
 *   - 뒤로 간 상태에서 push 하면 그 뒤의 기록(future)은 버린다.
 *
 *   DOM/UI 를 전혀 다루지 않는다.
 * ====================================================================== */

export const now = () => new Date().toLocaleTimeString('ko-KR', { hour12: false });

/** patch 목록 → 한 줄 요약 (예: "3개 · CREATE, TEXT ×2") */
export const summarize = (patches) => {
  if (!patches.length) return '변경 없음';
  const c = {}; patches.forEach((p) => (c[p.type] = (c[p.type] || 0) + 1));
  return patches.length + '개 · ' + Object.entries(c).map(([k, v]) => k + (v > 1 ? ' ×' + v : '')).join(', ');
};

/** 초기 VDOM 으로 시작하는 기록을 만든다 */
export function createHistory(initialVdom) {
  const states = [{ vdom: initialVdom, label: '초기 상태 (로드)', summary: '샘플 HTML → VDOM', time: now() }];   // 전체 State History
  let cur = 0;                                                                                              // 현재 State 인덱스

  return {
    get states() { return states; },
    get index() { return cur; },
    get current() { return states[cur]; },
    get canBack() { return cur > 0; },
    get canForward() { return cur < states.length - 1; },

    /** 새 VDOM 을 현재 State 뒤에 저장하고 그 State 로 이동한다 (이후 기록은 버림) */
    push(vdom, patches) {
      states.length = cur + 1;
      states.push({ vdom, label: 'Patch ' + states.length, summary: summarize(patches), time: now() });
      cur = states.length - 1;
      return states[cur];
    },

    /** i 번째 State 로 이동할 수 있는가? (범위 안이고 현재 State 가 아님) */
    canGoTo: (i) => i >= 0 && i < states.length && i !== cur,

    /** i 번째 State 로 이동한다. 이동할 수 없으면 false */
    goTo(i) {
      if (i < 0 || i >= states.length || i === cur) return false;
      cur = i;
      return true;
    },
  };
}
