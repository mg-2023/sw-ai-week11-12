import type { Props, VElement, VNode } from './types.ts'

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
])
const RAW_TEXT_TAGS = new Set(['style', 'script'])
const WHITESPACE_SENSITIVE_TAGS = new Set(['pre', 'textarea', 'listing'])
const INDENT = '  '

function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/ /g, '&nbsp;')
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/ /g, '&nbsp;')
}

function serializeProps(props: Props): string {
  return Object.entries(props)
    .map(([name, value]) => {
      if (typeof value === 'function' || value === false) return ''
      if (value === true || value === '') return ` ${name}`
      return ` ${name}="${escapeAttribute(String(value))}"`
    })
    .join('')
}

/** 자식이 전부 요소일 때만 줄을 나눕니다. 텍스트가 섞이면 공백 하나도 화면을 바꾸기 때문입니다. */
function canBreakLines(children: readonly VNode[]): boolean {
  return children.length > 0 && children.every((child) => child.kind === 'element')
}

function serializeElement(node: VElement, depth: number, keepExact: boolean): string {
  const open = `<${node.tag}${serializeProps(node.props)}>`
  if (VOID_TAGS.has(node.tag)) return open

  const close = `</${node.tag}>`
  const isSensitive = WHITESPACE_SENSITIVE_TAGS.has(node.tag)
  const exact = keepExact || isSensitive

  if (!exact && canBreakLines(node.children)) {
    const padding = INDENT.repeat(depth + 1)
    const lines = node.children.map((child) => padding + serialize(child, depth + 1, false, false))
    return `${open}\n${lines.join('\n')}\n${INDENT.repeat(depth)}${close}`
  }

  const raw = RAW_TEXT_TAGS.has(node.tag)
  const inner = node.children.map((child) => serialize(child, depth, exact, raw)).join('')
  // HTML 파서는 <pre> 바로 뒤의 줄바꿈 하나를 버리므로, 내용의 줄바꿈을 지키려면 하나 더 씁니다.
  const leadingBreak = isSensitive && inner.startsWith('\n') ? '\n' : ''
  return open + leadingBreak + inner + close
}

function serialize(node: VNode, depth: number, keepExact: boolean, raw: boolean): string {
  if (node.kind === 'text') return raw ? node.text : escapeText(node.text)
  return serializeElement(node, depth, keepExact)
}

/**
 * Virtual DOM을 사람이 고치기 좋은 HTML로 바꿉니다.
 * 이 결과를 htmlToVdom()에 넣으면 원래 트리가 그대로 나옵니다. 아무것도 안 고치고
 * Patch를 눌렀을 때 가짜 변경이 생기지 않으려면 이 왕복이 항상 같아야 합니다.
 */
export function vdomToHtml(nodes: readonly VNode[]): string {
  const separator = canBreakLines(nodes) ? '\n' : ''
  return nodes.map((node) => serialize(node, 0, false, false)).join(separator)
}
