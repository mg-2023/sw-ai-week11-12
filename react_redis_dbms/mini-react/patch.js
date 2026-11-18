/* ======================================================================
 * patch.js — Diff 결과(Patch 목록)를 실제 DOM 에 반영한다
 *
 *   테스트 영역의 HTML → 새 VDOM → 이전 VDOM 과 Diff → 변경된 부분만 실제 영역에 적용
 *   - patchFromHtml : 테스트 영역 HTML 을 읽어 실제 영역에 Patch (Patch 버튼)
 *   - patchToVdom   : 저장된 두 State(VDOM) 사이의 Diff 를 실제 영역에 적용 (뒤로/앞으로)
 *   - applyPatches  : Patch 목록을 DOM 에 적용하는 가장 낮은 단계
 *
 *   UI(깜빡임·로그 출력)는 다루지 않는다. 건드린 노드(touched)만 돌려주고 표시는 호출한 쪽이 한다.
 * ====================================================================== */

import { XHTML, XLINK_NS, XML_NS, childrenHost, containerToVdom, parseHtmlToVdom, vdomEqual } from './vdom.js';
import { diff } from './diff.js';

/* ---------------------------------------------------------------- VNode → 실제 DOM */

/** input / option 은 한번 사용자가 건드리면(dirty) attribute 를 바꿔도 화면 값이 안 바뀐다 → property 도 함께 맞춘다 */
const NON_VALUE_INPUT = new Set(['checkbox', 'radio', 'hidden', 'submit', 'reset', 'button', 'image', 'file']);
function syncFormState(el, name, value) {
  if (el.namespaceURI !== XHTML) return;
  if (el.localName === 'input') {
    if (name === 'value' && !NON_VALUE_INPUT.has(el.type)) el.value = el.defaultValue;   // defaultValue = value attribute
    else if (name === 'checked') el.checked = value !== undefined;
  } else if (el.localName === 'option' && name === 'selected') {
    el.selected = value !== undefined;
  }
}

/** textarea 는 자식 텍스트가 기본값이다. 자식이 바뀌면 화면 값(value)도 기본값으로 되돌린다 */
function syncTextarea(node) {
  const el = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
  const ta = el && el.closest('textarea');
  if (ta) ta.value = ta.defaultValue;
}

function setProp(el, name, value) {
  try {
    if (value === undefined) el.removeAttribute(name);
    else if (name.startsWith('xlink:')) el.setAttributeNS(XLINK_NS, name, value);   // SVG 의 xlink:href 등
    else if (name.startsWith('xml:')) el.setAttributeNS(XML_NS, name, value);
    else el.setAttribute(name, value);
    syncFormState(el, name, value);
  } catch (e) { /* VDOM 에는 rejectAttr 를 통과한 속성만 있으므로 여기까지 오는 일은 거의 없다 (오면 검증 단계에서 불일치로 드러남) */ }
}

/** VNode → 실제 DOM */
export function createDom(vnode) {
  if (typeof vnode === 'string') return document.createTextNode(vnode);
  const el = vnode.ns ? document.createElementNS(vnode.ns, vnode.type) : document.createElement(vnode.type);  // svg 는 SVG 네임스페이스로
  for (const [name, value] of Object.entries(vnode.props)) setProp(el, name, value);
  const host = childrenHost(el);                                                                              // <template> 은 .content 에 넣는다
  vnode.children.forEach((child) => host.appendChild(createDom(child)));
  return el;
}

/**
 * 실제 DOM 을 VDOM 과 1:1 로 맞춘다. path 기반 Patch 는 "DOM 의 childNodes 인덱스 = VDOM 의 children 인덱스" 여야 하므로,
 * 영역을 VDOM 에서 다시 만들어 들여쓰기 공백·주석·금지 태그 등을 같은 규칙으로 정리한다. 변환한 VDOM 을 돌려준다.
 */
export function normalizeDom(container) {
  const vdom = containerToVdom(container);
  container.replaceChildren(...vdom.children.map(createDom));
  return vdom;
}

/* ---------------------------------------------------------------- Patch 적용 */
const getNode = (container, path) => path.reduce((node, i) => childrenHost(node).childNodes[i], container);

/** patch 목록을 실제 DOM 에 적용하고, 건드린 노드들을 돌려준다(깜빡임 표시용) */
export function applyPatches(container, patches) {
  const touched = [];
  const touch = (node) => { touched.push(node); syncTextarea(node); };
  for (const patch of patches) {
    const { type, path } = patch;
    switch (type) {
      case 'CREATE': {
        const node = createDom(patch.vnode);
        childrenHost(getNode(container, path.slice(0, -1))).appendChild(node);
        touch(node); break;
      }
      case 'REMOVE': {
        const node = getNode(container, path), parent = node.parentNode;
        node.remove(); touch(parent); break;
      }
      case 'REPLACE': {
        const node = createDom(patch.vnode);
        getNode(container, path).replaceWith(node);
        touch(node); break;
      }
      case 'TEXT': {
        const node = getNode(container, path);
        node.nodeValue = patch.text; touch(node); break;
      }
      case 'PROPS': {
        const el = getNode(container, path);
        for (const { name, newValue } of patch.changes) setProp(el, name, newValue);
        touch(el); break;
      }
    }
  }
  return touched;
}

/** applyPatches 를 실행하면서 MutationObserver 로 "실제로 건드려진 DOM 수"를 센다 */
function applyAndMeasure(container, patches) {
  const mo = new MutationObserver(() => {});
  mo.observe(container, { childList: true, attributes: true, characterData: true, subtree: true });
  const touched = applyPatches(container, patches);
  let mutated = 0;
  for (const r of mo.takeRecords()) {
    if (r.type === 'childList') {
      const cnt = (n) => { let c = 1; n.childNodes.forEach((k) => (c += cnt(k))); return c; };
      r.addedNodes.forEach((n) => (mutated += cnt(n)));
      r.removedNodes.forEach((n) => (mutated += cnt(n)));
    } else mutated += 1;
  }
  mo.disconnect();
  return { mutated, touched };
}

/** patches 를 적용하고, 결과 DOM 이 목표 VDOM(target)과 같은지 검증한다 */
function applyAndVerify(container, patches, target) {
  const { mutated, touched } = applyAndMeasure(container, patches);
  const verified = vdomEqual(containerToVdom(container), target);
  return { mutated, touched, verified };
}

/* ---------------------------------------------------------------- 공개 동작 */

/**
 * 테스트 영역의 HTML 을 실제 영역에 Patch 한다.
 *   ① HTML → 새 VDOM   ② 이전 VDOM 과 Diff   ③ 변경된 부분만 container 에 적용   ④ 결과 검증
 * 반환: { next, patches, dropped, mutated?, touched?, verified? }
 *   - dropped : VDOM 변환에서 제외된 항목(보안·호환성) 메시지 배열
 *   - patches 가 비어 있으면 DOM 은 건드리지 않으며 mutated/touched/verified 는 없다
 */
export function patchFromHtml(container, prevVdom, html) {
  const dropped = new Set();
  const next = parseHtmlToVdom(html, (m) => dropped.add(m));
  const patches = diff(prevVdom, next);
  const result = { next, patches, dropped: [...dropped] };
  if (!patches.length) return result;
  return { ...result, ...applyAndVerify(container, patches, next) };
}

/**
 * container 를 fromVdom 상태에서 toVdom 상태로 바꾼다 (두 State 사이의 Diff 만 적용).
 * 반환: { patches, mutated, touched, verified }
 */
export function patchToVdom(container, fromVdom, toVdom) {
  const patches = diff(fromVdom, toVdom);
  return { patches, ...applyAndVerify(container, patches, toVdom) };
}
