import type { EventHandler, Patch, Path, PropValue, VNode } from './types.ts'

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const MATHML_NAMESPACE = 'http://www.w3.org/1998/Math/MathML'

/** 연산 하나가 끝날 때마다 불립니다. node는 그 연산이 실제로 건드린 DOM 노드입니다. */
export type PatchObserver = (patch: Patch, node: Node) => void

/**
 * 요소마다 "이벤트 종류 → 현재 핸들러" 표를 둡니다.
 * addEventListener는 종류별로 한 번만 하고 표의 내용만 바꾸기 때문에,
 * 렌더마다 새 함수가 와도 DOM 쪽 작업은 생기지 않습니다.
 */
const listenerTables = new WeakMap<EventTarget, Map<string, EventHandler>>()

function dispatchToHandler(event: Event): void {
  if (!event.currentTarget) return
  listenerTables.get(event.currentTarget)?.get(event.type)?.(event)
}

function eventTypeOf(propName: string): string {
  return propName.slice(2).toLowerCase()
}

function setListener(element: Element, propName: string, handler: EventHandler): void {
  const type = eventTypeOf(propName)
  let table = listenerTables.get(element)
  if (!table) {
    table = new Map()
    listenerTables.set(element, table)
  }
  if (!table.has(type)) element.addEventListener(type, dispatchToHandler)
  table.set(type, handler)
}

function removeListener(element: Element, propName: string): void {
  const type = eventTypeOf(propName)
  if (listenerTables.get(element)?.delete(type)) {
    element.removeEventListener(type, dispatchToHandler)
  }
}

function syncValue(element: Element, value: string): void {
  const isField =
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  if (!isField) return
  // 파일 입력은 코드로 값을 넣을 수 없고, 같은 값을 다시 넣으면 커서가 끝으로 튑니다.
  if (element instanceof HTMLInputElement && element.type === 'file') return
  if (element.value !== value) element.value = value
}

/**
 * value·checked·selected는 속성(attribute)을 바꿔도 사용자가 만진 뒤의 화면 값이
 * 따라오지 않습니다. 그래서 DOM 프로퍼티까지 같이 맞춥니다.
 */
function syncLiveProperty(element: Element, name: string, value: PropValue | null): void {
  const isOn = value !== null && value !== false
  if (name === 'checked' && element instanceof HTMLInputElement) element.checked = isOn
  else if (name === 'selected' && element instanceof HTMLOptionElement) element.selected = isOn
  else if (name === 'value') syncValue(element, value === null ? '' : String(value))
}

function removeProp(element: Element, name: string): void {
  element.removeAttribute(name)
  syncLiveProperty(element, name, null)
}

function setProp(element: Element, name: string, value: PropValue): void {
  if (typeof value === 'function') {
    setListener(element, name, value)
    return
  }
  if (value === false) {
    removeProp(element, name)
    return
  }
  element.setAttribute(name, value === true ? '' : String(value))
  syncLiveProperty(element, name, value)
}

function namespaceOf(tag: string, parentNamespace: string): string {
  if (tag === 'svg') return SVG_NAMESPACE
  if (tag === 'math') return MATHML_NAMESPACE
  return parentNamespace
}

/** 자식이 들어갈 네임스페이스입니다. foreignObject 안쪽은 다시 HTML 세계입니다. */
function childNamespaceOf(node: Node): string {
  if (!(node instanceof Element) || node.localName === 'foreignObject') return HTML_NAMESPACE
  return node.namespaceURI ?? HTML_NAMESPACE
}

/** Virtual DOM으로 실제 DOM을 만듭니다. */
export function createDom(vnode: VNode, parentNamespace: string = HTML_NAMESPACE): Node {
  if (vnode.kind === 'text') return document.createTextNode(vnode.text)

  const element = document.createElementNS(namespaceOf(vnode.tag, parentNamespace), vnode.tag)

  // <select value>는 option이 있어야 먹히므로 자식을 먼저 붙이고 속성을 넣습니다.
  const childNamespace = childNamespaceOf(element)
  element.append(...vnode.children.map((child) => createDom(child, childNamespace)))
  for (const [name, value] of Object.entries(vnode.props)) setProp(element, name, value)

  return element
}

function resolve(root: Node, path: Path): Node {
  return path.reduce<Node>((node, index) => {
    const child = node.childNodes[index]
    if (!child) throw new Error(`패치 경로 [${path.join(', ')}]에 해당하는 DOM 노드가 없습니다.`)
    return child
  }, root)
}

function childAt(parent: Node, index: number): ChildNode {
  const child = parent.childNodes[index]
  if (!child) throw new Error(`자식 번호 ${index}에 해당하는 DOM 노드가 없습니다.`)
  return child
}

/**
 * diff()가 만든 연산을 순서대로 실제 DOM에 반영합니다.
 * 루트가 통째로 교체될 수 있으므로 현재 루트를 돌려줍니다.
 */
export function applyPatches(root: Node, patches: readonly Patch[], onApply?: PatchObserver): Node {
  let currentRoot = root

  for (const patch of patches) {
    const target = resolve(currentRoot, patch.path)
    let touched: Node = target

    switch (patch.type) {
      case 'TEXT':
        target.nodeValue = patch.text
        break

      case 'PROPS':
        for (const name of patch.remove) removeProp(target as Element, name)
        for (const [name, value] of Object.entries(patch.set)) setProp(target as Element, name, value)
        break

      case 'LISTENERS':
        for (const name of patch.remove) removeListener(target as Element, name)
        for (const [name, handler] of Object.entries(patch.set)) setListener(target as Element, name, handler)
        break

      case 'REPLACE': {
        const parent = target.parentNode
        touched = createDom(patch.node, parent ? childNamespaceOf(parent) : HTML_NAMESPACE)
        ;(target as ChildNode).replaceWith(touched)
        if (patch.path.length === 0) currentRoot = touched
        break
      }

      case 'INSERT':
        touched = createDom(patch.node, childNamespaceOf(target))
        target.insertBefore(touched, target.childNodes[patch.index] ?? null)
        break

      case 'REMOVE':
        childAt(target, patch.index).remove()
        break

      case 'MOVE': {
        // 새로 만들지 않고 같은 노드를 옮깁니다. 입력값과 포커스가 유지되는 이유입니다.
        const moved = childAt(target, patch.from)
        target.removeChild(moved)
        target.insertBefore(moved, target.childNodes[patch.to] ?? null)
        touched = moved
        break
      }
    }

    onApply?.(patch, touched)
  }

  return currentRoot
}
