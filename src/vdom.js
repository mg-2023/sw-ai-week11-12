/* ======================================================================
 * vdom.js — DOM ↔ Virtual DOM 변환
 *
 *   VNode : { type, props, children }   (텍스트 노드는 문자열)
 *   - 실제 DOM / HTML 문자열 → VDOM   (domToVdom, containerToVdom, parseHtmlToVdom)
 *   - VDOM → HTML 문자열              (serializeNode, serializeRoot)
 *   - VDOM 비교                       (vdomEqual)
 *
 *   이 모듈은 다른 모듈에 의존하지 않는다.
 * ====================================================================== */

export const ROOT = '#root';   // 영역(컨테이너) 자체를 나타내는 가상 루트. 영역의 최상위 노드가 여러 개여도 다룰 수 있다.
export const XHTML = 'http://www.w3.org/1999/xhtml';
export const XLINK_NS = 'http://www.w3.org/1999/xlink';
export const XML_NS = 'http://www.w3.org/XML/1998/namespace';

// VDOM 에 넣지 않는 태그 (코드 실행 / 페이지 전체에 영향 / 파싱이 깨지는 태그)
const SKIP_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'plaintext']);
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href']);

// 내용이 통째로 "텍스트 하나"로 파싱되는 요소(RAWTEXT). 직렬화할 때 &, <, > 를 이스케이프하면 안 된다.
const RAW_TEXT_TAGS = new Set(['xmp', 'noembed', 'noframes']);
// noscript 는 파서에 따라 다르다: 스크립트가 켜진 문맥이면 RAWTEXT, 아니면(template 안 파싱 등) 일반 요소. 실제로 파싱해 보고 결정한다.
{
  const t = document.createElement('template');
  t.innerHTML = '<noscript><i></i></noscript>';
  if (t.content.firstChild.firstChild.nodeType === Node.TEXT_NODE) RAW_TEXT_TAGS.add('noscript');
}
// 공백·줄바꿈이 그대로 의미를 갖는 요소 (이 안에서는 공백 텍스트를 지우거나 정리하지 않는다)
const PRESERVE_TAGS = new Set(['pre', 'textarea', 'listing', 'noscript', ...RAW_TEXT_TAGS]);
const PRESERVE_SELECTOR = [...PRESERVE_TAGS].join(',');
// HTML 파서가 여는 태그 바로 뒤의 첫 "\n" 한 개를 버리는 요소
const FIRST_NEWLINE_TAGS = new Set(['pre', 'textarea', 'listing']);

// 블록 레벨(앞뒤 공백이 화면에 영향을 주지 않는) 요소. display:block/table/list-item 계열.
const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'blockquote', 'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog',
  'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup',
  'hr', 'li', 'listing', 'main', 'menu', 'nav', 'ol', 'optgroup', 'option', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td',
  'template', 'tfoot', 'th', 'thead', 'tr', 'ul', 'xmp']);
// SVG / MathML 에서 공백이 의미를 갖는 요소: 텍스트 컨테이너(text, mtext, mi …)와, 안쪽에 HTML 인라인 요소가 들어오는 통합 지점(foreignObject, annotation-xml …)
const FOREIGN_TEXT = new Set(['text', 'tspan', 'textPath', 'mtext', 'mi', 'mn', 'mo', 'ms', 'foreignObject', 'desc', 'title', 'annotation-xml']);
const WS_ONLY = /^[ \t\n\f\r]+$/;                          // HTML 공백만 (&nbsp; 는 공백이 아님)

/** <template> 의 자식은 childNodes 가 아니라 .content 안에 있다. 자식을 다룰 때는 이 "호스트"를 거친다. */
export const childrenHost = (node) =>
  node.nodeType === Node.ELEMENT_NODE && node.localName === 'template' && node.namespaceURI === XHTML ? node.content : node;

/* ---------------------------------------------------------------- DOM → VDOM */

/**
 * setProp 이 실제로 쓰는 방식(setAttribute / setAttributeNS)으로 설정할 수 있는 속성 이름인가?
 * (innerHTML 파서는 ',' '@click' 같은 이름도 허용하지만 setAttribute 는 예외를 던진다.
 *  xlink: / xml: 은 setAttributeNS 의 엄격한 QName 규칙을 따르므로 'xlink:' 'xlink:a:b' 도 걸러야 한다)
 */
const attrNameOk = (() => {
  const probe = document.createElement('div'), cache = new Map();
  return (name) => {
    if (!cache.has(name)) {
      let ok = true;
      try {
        const ns = name.startsWith('xlink:') ? XLINK_NS : name.startsWith('xml:') ? XML_NS : null;
        if (ns) {
          probe.setAttributeNS(ns, name, '');
          // 브라우저에 따라 'xlink:a:b' 는 예외 없이 'xlink:a' 로 잘려 만들어진다 → 만들어진 이름이 요청한 이름과 같아야 통과
          ok = probe.attributes.length === 1 && probe.attributes[0].name === name;
        } else {
          probe.setAttribute(name, '');   // (HTML 요소는 이름을 소문자로 바꾸므로 viewBox 등은 이름 비교를 하지 않는다)
        }
      } catch (e) { ok = false; }
      while (probe.attributes.length) probe.removeAttributeNode(probe.attributes[0]);
      cache.set(name, ok);
    }
    return cache.get(name);
  };
})();

/** createDom 이 만들었을 때 localName 이 그대로 유지되는 태그 이름인가? ('m::row' 는 예외, 'mml:mrow' 는 접두사가 분리되어 localName 이 달라진다) */
const tagNameOk = (() => {
  const cache = new Map();
  return (ns, name) => {
    const key = ns + '|' + name;
    if (!cache.has(key)) {
      let ok = true;
      try { ok = (ns === XHTML ? document.createElement(name) : document.createElementNS(ns, name)).localName === name; } catch (e) { ok = false; }
      cache.set(key, ok);
    }
    return cache.get(key);
  };
})();

/**
 * 파서가 만든 요소의 localName → VDOM 에 쓸 태그 이름 (쓸 수 없으면 '').
 * SVG/MathML 의 'mml:mrow' 처럼 XML 접두사가 붙은 이름은 HTML 파서가 접두사를 분리하지 않고 통째로 localName 에 넣는다.
 * 그대로 createElementNS 하면 접두사가 분리되어 검증이 어긋나므로 접두사를 떼어 'mrow' 로 정규화한다.
 */
function resolveTag(ns, name) {
  if (ns !== XHTML && name.includes(':')) {
    const local = name.slice(name.indexOf(':') + 1);
    if (local.includes(':')) return '';
    name = local;
  }
  return tagNameOk(ns, name) ? name : '';
}

/** 속성을 VDOM 에 넣으면 안 되는 이유(없으면 ''). */
function rejectAttr(name, value) {
  const lower = name.toLowerCase();
  if (lower.startsWith('on')) return '이벤트 핸들러';
  if (!attrNameOk(name)) return '잘못된 속성 이름';
  // 브라우저는 URL 을 해석할 때 탭/줄바꿈/제어문자를 무시하므로(java&#9;script:) 제거한 뒤 검사한다
  if (URL_ATTRS.has(lower) && /^\s*javascript:/i.test(value.replace(/[\u0000-\u001f\u007f]+/g, ''))) return 'javascript: 링크';
  return '';
}

const noop = () => {};
const isBlockish = (item) => typeof item === 'object' && !item.ns && (BLOCK_TAGS.has(item.type) || item.type === 'br');

/**
 * 공백만 있는 텍스트가 화면에 영향이 없는가? (prev/next: 양옆의 VNode, 없으면 undefined = 부모의 시작/끝)
 *  - 블록 요소 옆, 블록 컨테이너의 시작/끝 → 렌더링에서 사라지는 공백 → 지워도 된다 (들여쓰기 등)
 *  - 인라인끼리 사이(<span>A</span>\n<span>B</span>) → 공백 한 칸으로 보이므로 남긴다
 */
function isInsignificantSpace(parentEl, prev, next) {
  if (parentEl && parentEl.namespaceURI !== XHTML) return !FOREIGN_TEXT.has(parentEl.localName);   // SVG/MathML: 도형 사이 공백은 무의미 (텍스트 컨테이너 안은 의미 있음)
  const parentBlock = !parentEl || BLOCK_TAGS.has(parentEl.localName);
  const side = (sib) => (sib === undefined ? parentBlock : isBlockish(sib));
  return side(prev) || side(next);
}

/** 실제 DOM 노드 하나 → VNode (텍스트는 문자열). 변환 대상이 아니면 null. report(메시지)로 제외 사유를 알린다. */
export function domToVdom(node, report = noop) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;           // 주석 등은 무시
  const type = resolveTag(node.namespaceURI, node.localName);     // SVG 는 clipPath 같은 대소문자가 유지된다. 'mml:mrow' 는 'mrow' 로 정규화
  if (!type) { report('<' + node.localName + '> 태그 (잘못된 태그 이름)'); return null; }
  if (SKIP_TAGS.has(type)) { report('<' + type + '> 태그'); return null; }
  const props = {};
  for (const { name, value } of node.attributes) {
    const why = rejectAttr(name, value);
    if (why) report('속성 ' + name + ' (' + why + ')');
    else props[name] = value;
  }
  const vnode = { type };
  if (node.namespaceURI !== XHTML) vnode.ns = node.namespaceURI;  // svg / math 는 네임스페이스를 기억해야 같은 모양으로 다시 만들 수 있다
  vnode.props = props;
  vnode.children = childrenToVdom(childrenHost(node), node, report);
  return vnode;
}

/** source 의 자식들 → VNode 배열. parent 는 공백 판단에 쓰는 부모(요소 또는 fragment). */
function childrenToVdom(source, parent, report = noop) {
  const items = [];
  for (const child of source.childNodes) {
    const v = domToVdom(child, report);
    if (v === null) continue;
    if (typeof v === 'string' && typeof items[items.length - 1] === 'string') items[items.length - 1] += v; // 이웃한 텍스트는 합친다
    else items.push(v);
  }
  const parentEl = parent && parent.nodeType === Node.ELEMENT_NODE ? parent : null;
  if (parentEl && parentEl.closest(PRESERVE_SELECTOR)) return items.filter((c) => c !== '');  // pre 등: 텍스트를 손대지 않는다

  const out = [];
  items.forEach((item, i) => {
    if (typeof item !== 'string') { out.push(item); return; }
    if (item === '') return;
    if (!WS_ONLY.test(item)) { out.push(item); return; }
    if (isInsignificantSpace(parentEl, items[i - 1], items[i + 1])) return;   // 들여쓰기 공백: 버림
    out.push(' ');                                                            // 인라인 사이 공백: 한 칸으로 정리해서 보존
  });
  return out;
}

/** 영역(컨테이너 요소 또는 DocumentFragment) 전체 → 루트 VNode */
export const containerToVdom = (container, report = noop) => ({ type: ROOT, props: {}, children: childrenToVdom(container, container, report) });

/** HTML 문자열 → 루트 VNode (template 안에서 파싱하므로 스크립트/이미지 로딩이 일어나지 않음) */
export function parseHtmlToVdom(src, report = noop) {
  const t = document.createElement('template');
  t.innerHTML = src;
  return containerToVdom(t.content, report);
}

/** 두 VNode 가 완전히 같은지 (props 순서는 무시) */
export function vdomEqual(a, b) {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if (a.type !== b.type || a.ns !== b.ns) return false;
  const ka = Object.keys(a.props), kb = Object.keys(b.props);
  if (ka.length !== kb.length || ka.some((k) => a.props[k] !== b.props[k])) return false;
  return a.children.length === b.children.length && a.children.every((c, i) => vdomEqual(c, b.children[i]));
}

/* ---------------------------------------------------------------- VDOM → HTML 문자열 (소스 편집 모드용) */
const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const hasText = (kids) => kids.some((c) => typeof c === 'string');

/** 자식 사이에 줄바꿈+들여쓰기를 넣어도 파싱 결과가 같은가? (= 넣은 공백이 전부 "들여쓰기 공백"으로 버려지는가) */
function canIndent(v) {
  if (hasText(v.children)) return false;
  if (v.ns) return !FOREIGN_TEXT.has(v.type);
  if (!BLOCK_TAGS.has(v.type)) return false;
  return v.children.every((c, i) => i === 0 || isBlockish(v.children[i - 1]) || isBlockish(c));
}

export function serializeNode(v, d = 0, raw = false) {
  const pad = raw ? '' : '  '.repeat(d);
  if (typeof v === 'string') return pad + escText(v);
  const attrs = Object.entries(v.props).map(([k, val]) => ' ' + k + (val === '' ? '' : '="' + escAttr(val) + '"')).join('');
  if (!v.ns && VOID_TAGS.has(v.type)) return pad + '<' + v.type + attrs + '>';
  const open = '<' + v.type + attrs + '>', close = '</' + v.type + '>';
  if (!v.children.length) return pad + open + close;
  // noscript 등: 내용이 RAWTEXT 라서 이스케이프하면 안 된다 (다시 파싱할 때 &lt; 가 디코딩되지 않아 모드를 오갈 때마다 깨짐)
  if (!v.ns && RAW_TEXT_TAGS.has(v.type) && v.children.every((c) => typeof c === 'string')) return pad + open + v.children.join('') + close;
  // pre/textarea: 공백이 곧 내용 → 들여쓰기 금지, 후손 전체도 그대로 한 줄로 이어 붙인다
  const keepWs = raw || (!v.ns && PRESERVE_TAGS.has(v.type));
  if (keepWs || hasText(v.children)) {
    // 파서는 pre/textarea/listing 여는 태그 직후의 첫 "\n" 을 버리므로, 내용이 "\n" 으로 시작하면 하나를 더 써 준다
    const lead = !v.ns && FIRST_NEWLINE_TAGS.has(v.type) && typeof v.children[0] === 'string' && v.children[0].startsWith('\n') ? '\n' : '';
    return pad + open + lead + v.children.map((c) => serializeNode(c, 0, keepWs)).join('') + close;
  }
  if (!canIndent(v)) return pad + open + v.children.map((c) => serializeNode(c, 0)).join('') + close;   // 들여쓰면 공백이 생기는 인라인 구조: 한 줄로
  return pad + open + '\n' + v.children.map((c) => serializeNode(c, d + 1)).join('\n') + '\n' + pad + close;
}

export const serializeRoot = (root) => root.children.map((c) => serializeNode(c, 0)).join(canIndent({ type: 'div', children: root.children }) ? '\n' : '');
