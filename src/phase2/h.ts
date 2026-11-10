import { elementNode, textNode } from '../phase1/types.ts'
import type { Key, PropValue, Props, VNode } from '../phase1/types.ts'
import { renderStateless } from './function-component.ts'
import type { Component } from './function-component.ts'

export type Child = VNode | string | number | boolean | null | undefined | Child[]

type RawProps = Record<string, unknown>

const PROP_ALIASES: Record<string, string> = {
  className: 'class',
  htmlFor: 'for',
}

function toKebabCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

function toCssText(style: Record<string, unknown>): string {
  return Object.entries(style)
    .filter(([, value]) => value !== null && value !== undefined && value !== false)
    .map(([name, value]) => `${name.startsWith('--') ? name : toKebabCase(name)}: ${String(value)}`)
    .join('; ')
}

/**
 * props를 Virtual DOM이 다루는 네 가지 값으로 정리합니다.
 * style 객체를 여기서 문자열로 바꿔 두면 Diff는 값 비교만 하면 됩니다.
 */
function normalizeProps(raw: RawProps): Props {
  const props: Props = {}

  for (const [rawName, value] of Object.entries(raw)) {
    if (rawName === 'key' || rawName === 'children') continue
    const name = PROP_ALIASES[rawName] ?? rawName

    if (value === null || value === undefined) continue
    if (name === 'style' && typeof value === 'object') {
      props.style = toCssText(value as Record<string, unknown>)
    } else if (typeof value === 'boolean' && (name.startsWith('aria-') || name.startsWith('data-'))) {
      // aria-pressed="true"처럼 참거짓을 글자로 적어야 뜻이 되는 속성입니다. disabled와 달리 비워 두면 안 됩니다.
      props[name] = String(value)
    } else if (value !== false) {
      props[name] = value as PropValue
    }
  }

  return props
}

function normalizeChildren(children: readonly Child[]): VNode[] {
  return children.flatMap((child): VNode[] => {
    if (Array.isArray(child)) return normalizeChildren(child)
    if (child === null || child === undefined || typeof child === 'boolean') return []
    if (typeof child === 'string' || typeof child === 'number') return [textNode(String(child))]
    return [child]
  })
}

/** 자식 컴포넌트가 만든 트리의 맨 위 요소에 key를 달아, 목록에서 알아볼 수 있게 합니다. */
function withKey(node: VNode, key: Key | undefined): VNode {
  if (key === undefined || node.kind === 'text') return node
  return { ...node, key }
}

/**
 * Virtual DOM 노드를 만드는 함수입니다. JSX가 컴파일되면 호출되는 함수와 같은 역할입니다.
 * tag가 함수면 자식 컴포넌트이므로 바로 실행해서 결과 트리로 펼칩니다.
 */
export function h(tag: string, props?: RawProps | null, ...children: Child[]): VNode
export function h<P>(component: Component<P>, props: P & { key?: Key }, ...children: Child[]): VNode
export function h(
  tag: string | Component<RawProps>,
  rawProps?: RawProps | null,
  ...children: Child[]
): VNode {
  const raw = rawProps ?? {}
  const key = raw.key as Key | undefined | null
  const normalizedKey = key ?? undefined
  const normalizedChildren = normalizeChildren(children)

  if (typeof tag === 'function') {
    const { key: _key, ...componentProps } = raw
    if (normalizedChildren.length > 0) componentProps.children = normalizedChildren
    return withKey(renderStateless(tag, componentProps), normalizedKey)
  }

  return elementNode(tag, normalizeProps(raw), normalizedChildren, normalizedKey)
}
