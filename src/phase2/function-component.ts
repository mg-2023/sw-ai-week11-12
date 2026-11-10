import { diff } from '../phase1/diff.ts'
import { applyPatches, createDom } from '../phase1/patch.ts'
import type { PatchObserver } from '../phase1/patch.ts'
import { textNode } from '../phase1/types.ts'
import type { Patch, VNode } from '../phase1/types.ts'

export type Component<P> = (props: P) => VNode | null

/** hooks 배열의 한 칸입니다. dispose는 컴포넌트가 사라질 때 불립니다. */
export interface HookSlot {
  kind: 'state' | 'effect' | 'memo'
  dispose?: () => void
}

export interface PendingEffect {
  cleanup: () => void
  run: () => void
}

/** Hook이 컴포넌트에게 요구하는 기능만 모은 창구입니다. */
export interface HookOwner {
  claimSlot<T extends HookSlot>(kind: T['kind'], create: () => T): T
  queueEffect(effect: PendingEffect): void
  scheduleUpdate(): void
}

export interface Commit {
  phase: 'mount' | 'update'
  patches: Patch[]
  renderCount: number
}

export interface FunctionComponentOptions {
  /** 연산 하나가 DOM에 반영될 때마다 불립니다. */
  onApply?: PatchObserver
  /** 렌더 결과가 화면에 반영된 뒤 불립니다. */
  onCommit?: (commit: Commit) => void
}

/** 한 틱 안에서 이 횟수를 넘겨 다시 그리면 무한 루프로 보고 멈춥니다. */
const MAX_UPDATES_PER_TICK = 50

/**
 * 지금 렌더링 중인 컴포넌트입니다.
 * useState()는 인자로 컴포넌트를 받지 않으므로, 이 변수로 자기 주인을 찾습니다.
 */
let currentOwner: HookOwner | null = null

/** 0보다 크면 지금 자식 컴포넌트 안입니다. 자식의 Hook 호출을 막는 데 씁니다. */
let statelessDepth = 0

export function getHookOwner(hookName: string): HookOwner {
  if (statelessDepth > 0) {
    throw new Error(
      `${hookName}은(는) 루트 컴포넌트에서만 쓸 수 있습니다. 자식 컴포넌트는 props만 받아야 합니다.`,
    )
  }
  if (!currentOwner) {
    throw new Error(`${hookName}은(는) 컴포넌트가 렌더링되는 동안에만 호출할 수 있습니다.`)
  }
  return currentOwner
}

/** 자식 컴포넌트를 실행합니다. 상태가 없는 순수 함수이므로 그 자리에서 바로 펼칩니다. */
export function renderStateless<P>(component: Component<P>, props: P): VNode {
  statelessDepth += 1
  try {
    return component(props) ?? textNode('')
  } finally {
    statelessDepth -= 1
  }
}

/**
 * 함수형 컴포넌트를 감싸서 함수 바깥에 기억 공간을 주는 클래스입니다.
 * 함수가 다시 실행되어도 hooks 배열은 여기 남아 있으므로 상태가 유지됩니다.
 */
export class FunctionComponent<P> implements HookOwner {
  hooks: HookSlot[] = []
  renderCount = 0

  private readonly component: Component<P>
  private readonly options: FunctionComponentOptions
  private props: P
  private status: 'idle' | 'mounted' | 'unmounted' = 'idle'
  private cursor = 0
  private vdom: VNode | null = null
  private dom: Node | null = null
  private effectQueue: PendingEffect[] = []
  private updateScheduled = false
  private updatesThisTick = 0

  constructor(component: Component<P>, props: P, options: FunctionComponentOptions = {}) {
    this.component = component
    this.props = props
    this.options = options
  }

  /** 처음 렌더링: 트리를 만들어 container에 붙입니다. */
  mount(container: Element): void {
    if (this.status !== 'idle') throw new Error('이미 mount한 컴포넌트입니다.')

    this.vdom = this.render()
    this.dom = createDom(this.vdom)
    container.append(this.dom)
    this.status = 'mounted'

    this.flushEffects()
    this.options.onCommit?.({ phase: 'mount', patches: [], renderCount: this.renderCount })
  }

  /** 다시 렌더링: 새 트리를 만들고 옛 트리와 비교해 바뀐 부분만 반영합니다. */
  update(nextProps: P = this.props): void {
    if (this.status !== 'mounted' || !this.vdom || !this.dom) return

    this.updateScheduled = false
    this.props = nextProps

    const nextVdom = this.render()
    const patches = diff(this.vdom, nextVdom)
    this.dom = applyPatches(this.dom, patches, this.options.onApply)
    this.vdom = nextVdom

    this.flushEffects()
    this.options.onCommit?.({ phase: 'update', patches, renderCount: this.renderCount })
  }

  /** 정리 함수를 모두 실행하고 화면에서 내립니다. */
  unmount(): void {
    if (this.status !== 'mounted') return

    this.status = 'unmounted'
    this.updateScheduled = false
    for (const slot of this.hooks) slot.dispose?.()
    this.dom?.parentNode?.removeChild(this.dom)
  }

  /**
   * 호출 순서대로 다음 칸을 내줍니다. Hook을 이름이 아니라 순서로 찾으므로
   * 조건문 안에서 Hook을 부르면 칸이 어긋납니다. 어긋나면 조용히 틀리지 않고 바로 알립니다.
   */
  claimSlot<T extends HookSlot>(kind: T['kind'], create: () => T): T {
    const index = this.cursor
    this.cursor += 1

    const existing = this.hooks[index]
    if (!existing) {
      if (this.status === 'mounted') throw new Error('렌더링 사이에 Hook 개수가 늘어났습니다.')
      const slot = create()
      this.hooks[index] = slot
      return slot
    }

    if (existing.kind !== kind) {
      throw new Error(`Hook 순서가 바뀌었습니다. ${index}번 칸은 ${existing.kind}인데 ${kind}로 호출됐습니다.`)
    }
    return existing as T
  }

  queueEffect(effect: PendingEffect): void {
    this.effectQueue.push(effect)
  }

  /**
   * 다시 그리기를 예약합니다. 이미 예약돼 있으면 아무 일도 하지 않으므로,
   * 한 이벤트 안의 setState 여러 번은 마이크로태스크에서 한 번의 렌더로 합쳐집니다(Batching).
   */
  scheduleUpdate(): void {
    if (this.updateScheduled || this.status === 'unmounted') return
    this.updateScheduled = true
    queueMicrotask(() => this.flushScheduledUpdate())
  }

  private flushScheduledUpdate(): void {
    // 그사이 update()를 직접 불렀다면 이미 최신이므로 다시 그리지 않습니다.
    if (!this.updateScheduled) return
    this.updateScheduled = false
    if (this.status !== 'mounted') return

    if (this.isUpdateLoop()) {
      console.error('렌더링이 끝없이 반복되어 멈췄습니다. useEffect의 setState와 deps를 확인하세요.')
      return
    }
    this.update()
  }

  /** 마이크로태스크가 이어지는 동안에는 setTimeout이 못 돌기 때문에 카운터가 계속 쌓입니다. */
  private isUpdateLoop(): boolean {
    if (this.updatesThisTick === 0) {
      setTimeout(() => {
        this.updatesThisTick = 0
      })
    }
    this.updatesThisTick += 1
    return this.updatesThisTick > MAX_UPDATES_PER_TICK
  }

  private render(): VNode {
    const previousOwner = currentOwner
    currentOwner = this
    this.cursor = 0
    this.effectQueue = []

    try {
      const tree = this.component(this.props) ?? textNode('')
      if (this.status === 'mounted' && this.cursor !== this.hooks.length) {
        throw new Error('렌더링 사이에 Hook 개수가 줄었습니다. 조건문 안에서 Hook을 호출했는지 확인하세요.')
      }
      this.renderCount += 1
      return tree
    } finally {
      currentOwner = previousOwner
    }
  }

  /** 이번 커밋의 정리 함수를 모두 실행한 뒤 새 effect를 실행합니다. */
  private flushEffects(): void {
    const queue = this.effectQueue
    this.effectQueue = []
    for (const effect of queue) effect.cleanup()
    for (const effect of queue) effect.run()
  }
}
