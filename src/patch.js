/* diff 가 만든 patch 목록을 실제 DOM 에 바뀐 곳만 적용하는 모듈 */
(function (root) {
  'use strict';

  const V = typeof require === 'function' ? require('./vdom.js') : root.MiniReact;

  /* 경로 번호대로 childNodes 를 내려가 실제 노드를 찾는 함수 */
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

  /* 자식이 들어 있는 곳(template 이면 .content)을 돌려주는 함수 */
  function childContainer(el) {
    return el.localName === 'template' && el.content ? el.content : el;
  }

  /* patch 목록을 순서대로 실제 DOM 에 적용하고 루트를 돌려주는 함수 */
  function applyPatches(rootEl, patches, doc = rootEl ? rootEl.ownerDocument : root.document) {
    let currentRoot = rootEl;

    for (const p of patches) {
      if (p.path.length === 0 && (p.type === 'CREATE' || p.type === 'REMOVE')) {
        const parent = currentRoot && currentRoot.parentNode;
        const ns = parent && parent.nodeType === 1 ? V.childNamespace(parent) : V.HTML_NS;
        const fresh = p.type === 'CREATE' ? V.render(p.node, doc, ns) : null;
        if (parent) {
          if (fresh) parent.replaceChild(fresh, currentRoot);
          else parent.removeChild(currentRoot);
        }
        currentRoot = fresh;
        continue;
      }
      switch (p.type) {
        case 'CREATE': {
          const parent = findNode(currentRoot, p.path.slice(0, -1));
          const index = p.path[p.path.length - 1];
          const container = childContainer(parent);
          const before = container.childNodes[index] || null;
          container.insertBefore(V.render(p.node, doc, V.childNamespace(parent)), before);
          syncTextarea(parent);
          break;
        }
        case 'REMOVE': {
          const node = findNode(currentRoot, p.path);
          const parent = node.parentNode;
          parent.removeChild(node);
          syncTextarea(parent);
          break;
        }
        case 'REPLACE': {
          const node = findNode(currentRoot, p.path);
          const parent = node.parentNode;
          const ns = parent && parent.nodeType === 1 ? V.childNamespace(parent) : V.HTML_NS;
          const fresh = V.render(p.node, doc, ns);
          if (parent) parent.replaceChild(fresh, node);
          syncTextarea(parent);
          if (p.path.length === 0) currentRoot = fresh;
          break;
        }
        case 'TEXT': {
          const node = findNode(currentRoot, p.path);
          node.nodeValue = p.value;
          syncTextarea(node.parentNode);
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

  /* textarea 의 화면 값(.value)을 글자 자식과 맞추는 함수 */
  function syncTextarea(el) {
    if (el && el.localName === 'textarea' && el.namespaceURI === V.HTML_NS) el.value = el.textContent;
  }

  /* 폼 요소의 지금 상태(입력값 · 체크 · 선택)를 Virtual DOM 대로 맞추는 함수 */
  function syncFormState(el, vnode, opts) {
    if (!el || !vnode || V.isText(vnode) || el.nodeType !== 1) return;
    const p = vnode.props;
    const controlled = !!(opts && opts.controlledOnly);
    const own = (k) => Object.prototype.hasOwnProperty.call(p, k);
    const has = (k) => Object.prototype.hasOwnProperty.call(p, k) && p[k] !== null && p[k] !== false && p[k] !== undefined;
    if (el.localName === 'input' && el.namespaceURI === V.HTML_NS) {
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (!controlled) el.checked = has('checked');
        else if (own('checked') && el.checked !== has('checked')) el.checked = has('checked');
      } else if (el.type !== 'file') {
        if (!controlled) el.value = has('value') ? String(p.value) : '';
        else if (own('value') && el.value !== String(p.value)) el.value = String(p.value);
      }
    } else if (el.localName === 'textarea') {
      if (!controlled) el.value = el.textContent;
      else if (own('value') && el.value !== String(p.value)) el.value = String(p.value);
    } else if (el.localName === 'option') {
      if (!controlled) el.selected = has('selected');
      else if (own('selected') && el.selected !== has('selected')) el.selected = has('selected');
    }
    const container = childContainer(el);
    vnode.children.forEach((child, i) => syncFormState(container.childNodes[i], child, opts));
    if (el.localName === 'select' && has('value') && !(controlled && el.value === String(p.value))) el.value = String(p.value);
  }

  /* 실제 요소의 자식을 Virtual DOM 대로 다시 그려 1:1 로 맞추는 함수 */
  function mount(rootEl, vnode) {
    const doc = rootEl.ownerDocument;
    const container = childContainer(rootEl);
    while (container.firstChild) container.removeChild(container.firstChild);
    const ns = V.childNamespace(rootEl);
    for (const child of vnode.children) container.appendChild(V.render(child, doc, ns));
    return rootEl;
  }

  const api = { applyPatches, findNode, mount, syncFormState };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MiniReact = Object.assign(root.MiniReact || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
