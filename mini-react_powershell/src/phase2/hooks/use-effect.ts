import { getHookOwner } from '../function-component.ts'
import type { HookSlot } from '../function-component.ts'
import { depsChanged } from './deps.ts'
import type { Deps } from './deps.ts'

export type Cleanup = () => void
export type EffectCallback = () => Cleanup | void

interface EffectSlot extends HookSlot {
  kind: 'effect'
  deps: Deps | undefined
  cleanup: Cleanup | undefined
}

/**
 * 렌더 중에는 "실행할 일"만 예약하고, 화면 반영이 끝난 뒤 실행합니다.
 * deps도 그때 저장합니다. 렌더가 도중에 실패하면 effect가 실행됐다고 착각하지 않기 위해서입니다.
 */
export function useEffect(effect: EffectCallback, deps?: Deps): void {
  const owner = getHookOwner('useEffect')

  const slot = owner.claimSlot<EffectSlot>('effect', () => {
    const created: EffectSlot = {
      kind: 'effect',
      deps: undefined,
      cleanup: undefined,
      dispose() {
        created.cleanup?.()
        created.cleanup = undefined
      },
    }
    return created
  })

  if (!depsChanged(slot.deps, deps)) return

  owner.queueEffect({
    cleanup() {
      slot.dispose?.()
    },
    run() {
      slot.deps = deps
      const cleanup = effect()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    },
  })
}
