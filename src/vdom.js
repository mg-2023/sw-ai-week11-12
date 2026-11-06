/**
 * vdom.js — Virtual DOM 의 모양과 변환
 *
 * 노드 모양 (모든 노드가 같은 세 칸):
 *   요소   { type: 'p',     props: { class: 'x' },        children: [ ... ] }
 *   텍스트 { type: '#text', props: { nodeValue: 'hi ' },   children: [] }
 *
 * 이 파일이 하는 일:
 *   domToVdom   실제 DOM  → Virtual DOM   (읽기)
 *   htmlToVdom  HTML 문자열 → Virtual DOM (테스트 영역 읽기)
 *   render      Virtual DOM → 실제 DOM    (그리기, innerHTML 을 쓰지 않는다)
 *   setProp     속성 하나를 실제 요소에 반영 (render · patch 가 같이 쓴다)
 *   toHtml      Virtual DOM → HTML 문자열 (테스트 영역에 보여 주기)
 *
 * 브라우저에서는 <script> 로 읽혀 window.MiniReact 에 붙고,
 * Node(테스트)에서는 require 로 읽힌다. (file:// 로 바로 열기 위해 ES 모듈을 쓰지 않음)
 */
(function (root) {
  'use strict';

  const TEXT = '#text';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const HTML_NS = 'http://www.w3.org/1999/xhtml';

  // DOM nodeType 번호
  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;

  // 공백을 그대로 지켜야 하는 요소 (들여쓰기 규칙을 적용하지 않는다)
  const KEEP_WHITESPACE = new Set(['pre', 'textarea', 'listing', 'plaintext']);

  // 지금 상태가 속성(attribute)이 아니라 프로퍼티에 있는 것들
  //   <input value="a"> 에 사용자가 b 를 치면 속성은 a, .value 는 b
  const LIVE_PROPS = new Set(['value', 'checked', 'selected']);

  // ───────────────────────── 노드 만들기 ─────────────────────────

  /** 요소 노드를 만든다. children 은 늘 배열. 문자열 자식은 텍스트 노드로 바꾼다. */
  function h(type, props, ...children) {
    return {
      type,
      props: props ? { ...props } : {},
      children: children.flat(Infinity)
        .filter((c) => c !== null && c !== undefined && c !== false)
        .map((c) => (typeof c === 'object' ? c : text(String(c)))),
    };
  }

  /** 텍스트 노드를 만든다. */
  function text(value) {
    return { type: TEXT, props: { nodeValue: String(value) }, children: [] };
  }

  function isText(vnode) {
    return vnode.type === TEXT;
  }

  // ───────────────────────── DOM → VDOM ─────────────────────────

  /**
   * 이 텍스트를 버릴지 정한다 (결정 2).
   * 버린다 = 공백만 있고 + 줄바꿈이 들어 있다 → 들여쓰기에서 생긴 노드
   * 남긴다 = `<b>a</b> <i>b</i>` 사이의 공백 한 칸처럼 줄바꿈 없는 공백 (화면에 보인다)
   * JSX 가 공백을 다루는 규칙과 같다.
   */
  function isIndentText(value) {
    return /^\s*$/.test(value) && /[\r\n]/.test(value);
  }

  /**
   * 실제 DOM 노드 하나를 Virtual DOM 노드로 바꾼다.
   * 버려야 하는 노드(주석 · 들여쓰기 공백 등)면 null.
   * keepWhitespace: <pre> 안처럼 공백을 지켜야 하는 곳이면 true
   */
  function domToVdom(node, keepWhitespace = false) {
    if (node.nodeType === TEXT_NODE) {
      if (!keepWhitespace && isIndentText(node.nodeValue)) return null;
      return text(node.nodeValue);
    }

    // 주석(8) · 처리명령 · 문서 타입 등은 화면에 안 보이니 버린다 (결정 3)
    if (node.nodeType !== ELEMENT_NODE) return null;

    // localName: HTML 은 소문자, SVG 는 linearGradient 처럼 원래 대소문자 그대로
    const type = node.localName;
    const props = {};
    for (const attr of Array.from(node.attributes)) {
      props[attr.name] = attr.value;
    }

    const keep = keepWhitespace || KEEP_WHITESPACE.has(type);
    // <template> 의 자식은 childNodes 가 아니라 .content 안에 있다
    const source = type === 'template' && node.content ? node.content : node;
    return { type, props, children: childrenToVdom(source, keep) };
  }

  /** childNodes 를 차례로 바꾸고, 버린 것(null)은 뺀다. (children 은 요소만 줘서 쓰지 않는다) */
  function childrenToVdom(parent, keepWhitespace = false) {
    const out = [];
    for (const child of Array.from(parent.childNodes)) {
      const v = domToVdom(child, keepWhitespace);
      if (v) out.push(v);
    }
    return out;
  }

  /**
   * HTML 문자열을 읽어 Virtual DOM 자식 배열로 만든다.
   * <template> 안에서 파싱하므로 <img onerror> · <script> 가 실행되지 않는다.
   * 잘못 닫힌 HTML 은 브라우저 파서가 고친 결과를 따른다.
   */
  function htmlToChildren(html, doc = root.document) {
    const tpl = doc.createElement('template');
    tpl.innerHTML = html;
    return childrenToVdom(tpl.content, false);
  }

  /**
   * 테스트 영역 HTML 을 읽어 루트 노드로 감싼다.
   * rootVnode: 이전 루트 (type · props 를 그대로 물려받는다 — 루트는 실제 영역 상자 자체)
   */
  function htmlToVdom(html, rootVnode, doc = root.document) {
    return { type: rootVnode.type, props: { ...rootVnode.props }, children: htmlToChildren(html, doc) };
  }

  // ───────────────────────── VDOM → DOM ─────────────────────────

  // 이벤트 함수를 요소마다 기억해 두는 곳 (바꿀 때 옛 함수를 떼어 내야 한다)
  const listenerMap = new WeakMap();

  function isEventProp(name, value) {
    return /^on/i.test(name) && typeof value === 'function';
  }

  /**
   * 속성 하나를 실제 요소에 반영한다. value 가 null/undefined/false 면 지운다.
   *  - on… + 함수   → addEventListener (Phase 2 용)
   *  - value · checked · selected → 속성과 프로퍼티를 함께 (지금 상태까지 맞춘다)
   *  - 나머지        → setAttribute / removeAttribute
   * 불리언 속성은 "있음 = 참" 이라 끌 때는 removeAttribute 가 필요하다.
   *   setAttribute('disabled', 'false') 는 오히려 켠다.
   */
  function setProp(el, name, value) {
    // 1) 이벤트 함수
    const listeners = listenerMap.get(el) || {};
    const evt = name.slice(2).toLowerCase();
    if (/^on/i.test(name) && (typeof value === 'function' || typeof listeners[evt] === 'function')) {
      if (listeners[evt]) el.removeEventListener(evt, listeners[evt]);
      if (typeof value === 'function') {
        el.removeAttribute(name); // 문자열 onclick="…" 이 남아 있으면 같이 실행되므로 지운다
        el.addEventListener(evt, value);
        listeners[evt] = value;
      } else {
        delete listeners[evt];
      }
      listenerMap.set(el, listeners);
      if (typeof value === 'function') return;
      // 함수 → 문자열로 바뀐 경우 아래에서 속성으로 처리
    }

    const remove = value === null || value === undefined || value === false;

    // 2) 속성
    if (remove) {
      el.removeAttribute(name);
    } else {
      el.setAttribute(name, value === true ? '' : String(value));
    }

    // 3) 지금 상태(프로퍼티)도 맞춘다
    if (LIVE_PROPS.has(name) && name in el) {
      if (name === 'value') {
        el.value = remove ? '' : String(value);
      } else {
        el[name] = !remove; // checked · selected: 속성이 있으면 켜짐
      }
    }
  }

  /** 자식이 쓸 이름공간: <svg> 안은 SVG, <foreignObject> 안은 다시 HTML */
  function childNamespace(parentEl) {
    if (!parentEl || !parentEl.namespaceURI) return HTML_NS;
    if (parentEl.localName === 'foreignObject') return HTML_NS;
    return parentEl.namespaceURI;
  }

  /**
   * Virtual DOM 노드 하나를 실제 DOM 노드로 만든다 (재귀).
   * innerHTML 을 쓰지 않으니 텍스트는 해석되지 않는다.
   * ns: 부모의 이름공간 (SVG 안이면 createElementNS 로 만들어야 그려진다)
   */
  function render(vnode, doc = root.document, ns = HTML_NS) {
    if (isText(vnode)) return doc.createTextNode(vnode.props.nodeValue);

    let myNs = ns;
    if (vnode.type === 'svg') myNs = SVG_NS;
    const el = myNs === HTML_NS ? doc.createElement(vnode.type) : doc.createElementNS(myNs, vnode.type);

    for (const [name, value] of Object.entries(vnode.props)) {
      setProp(el, name, value);
    }

    // <template> 는 자식을 .content 에 넣어야 한다
    const target = vnode.type === 'template' && el.content ? el.content : el;
    const kidNs = childNamespace(el);
    for (const child of vnode.children) {
      target.appendChild(render(child, doc, kidNs));
    }
    return el;
  }

  // ───────────────────────── VDOM → HTML 문자열 ─────────────────────────

  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  // 안의 글자를 이스케이프하면 내용이 바뀌는 요소
  const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);

  function escapeText(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
  }
  function escapeAttr(s) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/ /g, '&nbsp;');
  }

  /**
   * 자식 배열을 HTML 문자열로 만든다. 테스트 영역(textarea)에 보여 줄 때 쓴다.
   * 사람이 고치기 쉽게 들여쓰기를 넣되, 다시 읽어도 같은 Virtual DOM 이 나오게 한다:
   *   - 들여쓰기(줄바꿈 + 공백)는 읽을 때 버려지는 규칙(결정 2)이므로 안전
   *   - 자식에 텍스트가 섞여 있으면 들여쓰기를 넣지 않는다 (글자에 공백이 붙어 버리므로)
   *   - <pre> 안은 들여쓰기를 넣지 않는다
   */
  function toHtml(children, depth = 0, pretty = true) {
    const canIndent = pretty && children.length > 0 && children.every((c) => !isText(c));
    const pad = '  '.repeat(depth);
    return children
      .map((c) => (canIndent ? pad : '') + nodeToHtml(c, depth, pretty, null))
      .join(canIndent ? '\n' : '');
  }

  function nodeToHtml(vnode, depth, pretty, parentType) {
    if (isText(vnode)) {
      return RAW_TEXT.has(parentType) ? vnode.props.nodeValue : escapeText(vnode.props.nodeValue);
    }
    const attrs = Object.entries(vnode.props)
      .filter(([, v]) => v !== null && v !== undefined && v !== false && typeof v !== 'function')
      .map(([k, v]) => (v === true || v === '' ? ` ${k}` : ` ${k}="${escapeAttr(String(v))}"`))
      .join('');
    const open = `<${vnode.type}${attrs}>`;
    if (VOID.has(vnode.type)) return open;

    const keep = KEEP_WHITESPACE.has(vnode.type);
    const kids = vnode.children;
    const indent = pretty && !keep && kids.length > 0 && kids.every((c) => !isText(c));
    let inner;
    if (indent) {
      const pad = '  '.repeat(depth + 1);
      inner = '\n' + kids.map((c) => pad + nodeToHtml(c, depth + 1, pretty, vnode.type)).join('\n') + '\n' + '  '.repeat(depth);
    } else {
      inner = kids.map((c) => nodeToHtml(c, depth + 1, pretty && !keep, vnode.type)).join('');
      // 파서는 <pre> · <textarea> 바로 뒤 첫 줄바꿈 하나를 지운다 → 글자가 줄바꿈으로 시작하면 하나 더 넣는다
      if (keep && /^\n/.test(inner)) inner = '\n' + inner;
    }
    return `${open}${inner}</${vnode.type}>`;
  }

  /** 깊은 복사 (History 에 넣을 때 바깥에서 고쳐도 기록이 안 바뀌게) */
  function clone(vnode) {
    return {
      type: vnode.type,
      props: { ...vnode.props },
      children: vnode.children.map(clone),
    };
  }

  const api = {
    TEXT, SVG_NS, HTML_NS,
    h, text, isText, isIndentText,
    domToVdom, childrenToVdom, htmlToChildren, htmlToVdom,
    render, setProp, childNamespace,
    toHtml, clone,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MiniReact = Object.assign(root.MiniReact || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
