/* Virtual DOM 의 모양을 정하고 DOM · HTML 과 서로 바꾸는 모듈 */
(function (root) {
  'use strict';

  const TEXT = '#text';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const HTML_NS = 'http://www.w3.org/1999/xhtml';

  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;

  const KEEP_WHITESPACE = new Set(['pre', 'textarea', 'listing', 'plaintext']);

  const LIVE_PROPS = new Set(['value', 'checked', 'selected']);
  const FORM_TAGS = new Set(['input', 'textarea', 'select', 'option']);

  /* 요소 노드를 만드는 함수 */
  function h(type, props, ...children) {
    return {
      type,
      props: props ? { ...props } : {},
      children: children.flat(Infinity)
        .filter((c) => c !== null && c !== undefined && c !== false && c !== true)
        .map((c) => (typeof c === 'object' ? c : text(String(c)))),
    };
  }

  /* 텍스트 노드를 만드는 함수 */
  function text(value) {
    return { type: TEXT, props: { nodeValue: String(value) }, children: [] };
  }

  /* 텍스트 노드인지 확인하는 함수 */
  function isText(vnode) {
    return vnode.type === TEXT;
  }

  /* 줄바꿈이 든 공백만 있는 글자(들여쓰기)인지 확인하는 함수 */
  function isIndentText(value) {
    return /^\s*$/.test(value) && /[\r\n]/.test(value);
  }

  /* 실제 DOM 노드 하나를 Virtual DOM 노드로 바꾸는 함수 */
  function domToVdom(node, keepWhitespace = false) {
    if (node.nodeType === TEXT_NODE) {
      if (!keepWhitespace && isIndentText(node.nodeValue)) return null;
      return text(node.nodeValue);
    }

    if (node.nodeType !== ELEMENT_NODE) return null;

    const type = node.localName;
    const props = {};
    for (const attr of Array.from(node.attributes)) {
      Object.defineProperty(props, attr.name, { value: attr.value, enumerable: true, writable: true, configurable: true });
    }

    const keep = keepWhitespace || KEEP_WHITESPACE.has(type);
    const source = type === 'template' && node.content ? node.content : node;
    return { type, props, children: childrenToVdom(source, keep) };
  }

  /* 자식 노드들을 Virtual DOM 배열로 바꾸며 주석 · 들여쓰기를 빼고 이어진 글자를 합치는 함수 */
  function childrenToVdom(parent, keepWhitespace = false) {
    const out = [];
    let pending = null;
    const flush = () => {
      if (pending !== null && (keepWhitespace || !isIndentText(pending))) out.push(text(pending));
      pending = null;
    };
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === TEXT_NODE) {
        pending = (pending || '') + child.nodeValue;
        continue;
      }
      if (child.nodeType !== ELEMENT_NODE) continue;
      flush();
      out.push(domToVdom(child, keepWhitespace));
    }
    flush();
    return out;
  }

  /* HTML 문자열을 실행하지 않고 읽어 Virtual DOM 자식 배열로 만드는 함수 */
  function htmlToChildren(html, doc = root.document, options = {}) {
    const tpl = doc.createElement('template');
    tpl.innerHTML = html;
    const kids = childrenToVdom(tpl.content, false);
    return options.dropScripts ? mergeTexts(kids.map(stripScripts).filter(Boolean)) : kids;
  }

  /* <script> 와 문자열 on… 속성을 빼는 함수 */
  function stripScripts(vnode) {
    if (isText(vnode)) return vnode;
    if (vnode.type === 'script') return null;
    const props = {};
    for (const [k, v] of Object.entries(vnode.props)) {
      if (/^on/i.test(k) && typeof v === 'string') continue;
      Object.defineProperty(props, k, { value: v, enumerable: true, writable: true, configurable: true });
    }
    return { type: vnode.type, props, children: mergeTexts(vnode.children.map(stripScripts).filter(Boolean)) };
  }

  /* 붙어 있는 텍스트 노드를 하나로 합치는 함수 */
  function mergeTexts(kids) {
    const out = [];
    for (const k of kids) {
      const last = out[out.length - 1];
      if (isText(k) && last && isText(last)) out[out.length - 1] = text(last.props.nodeValue + k.props.nodeValue);
      else out.push(k);
    }
    return out;
  }

  /* 테스트 영역 HTML 을 읽어 이전 루트로 감싼 새 Virtual DOM 을 만드는 함수 */
  function htmlToVdom(html, rootVnode, doc = root.document, options = { dropScripts: true }) {
    return { type: rootVnode.type, props: { ...rootVnode.props }, children: htmlToChildren(html, doc, options) };
  }

  const listenerMap = new WeakMap();

  const ATTR_NS = { xlink: 'http://www.w3.org/1999/xlink', xml: 'http://www.w3.org/XML/1998/namespace' };

  /* 속성 하나를 실제 요소에 반영하는 함수 (이벤트 · 속성 · 지금 상태 프로퍼티) */
  function setProp(el, name, value) {
    const listeners = listenerMap.get(el) || {};
    const evt = name.slice(2).toLowerCase();
    if (/^on/i.test(name) && (typeof value === 'function' || typeof listeners[evt] === 'function')) {
      if (listeners[evt]) el.removeEventListener(evt, listeners[evt]);
      if (typeof value === 'function') {
        el.removeAttribute(name);
        el.addEventListener(evt, value);
        listeners[evt] = value;
      } else {
        delete listeners[evt];
      }
      listenerMap.set(el, listeners);
      if (typeof value === 'function') return;
    }

    const remove = value === null || value === undefined || value === false;

    const attrNs = ATTR_NS[name.split(':')[0]];
    if (remove) {
      el.removeAttribute(name);
    } else if (attrNs && name.includes(':')) {
      el.setAttributeNS(attrNs, name, value === true ? '' : String(value));
    } else {
      el.setAttribute(name, value === true ? '' : String(value));
    }

    if (LIVE_PROPS.has(name) && FORM_TAGS.has(el.localName) && el.namespaceURI === HTML_NS) {
      if (name === 'value' && el.type === 'file') {
      } else if (name === 'value') {
        const next = remove ? '' : String(value);
        if (el.value !== next) el.value = next;
      } else {
        el[name] = !remove;
      }
    }
  }

  const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
  const HTML_INSIDE = {
    [SVG_NS]: new Set(['foreignObject', 'desc', 'title']),
    [MATHML_NS]: new Set(['mi', 'mo', 'mn', 'ms', 'mtext']),
  };

  /* 요소의 자식이 쓸 이름공간을 정하는 함수 */
  function namespaceForChildren(type, ownNs) {
    if (HTML_INSIDE[ownNs] && HTML_INSIDE[ownNs].has(type)) return HTML_NS;
    return ownNs;
  }

  /* 요소 자신의 이름공간을 정하는 함수 */
  function namespaceFor(type, parentNs) {
    if (type === 'svg') return SVG_NS;
    if (type === 'math') return MATHML_NS;
    return parentNs;
  }

  /* 실제 부모 요소를 보고 새 자식의 이름공간을 정하는 함수 */
  function childNamespace(parentEl) {
    if (!parentEl || !parentEl.namespaceURI) return HTML_NS;
    return namespaceForChildren(parentEl.localName, parentEl.namespaceURI);
  }

  /* Virtual DOM 노드를 실제 DOM 노드로 만드는 함수 (createElement 재귀) */
  function render(vnode, doc = root.document, ns = HTML_NS) {
    if (isText(vnode)) return doc.createTextNode(vnode.props.nodeValue);

    const myNs = namespaceFor(vnode.type, ns);
    const el = myNs === HTML_NS ? doc.createElement(vnode.type) : doc.createElementNS(myNs, vnode.type);

    const isSelect = vnode.type === 'select';
    for (const [name, value] of Object.entries(vnode.props)) {
      if (isSelect && name === 'value') continue;
      setProp(el, name, value);
    }

    const target = vnode.type === 'template' && el.content ? el.content : el;
    const kidNs = namespaceForChildren(vnode.type, myNs);
    for (const child of vnode.children) {
      target.appendChild(render(child, doc, kidNs));
    }
    if (isSelect && 'value' in vnode.props) setProp(el, 'value', vnode.props.value);
    return el;
  }

  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);

  /* 글자를 HTML 텍스트로 이스케이프하는 함수 */
  function escapeText(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\u00a0/g, '&nbsp;').replace(/\r/g, '&#13;');
  }
  /* 글자를 HTML 속성 값으로 이스케이프하는 함수 */
  function escapeAttr(s) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/\u00a0/g, '&nbsp;').replace(/\r/g, '&#13;');
  }

  /* Virtual DOM 자식 배열을 들여쓴 HTML 문자열로 만드는 함수 */
  function toHtml(children, depth = 0, pretty = true) {
    const canIndent = pretty && children.length > 0 && children.every((c) => !isText(c));
    const pad = '  '.repeat(depth);
    return children
      .map((c) => (canIndent ? pad : '') + nodeToHtml(c, depth, pretty, false, HTML_NS))
      .join(canIndent ? '\n' : '');
  }

  /* Virtual DOM 노드 하나를 HTML 문자열로 만드는 함수 */
  function nodeToHtml(vnode, depth, pretty, rawParent, ns) {
    if (isText(vnode)) {
      return rawParent ? vnode.props.nodeValue : escapeText(vnode.props.nodeValue);
    }
    const attrs = Object.entries(vnode.props)
      .filter(([, v]) => v !== null && v !== undefined && v !== false && typeof v !== 'function')
      .map(([k, v]) => (v === true || v === '' ? ` ${k}` : ` ${k}="${escapeAttr(String(v))}"`))
      .join('');
    const open = `<${vnode.type}${attrs}>`;
    const myNs = namespaceFor(vnode.type, ns);
    if (myNs === HTML_NS && VOID.has(vnode.type)) return open;

    const kidNs = namespaceForChildren(vnode.type, myNs);
    const raw = myNs === HTML_NS && RAW_TEXT.has(vnode.type);
    const keep = myNs === HTML_NS && KEEP_WHITESPACE.has(vnode.type);
    const kids = vnode.children;
    const indent = pretty && !keep && kids.length > 0 && kids.every((c) => !isText(c));
    let inner;
    if (indent) {
      const pad = '  '.repeat(depth + 1);
      inner = '\n' + kids.map((c) => pad + nodeToHtml(c, depth + 1, pretty, raw, kidNs)).join('\n') + '\n' + '  '.repeat(depth);
    } else {
      inner = kids.map((c) => nodeToHtml(c, depth + 1, pretty && !keep, raw, kidNs)).join('');
      if (keep && /^\n/.test(inner)) inner = '\n' + inner;
    }
    return `${open}${inner}</${vnode.type}>`;
  }

  /* Virtual DOM 트리를 복사하는 함수 */
  function clone(vnode) {
    return {
      type: vnode.type,
      props: { ...vnode.props },
      children: vnode.children.map(clone),
    };
  }

  const api = {
    TEXT, SVG_NS, HTML_NS, MATHML_NS,
    h, text, isText, isIndentText,
    domToVdom, childrenToVdom, htmlToChildren, htmlToVdom, stripScripts,
    render, setProp, childNamespace,
    toHtml, clone,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MiniReact = Object.assign(root.MiniReact || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
