import { createDom } from '../phase1/patch.ts'
import type { Patch, PatchType, VNode } from '../phase1/types.ts'
import { h } from '../phase2/h.ts'

export const PATCH_LABELS: Record<PatchType, string> = {
  INSERT: '추가',
  REMOVE: '삭제',
  REPLACE: '교체',
  PROPS: '속성',
  TEXT: '글자',
  MOVE: '이동',
  LISTENERS: '핸들러',
}

const MAX_PREVIEW_LENGTH = 28

export type TouchedNodes = Map<Node, PatchType>

export interface MutationCounter {
  /** 지금까지 쌓인 실제 DOM 변경 건수를 꺼내고 비웁니다. */
  take(): number
}

/**
 * MutationObserver로 실제 DOM 변경을 셉니다. 연산 개수는 코드의 주장이고,
 * 이 숫자는 브라우저가 직접 본 결과라서 두 값을 나란히 놓으면 검증이 됩니다.
 */
export function createMutationCounter(root: Node): MutationCounter {
  const observer = new MutationObserver(() => {})
  observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true })
  return { take: () => observer.takeRecords().length }
}

/** 노드 지도에 칠할 노드를 모읍니다. 핸들러 교체는 DOM을 바꾸지 않으므로 뺍니다. */
export function recordTouch(touched: TouchedNodes, patch: Patch, node: Node): void {
  if (patch.type === 'LISTENERS') return
  touched.set(node, patch.type)
}

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_PREVIEW_LENGTH ? `${flat.slice(0, MAX_PREVIEW_LENGTH)}…` : flat
}

function describeNode(node: VNode): string {
  return node.kind === 'text' ? `글자 "${shorten(node.text)}"` : `<${node.tag}>`
}

export function describePatch(patch: Patch): string {
  switch (patch.type) {
    case 'TEXT':
      return `"${shorten(patch.text)}" 내용으로 바꿈`
    case 'PROPS':
      return `${[...Object.keys(patch.set), ...patch.remove].join(', ')} 속성을 바꿈`
    case 'REPLACE':
      return `${describeNode(patch.node)} 노드로 통째로 바꿈`
    case 'INSERT':
      return `${patch.index}번 자리에 ${describeNode(patch.node)} 추가`
    case 'REMOVE':
      return `${patch.index}번 자식 삭제`
    case 'MOVE':
      return `${patch.from}번 자식을 ${patch.to}번 자리로 옮김`
    case 'LISTENERS':
      return '이벤트 핸들러만 교체'
  }
}

export function formatPath(patch: Patch): string {
  return `[${patch.path.join(', ')}]`
}

/** DOM을 바꾼 연산만 고릅니다. */
export function domPatches(patches: readonly Patch[]): Patch[] {
  return patches.filter((patch) => patch.type !== 'LISTENERS')
}

export function renderPatchList(list: Element, patches: readonly Patch[]): void {
  const rows = domPatches(patches).map((patch) =>
    createDom(
      h(
        'li',
        { class: 'op-row' },
        h('span', { class: `op-badge op-${patch.type.toLowerCase()}` }, PATCH_LABELS[patch.type]),
        h('span', { class: 'op-summary' }, describePatch(patch)),
        h('code', { class: 'op-path' }, formatPath(patch)),
      ),
    ),
  )
  list.replaceChildren(...rows)
}

function createCell(node: Node, type: PatchType | undefined): HTMLElement {
  const cell = document.createElement('span')
  const shape = node.nodeType === Node.TEXT_NODE ? 'is-text-node' : 'is-element'
  cell.className = type ? `cell ${shape} cell-${type.toLowerCase()}` : `cell ${shape}`
  cell.title = node.nodeType === Node.TEXT_NODE ? '글자 노드' : `<${(node as Element).localName}>`
  return cell
}

/** 실제 DOM 노드 하나를 네모 하나로 그립니다. 전체 중 어디가 바뀌었는지 한눈에 보입니다. */
export function renderNodeMap(
  container: Element,
  root: Node,
  touched: ReadonlyMap<Node, PatchType>,
): { total: number; changed: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  const cells: HTMLElement[] = []
  let changed = 0

  for (let node: Node | null = root; node; node = walker.nextNode()) {
    const type = touched.get(node)
    if (type) changed += 1
    cells.push(createCell(node, type))
  }

  container.replaceChildren(...cells)
  return { total: cells.length, changed }
}
