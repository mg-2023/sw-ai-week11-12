/**
 * patch.js — diff 가 만든 "바꿀 일 목록" 을 실제 DOM 에 적용한다
 *
 * 입력: rootEl (Virtual DOM 루트와 짝인 실제 요소), patches (diff 결과)
 * 출력: 루트 요소 (루트 자체가 REPLACE 되면 새 요소)
 *
 * 노드 찾는 법 (결정 4): path 의 번호대로 childNodes 를 걷는다.
 *   전제 — 실제 DOM 의 childNodes 와 Virtual DOM 의 children 이 1:1 이어야 한다.
 *   그래서 처음 한 번은 실제 영역을 Virtual DOM 으로 다시 그려(mount) 들여쓰기 · 주석 노드를 없앤다.
 *
 * 바뀐 노드만 건드린다: 텍스트는 nodeValue, 속성은 그 속성 하나, 자식은 그 자식 하나.
 */
(function (root) {
  'use strict';

  const V = typeof require === 'function' ? require('./vdom.js') : root.MiniReact;

  /** path 번호대로 내려가 실제 노드를 찾는다. 없으면 DOM 과 VDOM 이 어긋난 것 → 에러 */
  function findNode(rootEl, path) {
    let node = rootEl;
    for (let depth = 0; depth < path.length; depth++) {
      const parent = childContainer(node);
      node = parent.childNodes[path[depth]];
      if (!node) {
        throw new Error(`patch: 경로 [${path.join(', ')}] 의 ${depth} 단계에서 노드를 찾지 못했습니다 (DOM 과 Virtual DOM 이 어긋남)`);
      }
    }
    return node;
  }

  /** <template> 는 자식이 .content 안에 있다 */
  function childContainer(el) {
    return el.localName === 'template' && el.content ? el.content : el;
  }

  function applyPatches(rootEl, patches) {
    const doc = rootEl.ownerDocument;
    let currentRoot = rootEl;

    for (const p of patches) {
      switch (p.type) {
        case 'CREATE': {
          // 부모를 찾아 index 자리에 넣는다 (뒤가 비어 있으면 맨 끝)
          const parent = findNode(currentRoot, p.path.slice(0, -1));
          const index = p.path[p.path.length - 1];
          const container = childContainer(parent);
          const before = container.childNodes[index] || null;
          container.insertBefore(V.render(p.node, doc, V.childNamespace(parent)), before);
          break;
        }
        case 'REMOVE': {
          const node = findNode(currentRoot, p.path);
          node.parentNode.removeChild(node);
          break;
        }
        case 'REPLACE': {
          const node = findNode(currentRoot, p.path);
          const parent = node.parentNode;
          // 부모가 없는 문서 조각(template.content 등)도 있으니 parentNode 로 이름공간을 고른다
          const ns = parent && parent.nodeType === 1 ? V.childNamespace(parent) : (node.namespaceURI || V.HTML_NS);
          const fresh = V.render(p.node, doc, ns);
          if (parent) parent.replaceChild(fresh, node);
          if (p.path.length === 0) currentRoot = fresh;
          break;
        }
        case 'TEXT': {
          findNode(currentRoot, p.path).nodeValue = p.value;
          break;
        }
        case 'PROPS': {
          const el = findNode(currentRoot, p.path);
          for (const name of p.remove) V.setProp(el, name, null);
          for (const [name, value] of Object.entries(p.set)) V.setProp(el, name, value);
          break;
        }
        default:
          throw new Error(`patch: 모르는 patch 종류 ${p.type}`);
      }
    }
    return currentRoot;
  }

  /**
   * 처음 한 번: 실제 요소의 자식을 Virtual DOM 대로 다시 그린다.
   * 이 뒤로 rootEl.childNodes 와 vnode.children 이 1:1 로 맞는다.
   * (루트 요소 자체와 그 속성은 그대로 둔다)
   */
  function mount(rootEl, vnode) {
    const doc = rootEl.ownerDocument;
    const container = childContainer(rootEl);
    while (container.firstChild) container.removeChild(container.firstChild);
    const ns = V.childNamespace(rootEl);
    for (const child of vnode.children) container.appendChild(V.render(child, doc, ns));
    return rootEl;
  }

  const api = { applyPatches, findNode, mount };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MiniReact = Object.assign(root.MiniReact || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
