import { getHookOwner } from '../function-component.ts'
import type { HookSlot } from '../function-component.ts'
import { depsChanged } from './deps.ts'
import type { Deps } from './deps.ts'

interface MemoSlot<T> extends HookSlot {
  kind: 'memo'
  deps: Deps | undefined
  value: T | undefined
}

/** deps가 그대로면 지난 결과를 돌려주고, 바뀌었을 때만 다시 계산합니다. */
export function useMemo<T>(factory: () => T, deps: Deps): T {
  const owner = getHookOwner('useMemo')

  const slot = owner.claimSlot<MemoSlot<T>>('memo', () => ({
    kind: 'memo',
    deps: undefined,
    value: undefined,
  }))

  if (depsChanged(slot.deps, deps)) {
    slot.value = factory()
    slot.deps = deps
  }

  return slot.value as T
}
