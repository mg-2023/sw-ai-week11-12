import { diff } from '../phase1/diff.ts'
import { VdomHistory } from '../phase1/history.ts'
import { applyPatches } from '../phase1/patch.ts'
import type { PatchObserver } from '../phase1/patch.ts'
import type { Patch, VNode } from '../phase1/types.ts'

const MAX_VERSIONS = 30

export type LabAction = 'patch' | 'back' | 'forward' | 'jump'

export interface LabTransition {
  action: LabAction
  patches: Patch[]
  vdom: VNode
}

export interface LabControlsOptions {
  /** 실제 영역의 DOM입니다. initial과 노드가 1:1로 맞아 있어야 합니다. */
  realRoot: Node
  initial: VNode
  readTestArea: () => VNode
  writeTestArea: (vnode: VNode) => void
  onApply?: PatchObserver
  onTransition: (transition: LabTransition) => void
}

export interface LabControls {
  readonly history: VdomHistory<VNode>
  patch(): void
  back(): void
  forward(): void
  jumpTo(index: number): void
}

/**
 * Patch·뒤로가기·앞으로가기의 규칙만 담습니다. 화면 요소를 모르기 때문에
 * 테스트에서 가짜 입출력을 끼워 넣어 버튼 없이도 검증할 수 있습니다.
 */
export function createLabControls(options: LabControlsOptions): LabControls {
  const { realRoot, readTestArea, writeTestArea, onApply, onTransition } = options
  const history = new VdomHistory<VNode>(options.initial, MAX_VERSIONS)

  function patch(): void {
    const next = readTestArea()

    const patches = diff(history.current, next)

    // 아무것도 안 바뀌었으면 기록을 늘리지 않습니다. 뒤로가기가 헛돌지 않게 하기 위해서입니다.
    if (patches.length > 0) {
      applyPatches(realRoot, patches, onApply)
      history.push(next)
    }
    onTransition({ action: 'patch', patches, vdom: history.current })
  }

  /** 기록 이동도 전체를 다시 그리지 않고 같은 Diff와 Patch를 거칩니다. */
  function navigate(action: LabAction, move: () => VNode | null): void {
    const previous = history.current
    const target = move()
    if (!target) return

    const patches = diff(previous, target)
    applyPatches(realRoot, patches, onApply)
    writeTestArea(target)
    onTransition({ action, patches, vdom: target })
  }

  return {
    history,
    patch,
    back: () => navigate('back', () => history.back()),
    forward: () => navigate('forward', () => history.forward()),
    jumpTo: (index) => navigate('jump', () => history.go(index)),
  }
}
