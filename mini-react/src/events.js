/* ======================================================================
 * events.js — 이벤트 위임
 *
 *   핸들러를 DOM 노드에 붙이지 않는다. container 에 click 리스너 하나만 달고,
 *   클릭된 DOM 노드의 경로(childNodes 인덱스 배열)로 "현재 VDOM" 을 따라 내려가 events.click 을 찾는다.
 *   → 핸들러는 항상 최신 VDOM 에서 찾으므로, 렌더마다 함수가 새로 만들어져도 DOM 을 바꿀 필요가 없다.
 *
 *   VDOM 의 children 인덱스 = DOM 의 childNodes 인덱스 (normalizeDom / patch 가 1:1 로 맞춰 둔다)
 * ====================================================================== */

/** DOM 노드 → container 기준 인덱스 경로. container 밖이면 null */
export function pathOf(container, node) {
  const path = [];
  for (let n = node; n !== container; n = n.parentNode) {
    if (!n || !n.parentNode) return null;
    path.unshift(Array.prototype.indexOf.call(n.parentNode.childNodes, n));
  }
  return path;
}

/** 경로를 따라 내려가며 지나는 VNode 들 (루트 포함). 경로가 VDOM 과 어긋나면 거기서 멈춘다 */
function vnodesAlong(root, path) {
  const chain = [root];
  let v = root;
  for (const i of path) {
    v = v && typeof v === 'object' ? v.children[i] : undefined;
    if (v === undefined) break;
    chain.push(v);
  }
  return chain;
}

/** container 에 type 이벤트 위임 리스너를 등록한다. 해제 함수를 돌려준다 */
export function delegate(container, getVdom, type = 'click') {
  const listener = (e) => {
    const path = pathOf(container, e.target);
    if (!path) return;
    const chain = vnodesAlong(getVdom(), path);
    // 클릭된 노드부터 부모 쪽으로 올라가며 핸들러를 찾는다 (버튼 안의 텍스트를 눌러도 버튼 핸들러가 실행되도록)
    for (let k = chain.length - 1; k >= 0; k--) {
      const handler = typeof chain[k] === 'object' && chain[k].events && chain[k].events[type];
      if (handler) { handler(e); return; }
    }
  };
  container.addEventListener(type, listener);
  return () => container.removeEventListener(type, listener);
}
