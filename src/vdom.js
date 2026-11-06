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
  const FORM_TAGS = new Set(['input', 'textarea', 'select', 'option']);

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
      // props[attr.name] = … 은 이름이 "__proto__" 면 칸이 안 생긴다
      Object.defineProperty(props, attr.name, { value: attr.value, enumerable: true, writable: true, configurable: true });
    }

    const keep = keepWhitespace || KEEP_WHITESPACE.has(type);
    // <template> 의 자식은 childNodes 가 아니라 .content 안에 있다
    const source = type === 'template' && node.content ? node.content : node;
    return { type, props, children: childrenToVdom(source, keep) };
  }

  /**
   * childNodes 를 차례로 바꾸고, 버린 것은 뺀다. (children 은 요소만 줘서 쓰지 않는다)
   * 주석을 버리면 `a<!--x-->b` 의 a 와 b 가 붙게 된다 → 주석이 없었던 것처럼 "ab" 한 덩어리로 합친다.
   * (안 합치면 HTML 로 썼다 다시 읽을 때 한 개로 읽혀 구조가 달라진다)
   */
  function childrenToVdom(parent, keepWhitespace = false) {
    const out = [];
    let pending = null; // 아직 내보내지 않은 이어진 글자
    const flush = () => {
      if (pending !== null && (keepWhitespace || !isIndentText(pending))) out.push(text(pending));
      pending = null;
    };
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === TEXT_NODE) {
        pending = (pending || '') + child.nodeValue;
        continue;
      }
      if (child.nodeType !== ELEMENT_NODE) continue; // 주석 등: 글자 사이를 끊지 않는다
      flush();
      out.push(domToVdom(child, keepWhitespace));
    }
    flush();
    return out;
  }

  /**
   * HTML 문자열을 읽어 Virtual DOM 자식 배열로 만든다.
   * <template> 안에서 파싱하므로 <img onerror> · <script> 가 실행되지 않는다.
   * 잘못 닫힌 HTML 은 브라우저 파서가 고친 결과를 따른다.
   */
  function htmlToChildren(html, doc = root.document, options = {}) {
    const tpl = doc.createElement('template');
    tpl.innerHTML = html;
    const kids = childrenToVdom(tpl.content, false);
    return options.dropScripts ? mergeTexts(kids.map(stripScripts).filter(Boolean)) : kids;
  }

  /**
   * 사용자가 친 HTML 을 실제 영역에 넣기 전에 실행되는 것을 뺀다.
   *   <script> 는 createElement 로 만들어 붙여도 실행된다 → 노드째 뺀다
   *   onclick="…" 같은 문자열 이벤트 속성 → 뺀다 (Phase 2 의 이벤트는 문자열이 아니라 함수)
   */
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

  /** 노드를 빼고 나면 글자끼리 붙을 수 있다 (`a<script>…</script>b`) → 주석 때와 같이 한 덩어리로 */
  function mergeTexts(kids) {
    const out = [];
    for (const k of kids) {
      const last = out[out.length - 1];
      if (isText(k) && last && isText(last)) out[out.length - 1] = text(last.props.nodeValue + k.props.nodeValue);
      else out.push(k);
    }
    return out;
  }

  /**
   * 테스트 영역 HTML 을 읽어 루트 노드로 감싼다.
   * rootVnode: 이전 루트 (type · props 를 그대로 물려받는다 — 루트는 실제 영역 상자 자체)
   * 기본으로 <script> · on…="문자열" 을 뺀다 (stripScripts)
   */
  function htmlToVdom(html, rootVnode, doc = root.document, options = { dropScripts: true }) {
    return { type: rootVnode.type, props: { ...rootVnode.props }, children: htmlToChildren(html, doc, options) };
  }

  // ───────────────────────── VDOM → DOM ─────────────────────────

  // 이벤트 함수를 요소마다 기억해 두는 곳 (바꿀 때 옛 함수를 떼어 내야 한다)
  const listenerMap = new WeakMap();

  // xlink:href 같은 이름공간 붙은 속성 (SVG <use> 가 쓰는 옛 방식)
  const ATTR_NS = { xlink: 'http://www.w3.org/1999/xlink', xml: 'http://www.w3.org/XML/1998/namespace' };

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
    const attrNs = ATTR_NS[name.split(':')[0]];
    if (remove) {
      el.removeAttribute(name);
    } else if (attrNs && name.includes(':')) {
      el.setAttributeNS(attrNs, name, value === true ? '' : String(value));
    } else {
      el.setAttribute(name, value === true ? '' : String(value));
    }

    // 3) 지금 상태(프로퍼티)도 맞춘다
    // 폼 요소만. <li value> · <progress value> 의 .value 는 숫자라 대입하면 "01"→"1" 로 바뀌거나 예외가 난다
    if (LIVE_PROPS.has(name) && FORM_TAGS.has(el.localName) && el.namespaceURI === HTML_NS) {
      if (name === 'value' && el.type === 'file') {
        // 파일 입력의 .value 는 보안상 '' 만 넣을 수 있다 (다른 값은 예외)
      } else if (name === 'value') {
        el.value = remove ? '' : String(value);
      } else {
        el[name] = !remove; // checked · selected: 속성이 있으면 켜짐
      }
    }
  }

  const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
  // SVG · MathML 안이지만 자식은 다시 HTML 인 요소 (HTML 파서의 "integration point")
  const HTML_INSIDE = {
    [SVG_NS]: new Set(['foreignObject', 'desc', 'title']),
    [MATHML_NS]: new Set(['mi', 'mo', 'mn', 'ms', 'mtext']),
  };

  /** 이 요소의 자식이 쓸 이름공간 (요소 이름과 이 요소의 이름공간으로 정한다) */
  function namespaceForChildren(type, ownNs) {
    if (HTML_INSIDE[ownNs] && HTML_INSIDE[ownNs].has(type)) return HTML_NS;
    return ownNs;
  }

  /** 이 요소 자신의 이름공간 (부모 쪽 이름공간 + 요소 이름) */
  function namespaceFor(type, parentNs) {
    if (type === 'svg') return SVG_NS;
    if (type === 'math') return MATHML_NS;
    return parentNs;
  }

  /** 실제 부모 요소를 보고 새 자식이 쓸 이름공간을 정한다 (patch 가 CREATE 할 때) */
  function childNamespace(parentEl) {
    if (!parentEl || !parentEl.namespaceURI) return HTML_NS;
    return namespaceForChildren(parentEl.localName, parentEl.namespaceURI);
  }

  /**
   * Virtual DOM 노드 하나를 실제 DOM 노드로 만든다 (재귀).
   * innerHTML 을 쓰지 않으니 텍스트는 해석되지 않는다.
   * ns: 부모의 이름공간 (SVG 안이면 createElementNS 로 만들어야 그려진다)
   */
  function render(vnode, doc = root.document, ns = HTML_NS) {
    if (isText(vnode)) return doc.createTextNode(vnode.props.nodeValue);

    const myNs = namespaceFor(vnode.type, ns);
    const el = myNs === HTML_NS ? doc.createElement(vnode.type) : doc.createElementNS(myNs, vnode.type);

    // <select value> 는 option 이 생긴 뒤에야 고를 수 있으니 맨 나중에 넣는다
    const isSelect = vnode.type === 'select';
    for (const [name, value] of Object.entries(vnode.props)) {
      if (isSelect && name === 'value') continue;
      setProp(el, name, value);
    }

    // <template> 는 자식을 .content 에 넣어야 한다
    const target = vnode.type === 'template' && el.content ? el.content : el;
    const kidNs = namespaceForChildren(vnode.type, myNs);
    for (const child of vnode.children) {
      target.appendChild(render(child, doc, kidNs));
    }
    if (isSelect && 'value' in vnode.props) setProp(el, 'value', vnode.props.value);
    return el;
  }

  // ───────────────────────── VDOM → HTML 문자열 ─────────────────────────

  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  // 안의 글자를 이스케이프하면 내용이 바뀌는 요소
  const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);

  // \u00a0(&nbsp;) 와 \r 은 그대로 쓰면 다시 읽을 때 보통 공백 · \n 으로 바뀌므로 문자 참조로 쓴다
  function escapeText(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\u00a0/g, '&nbsp;').replace(/\r/g, '&#13;');
  }
  function escapeAttr(s) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/\u00a0/g, '&nbsp;').replace(/\r/g, '&#13;');
  }

  /**
   * 자식 배열을 HTML 문자열로 만든다. 테스트 영역(textarea)에 보여 줄 때 쓴다.
   * 사람이 고치기 쉽게 들여쓰기를 넣되, 다시 읽어도 같은 Virtual DOM 이 나오게 한다:
   *   - 들여쓰기(줄바꿈 + 공백)는 읽을 때 버려지는 규칙(결정 2)이므로 안전
   *   - 자식에 텍스트가 섞여 있으면 들여쓰기를 넣지 않는다 (글자에 공백이 붙어 버리므로)
   *   - <pre> 안은 들여쓰기를 넣지 않는다
   * 지원 안 함: <plaintext> (닫을 수 없는 옛 요소)
   */
  function toHtml(children, depth = 0, pretty = true) {
    const canIndent = pretty && children.length > 0 && children.every((c) => !isText(c));
    const pad = '  '.repeat(depth);
    return children
      .map((c) => (canIndent ? pad : '') + nodeToHtml(c, depth, pretty, false, HTML_NS))
      .join(canIndent ? '\n' : '');
  }

  /**
   * rawParent: 부모가 HTML 의 <script> · <style> 같은 raw text 요소인가 (그 안 글자는 이스케이프 안 함)
   * ns: 부모 쪽 이름공간 (SVG 안의 <style> 은 raw text 가 아니다)
   */
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
    TEXT, SVG_NS, HTML_NS, MATHML_NS,
    h, text, isText, isIndentText,
    domToVdom, childrenToVdom, htmlToChildren, htmlToVdom, stripScripts,
    render, setProp, childNamespace,
    toHtml, clone,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MiniReact = Object.assign(root.MiniReact || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
