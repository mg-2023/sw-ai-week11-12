import { elementNode, textNode } from './types.ts'
import type { Props, VElement, VNode } from './types.ts'

const WHITESPACE_SENSITIVE_TAGS = new Set(['pre', 'textarea', 'listing'])
const URL_ATTRIBUTES = new Set(['href', 'src', 'xlink:href', 'action', 'formaction'])

/** setAttribute()가 거부하는 이름은 HTML 파서가 받아 줘도 여기서 걸러 냅니다. */
const VALID_ATTRIBUTE_NAME = /^[a-zA-Z_:][\w:.-]*$/

/** 코드 정렬용 줄바꿈만 있는 텍스트입니다. &nbsp;는 내용이므로 \s를 쓰지 않습니다. */
const FORMATTING_WHITESPACE = /^[ \t\r\f]*\n[ \t\r\n\f]*$/

/**
 * 사용자가 입력한 HTML이 이 페이지 안에서 코드로 실행되지 않게 막습니다.
 * 실험실용 최소 방어이며, 서비스에서는 검증된 sanitizer를 써야 합니다.
 */
function isAllowedAttribute(name: string, value: string): boolean {
  const lowerName = name.toLowerCase()
  if (!VALID_ATTRIBUTE_NAME.test(name) || lowerName.startsWith('on')) return false
  if (!URL_ATTRIBUTES.has(lowerName)) return true
  // 브라우저는 URL을 해석할 때 공백과 제어 문자를 지우므로 똑같이 지운 뒤 검사합니다.
  return !/^javascript:/i.test(value.replace(/[\u0000- ]/g, ''))
}

function elementToVdom(element: Element, keepWhitespace: boolean): VElement | null {
  // localName은 SVG의 linearGradient 같은 대소문자를 그대로 유지합니다.
  const tag = element.localName
  if (tag === 'script') return null

  const props: Props = {}
  for (const { name, value } of Array.from(element.attributes)) {
    if (isAllowedAttribute(name, value)) props[name] = value
  }

  const children = childrenToVdom(element, keepWhitespace || WHITESPACE_SENSITIVE_TAGS.has(tag))
  return elementNode(tag, props, children, element.getAttribute('data-key') ?? undefined)
}

/** DOM 노드 하나를 Virtual DOM으로 바꿉니다. 주석처럼 화면에 없는 노드는 null입니다. */
export function domToVdom(node: Node, keepWhitespace = false): VNode | null {
  if (node.nodeType === Node.TEXT_NODE) return textNode(node.nodeValue ?? '')
  if (node.nodeType === Node.ELEMENT_NODE) return elementToVdom(node as Element, keepWhitespace)
  return null
}

/**
 * 자식 목록을 변환합니다.
 * 들여쓰기 공백은 버리고 이어진 텍스트는 합쳐서, 같은 화면이 늘 같은 트리가 되게 합니다.
 */
export function childrenToVdom(parent: Node, keepWhitespace = false): VNode[] {
  const children: VNode[] = []

  parent.childNodes.forEach((childNode) => {
    const child = domToVdom(childNode, keepWhitespace)
    if (!child) return
    if (child.kind === 'element') {
      children.push(child)
      return
    }

    if (child.text === '') return
    if (!keepWhitespace && FORMATTING_WHITESPACE.test(child.text)) return

    const previous = children.at(-1)
    if (previous?.kind === 'text') {
      children[children.length - 1] = textNode(previous.text + child.text)
    } else {
      children.push(child)
    }
  })

  return children
}

/**
 * HTML 문자열을 Virtual DOM 목록으로 바꿉니다.
 * template 내용은 화면과 분리된 문서에 있어서, 파싱만으로는 이미지 로딩이나
 * onerror 같은 코드 실행이 일어나지 않습니다.
 */
export function htmlToVdom(html: string): VNode[] {
  const template = document.createElement('template')
  template.innerHTML = html
  return childrenToVdom(template.content)
}
