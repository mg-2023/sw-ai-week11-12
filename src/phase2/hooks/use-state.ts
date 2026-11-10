import { getHookOwner } from '../function-component.ts'
import type { HookSlot } from '../function-component.ts'

export type SetState<T> = (next: T | ((previous: T) => T)) => void

interface StateSlot<T> extends HookSlot {
  kind: 'state'
  value: T
  setValue: SetState<T>
}

export function useState<T>(initial: T | (() => T)): [T, SetState<T>] {
  const owner = getHookOwner('useState')

  const slot = owner.claimSlot<StateSlot<T>>('state', () => {
    const created: StateSlot<T> = {
      kind: 'state',
      // 함수를 넘기면 첫 렌더에서만 실행합니다. 비싼 초기값 계산을 매번 하지 않기 위해서입니다.
      value: typeof initial === 'function' ? (initial as () => T)() : initial,

      // 이 함수는 칸이 만들어질 때 한 번만 생기므로, 렌더가 반복돼도 같은 함수입니다.
      setValue(next) {
        const value = typeof next === 'function' ? (next as (previous: T) => T)(created.value) : next
        if (Object.is(value, created.value)) return
        created.value = value
        owner.scheduleUpdate()
      },
    }
    return created
  })

  return [slot.value, slot.setValue]
}
