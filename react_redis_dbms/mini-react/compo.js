/* ======================================================================
 * compo.js — 함수 컴포넌트용 VNode 생성(h)과 펼치기(expand)
 *
 *   h(type, props, ...children)
 *     - type 이 문자열 : { type, props, events?, children }  (기존 VNode + 선택 필드 events)
 *     - type 이 함수   : { type: Component, props }            (expand 할 때 실행된다)
 *   expand(vnode)
 *     - 함수 컴포넌트를 실행해 문자열 type 만 남은 일반 VNode 트리로 펼친다.
 *
 *   h() 가 만드는 VDOM 은 "실제 DOM 에서 읽은 VDOM"(vdom.js)과 같은 모양이어야 검증이 통과한다.
 *     children : 숫자 → 문자열, 배열은 펼침, null/undefined/true/false 버림, 이웃한 문자열은 합침, 빈 문자열 버림
 *     props    : true → '' (disabled 등), false/null/undefined → 넣지 않음, 그 외 → 문자열
 *     on* 함수 : props 가 아닌 events 로 옮긴다 (onClick → events.click)
 *
 *   DOM/UI 를 다루지 않는다.
 * ====================================================================== */

const isEventProp = (name, value) => typeof value === 'function' && /^on[A-Z]/.test(name);

/** children 정규화: 배열 펼치기, 버릴 값 제거, 숫자 → 문자열, 이웃한 문자열 합치기 */
function normalizeChildren(list, out = []) {
  for (const c of list) {
    if (Array.isArray(c)) { normalizeChildren(c, out); continue; }
    if (c === null || c === undefined || typeof c === 'boolean' || c === '') continue;
    const item = typeof c === 'number' ? String(c) : c;
    if (typeof item === 'string' && typeof out[out.length - 1] === 'string') out[out.length - 1] += item;
    else out.push(item);
  }
  return out;
}

/** 요소의 props 정규화 + on* 함수 분리 */
function splitProps(raw) {
  const props = {}, events = {};
  for (const [name, value] of Object.entries(raw || {})) {
    if (isEventProp(name, value)) { events[name.slice(2).toLowerCase()] = value; continue; }
    if (value === false || value === null || value === undefined) continue;
    props[name] = value === true ? '' : String(value);
  }
  return { props, events: Object.keys(events).length ? events : null };
}

/** VNode 생성 */
export function h(type, props, ...children) {
  const kids = normalizeChildren(children);
  if (typeof type === 'function') return { type, props: { ...(props || {}), children: kids } };   // 컴포넌트: props 원본 그대로 전달
  const { props: p, events } = splitProps(props);
  const vnode = { type, props: p };
  if (events) vnode.events = events;
  vnode.children = kids;
  return vnode;
}

/** 함수 컴포넌트를 실행해 일반 VNode 트리로 펼친다. 렌더할 것이 없으면 null */
export function expand(vnode) {
  if (vnode === null || vnode === undefined || typeof vnode === 'boolean') return null;
  if (typeof vnode === 'number') return String(vnode);
  if (typeof vnode === 'string') return vnode;
  if (Array.isArray(vnode)) return normalizeChildren(vnode.map(expand));
  if (typeof vnode.type === 'function') return expand(vnode.type(vnode.props));
  const out = { type: vnode.type, props: vnode.props };
  if (vnode.ns) out.ns = vnode.ns;
  if (vnode.events) out.events = vnode.events;
  // 자식 컴포넌트가 문자열·배열·null 을 돌려줄 수 있으므로 펼친 뒤 다시 정규화한다
  out.children = normalizeChildren(vnode.children.map(expand));
  return out;
}

/** 펼친 결과(노드 / 배열 / null)를 children 배열로 */
export const expandToChildren = (vnode) => normalizeChildren([expand(vnode)]);
