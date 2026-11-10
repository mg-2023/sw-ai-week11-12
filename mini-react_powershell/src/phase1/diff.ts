import type { EventHandler, Key, Patch, Path, Props, VNode } from './types.ts'

const NO_MATCH = -1

/**
 * 두 트리를 비교해 옛 트리를 새 트리로 바꾸는 연산 목록을 만듭니다. 입력은 고치지 않습니다.
 *
 * 연산 순서가 곧 정확성입니다. 어떤 노드의 내부 연산을 먼저 내고, 그 노드의 자식 목록을
 * 바꾸는 연산을 나중에 냅니다. 그래서 내부 연산의 path는 옛 트리 번호 그대로 유효합니다.
 */
export function diff(oldNode: VNode, newNode: VNode): Patch[] {
  const patches: Patch[] = []
  diffNode(oldNode, newNode, [], patches)
  return patches
}

function diffNode(oldNode: VNode, newNode: VNode, path: Path, patches: Patch[]): void {
  // 같은 객체면 아래 전부가 같습니다. useMemo로 재사용한 트리는 여기서 바로 끝납니다.
  if (oldNode === newNode) return

  if (oldNode.kind === 'text' && newNode.kind === 'text') {
    if (oldNode.text !== newNode.text) patches.push({ type: 'TEXT', path, text: newNode.text })
    return
  }

  if (
    oldNode.kind === 'text' ||
    newNode.kind === 'text' ||
    oldNode.tag !== newNode.tag ||
    oldNode.key !== newNode.key
  ) {
    patches.push({ type: 'REPLACE', path, node: newNode })
    return
  }

  diffProps(oldNode.props, newNode.props, path, patches)
  diffChildren(oldNode.children, newNode.children, path, patches)
}

function diffProps(oldProps: Props, newProps: Props, path: Path, patches: Patch[]): void {
  const set: Props = {}
  const remove: string[] = []
  const setListeners: Record<string, EventHandler> = {}
  const removeListeners: string[] = []

  for (const [name, value] of Object.entries(newProps)) {
    const oldValue = oldProps[name]
    if (Object.is(oldValue, value)) continue

    if (typeof value === 'function') {
      setListeners[name] = value
    } else {
      set[name] = value
      if (typeof oldValue === 'function') removeListeners.push(name)
    }
  }

  for (const [name, oldValue] of Object.entries(oldProps)) {
    if (Object.hasOwn(newProps, name)) continue
    if (typeof oldValue === 'function') removeListeners.push(name)
    else remove.push(name)
  }

  if (Object.keys(set).length > 0 || remove.length > 0) {
    patches.push({ type: 'PROPS', path, set, remove })
  }
  // 핸들러는 렌더마다 새 함수라서 따로 분리합니다. DOM 변경이 아니므로 집계에서 뺄 수 있습니다.
  if (Object.keys(setListeners).length > 0 || removeListeners.length > 0) {
    patches.push({ type: 'LISTENERS', path, set: setListeners, remove: removeListeners })
  }
}

function keyOf(node: VNode): Key | undefined {
  return node.kind === 'element' ? node.key : undefined
}

/** 같은 신분을 가진 노드끼리만 1차 짝이 될 수 있습니다. */
function identityOf(node: VNode): string {
  if (node.kind === 'text') return '#text'
  if (node.key === undefined) return `tag:${node.tag}`
  return `key:${node.tag}:${typeof node.key}:${node.key}`
}

/**
 * 새 자식마다 짝이 될 옛 자식의 번호를 찾아 배열로 돌려줍니다. 짝이 없으면 NO_MATCH입니다.
 *
 * 1차: 신분이 같은 노드끼리 순서대로 짝을 짓습니다. 신분별 대기열을 쓰므로
 *      key가 중복되어도 먼저 온 순서로 짝이 지어지고 결과는 틀어지지 않습니다.
 * 2차: 남은 key 없는 노드끼리 순서대로 짝을 지어 REPLACE 한 번으로 끝내게 합니다.
 *      key가 다른 노드는 다른 대상이므로 여기서 짝을 짓지 않습니다.
 */
function matchChildren(oldChildren: readonly VNode[], newChildren: readonly VNode[]): number[] {
  const waiting = new Map<string, number[]>()
  oldChildren.forEach((child, index) => {
    const identity = identityOf(child)
    const queue = waiting.get(identity)
    if (queue) queue.push(index)
    else waiting.set(identity, [index])
  })

  const sources = newChildren.map((child) => waiting.get(identityOf(child))?.shift() ?? NO_MATCH)

  const used = new Set(sources)
  const leftovers = oldChildren
    .map((_, index) => index)
    .filter((index) => !used.has(index) && keyOf(oldChildren[index]) === undefined)

  newChildren.forEach((child, newIndex) => {
    if (sources[newIndex] !== NO_MATCH || keyOf(child) !== undefined) return
    sources[newIndex] = leftovers.shift() ?? NO_MATCH
  })

  return sources
}

/**
 * 가장 긴 증가 부분 수열(LIS)을 O(n log n)으로 구합니다.
 * 여기 들어간 노드들은 서로의 순서가 이미 맞으므로 가만히 둘 수 있습니다.
 */
function longestIncreasingSubsequence(values: readonly number[]): Set<number> {
  const tails: number[] = []
  const previous: number[] = new Array(values.length).fill(NO_MATCH)

  values.forEach((value, index) => {
    let low = 0
    let high = tails.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (values[tails[middle]] < value) low = middle + 1
      else high = middle
    }
    if (low > 0) previous[index] = tails[low - 1]
    tails[low] = index
  })

  const stable = new Set<number>()
  let cursor = tails.at(-1) ?? NO_MATCH
  while (cursor !== NO_MATCH) {
    stable.add(values[cursor])
    cursor = previous[cursor]
  }
  return stable
}

function diffChildren(
  oldChildren: readonly VNode[],
  newChildren: readonly VNode[],
  path: Path,
  patches: Patch[],
): void {
  const sources = matchChildren(oldChildren, newChildren)

  // 1단계: 짝끼리 내부를 비교합니다. 아직 자식 순서를 안 바꿨으므로 옛 번호가 유효합니다.
  sources.forEach((oldIndex, newIndex) => {
    if (oldIndex === NO_MATCH) return
    diffNode(oldChildren[oldIndex], newChildren[newIndex], [...path, oldIndex], patches)
  })

  // 2단계: 짝 없는 옛 자식을 지웁니다. 뒤에서부터 지워야 앞쪽 번호가 밀리지 않습니다.
  // order는 패치가 진행되는 동안의 자식 순서를 그대로 따라가는 모형입니다.
  const used = new Set(sources)
  const order = oldChildren.map((_, index) => index)
  for (let index = oldChildren.length - 1; index >= 0; index -= 1) {
    if (used.has(index)) continue
    patches.push({ type: 'REMOVE', path, index })
    order.splice(index, 1)
  }

  // 3단계: 뒤에서부터 제자리를 잡습니다. 오른쪽 이웃은 이미 확정이라 기준점으로 쓸 수 있습니다.
  const stable = longestIncreasingSubsequence(sources.filter((source) => source !== NO_MATCH))
  const idOf = (newIndex: number) =>
    sources[newIndex] === NO_MATCH ? oldChildren.length + newIndex : sources[newIndex]

  for (let newIndex = newChildren.length - 1; newIndex >= 0; newIndex -= 1) {
    const source = sources[newIndex]
    // 가만히 있을 노드는 기준점을 찾을 필요도 없습니다. 안 바뀐 목록은 여기서 전부 지나갑니다.
    if (source !== NO_MATCH && stable.has(source)) continue

    const isLast = newIndex === newChildren.length - 1
    const anchor = isLast ? order.length : order.indexOf(idOf(newIndex + 1))
    const id = idOf(newIndex)

    if (source === NO_MATCH) {
      patches.push({ type: 'INSERT', path, index: anchor, node: newChildren[newIndex] })
      order.splice(anchor, 0, id)
    } else {
      const from = order.indexOf(id)
      const to = from < anchor ? anchor - 1 : anchor
      order.splice(from, 1)
      order.splice(to, 0, id)
      if (from !== to) patches.push({ type: 'MOVE', path, from, to })
    }
  }
}
