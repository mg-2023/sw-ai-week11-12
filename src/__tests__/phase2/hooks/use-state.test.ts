import { describe, expect, it, vi } from '../../testing.mjs'
import { FunctionComponent } from '../../../phase2/function-component.ts'
import { h } from '../../../phase2/h.ts'
import { useState } from '../../../phase2/hooks/use-state.ts'
import type { SetState } from '../../../phase2/hooks/use-state.ts'

const flush = () => Promise.resolve()

function setup<T>(initial: T | (() => T)) {
  const seen: T[] = []
  let setValue: SetState<T> = () => {}
  const instance = new FunctionComponent(() => {
    const [value, set] = useState<T>(initial)
    setValue = set
    seen.push(value)
    return h('p', null)
  }, {})
  instance.mount(document.createElement('div'))
  return { instance, seen, set: (next: T | ((previous: T) => T)) => setValue(next) }
}

describe('useState', () => {
  it('초기값을 돌려준다', () => {
    expect(setup(5).seen).toEqual([5])
  })

  it('함수가 다시 실행되어도 상태가 유지된다', async () => {
    const { instance, seen, set } = setup(0)
    set(1)
    await flush()
    instance.update()
    expect(seen).toEqual([0, 1, 1])
  })

  it('지연 초기값 함수는 첫 렌더에서만 실행한다', async () => {
    const init = vi.fn(() => 1)
    const { set } = setup(init)
    set(2)
    await flush()
    expect(init).toHaveBeenCalledOnce()
  })

  it('갱신 함수는 앞선 변경을 이어받는다', async () => {
    const { seen, set } = setup(0)
    set((value) => value + 1)
    set((value) => value + 1)
    set((value) => value + 1)
    await flush()
    expect(seen.at(-1)).toBe(3)
  })

  it('같은 값이면 다시 그리지 않는다', async () => {
    const { instance, set } = setup(1)
    set(1)
    await flush()
    expect(instance.renderCount).toBe(1)
  })

  it('NaN도 같은 값으로 본다', async () => {
    const { instance, set } = setup(Number.NaN)
    set(Number.NaN)
    await flush()
    expect(instance.renderCount).toBe(1)
  })

  it('+0과 -0은 다른 값으로 본다', async () => {
    const { instance, set } = setup(0)
    set(-0)
    await flush()
    expect(instance.renderCount).toBe(2)
  })

  it('객체를 안에서 고치고 같은 참조를 넣으면 바뀐 줄 모른다', async () => {
    const list = [1]
    const { instance, set } = setup(list)
    list.push(2)
    set(list)
    await flush()
    expect(instance.renderCount).toBe(1)
  })

  it('setter는 렌더가 반복돼도 같은 함수다', async () => {
    const setters: SetState<number>[] = []
    const instance = new FunctionComponent(() => {
      const [, set] = useState(0)
      setters.push(set)
      return h('p', null)
    }, {})
    instance.mount(document.createElement('div'))
    instance.update()
    expect(setters[0]).toBe(setters[1])
  })

  it('상태 여러 개가 호출 순서로 구분된다', async () => {
    let setSecond: SetState<string> = () => {}
    const seen: string[] = []
    const instance = new FunctionComponent(() => {
      const [first] = useState('첫째')
      const [second, set] = useState('둘째')
      setSecond = set
      seen.push(`${first}/${second}`)
      return h('p', null)
    }, {})
    instance.mount(document.createElement('div'))

    setSecond('바뀜')
    await flush()
    expect(seen.at(-1)).toBe('첫째/바뀜')
  })

  it('컴포넌트 인스턴스마다 상태가 따로 있다', async () => {
    const first = setup(1)
    const second = setup(10)
    first.set(2)
    await flush()
    expect(first.seen.at(-1)).toBe(2)
    expect(second.seen.at(-1)).toBe(10)
  })
})
