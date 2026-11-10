/** 형제 노드 사이에서 "같은 노드"를 알아보는 이름표입니다. */
export type Key = string | number

export type EventHandler = (event: Event) => void

/** props 값은 h()나 domToVdom()을 지나며 이 네 가지로 정리된 뒤 들어옵니다. */
export type PropValue = string | number | boolean | EventHandler
export type Props = Record<string, PropValue>

export interface VElement {
  kind: 'element'
  tag: string
  props: Props
  children: VNode[]
  key?: Key
}

export interface VText {
  kind: 'text'
  text: string
}

export type VNode = VElement | VText

/** 루트에서 자식 번호를 따라 내려가는 주소입니다. [1, 0]은 둘째 자식의 첫째 자식입니다. */
export type Path = readonly number[]

/**
 * Diff가 만드는 작업 지시서입니다.
 * INSERT·REMOVE·REPLACE·PROPS·TEXT가 기본 다섯 가지 케이스이고,
 * MOVE는 key가 있을 때, LISTENERS는 DOM을 건드리지 않는 핸들러 교체에 씁니다.
 * INSERT·REMOVE·MOVE의 path는 대상 자신이 아니라 부모를 가리킵니다.
 */
export type Patch =
  | { type: 'INSERT'; path: Path; index: number; node: VNode }
  | { type: 'REMOVE'; path: Path; index: number }
  | { type: 'REPLACE'; path: Path; node: VNode }
  | { type: 'PROPS'; path: Path; set: Props; remove: string[] }
  | { type: 'TEXT'; path: Path; text: string }
  | { type: 'MOVE'; path: Path; from: number; to: number }
  | { type: 'LISTENERS'; path: Path; set: Record<string, EventHandler>; remove: string[] }

export type PatchType = Patch['type']

export function textNode(text: string): VText {
  return { kind: 'text', text }
}

export function elementNode(
  tag: string,
  props: Props = {},
  children: VNode[] = [],
  key?: Key,
): VElement {
  const node: VElement = { kind: 'element', tag, props, children }
  if (key !== undefined) node.key = key
  return node
}
