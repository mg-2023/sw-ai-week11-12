import { describe, expect, it, vi } from '../../testing.mjs'
import { diff } from '../../../phase1/diff.ts'
import type { VNode } from '../../../phase1/types.ts'
import { FunctionComponent } from '../../../phase2/function-component.ts'
import { h } from '../../../phase2/h.ts'
import { useMemo } from '../../../phase2/hooks/use-memo.ts'
import type { Deps } from '../../../phase2/hooks/deps.ts'

function setup<T>(factory: () => T, getDeps: () => Deps) {
  const seen: T[] = []
  const instance = new FunctionComponent(() => {
    seen.push(useMemo(factory, getDeps()))
    return h('p', null)
  }, {})
  instance.mount(document.createElement('div'))
  return { instance, seen }
}

describe('useMemo', () => {
  it('첫 렌더에서 계산한다', () => {
    const { seen } = setup(() => 42, () => [])
    expect(seen).toEqual([42])
  })

  it('deps가 그대로면 다시 계산하지 않고 같은 값을 돌려준다', () => {
    const factory = vi.fn(() => ({ total: 1 }))
    const { instance, seen } = setup(factory, () => [1])
    instance.update()
    expect(factory).toHaveBeenCalledOnce()
    expect(seen[0]).toBe(seen[1])
  })

  it('deps가 바뀌면 다시 계산한다', () => {
    let value = 1
    const factory = vi.fn(() => value * 2)
    const { instance, seen } = setup(factory, () => [value])
    value = 2
    instance.update()
    expect(seen).toEqual([2, 4])
  })

  it('바뀌었다가 돌아와도 직전 값만 기억하므로 다시 계산한다', () => {
    let value = 1
    const factory = vi.fn(() => value)
    const { instance } = setup(factory, () => [value])
    value = 2
    instance.update()
    value = 1
    instance.update()
    expect(factory).toHaveBeenCalledTimes(3)
  })

  it('undefined 결과도 캐시한다', () => {
    const factory = vi.fn(() => undefined)
    const { instance } = setup(factory, () => [])
    instance.update()
    expect(factory).toHaveBeenCalledOnce()
  })

  it('계산이 실패하면 다음 렌더에서 다시 시도한다', () => {
    let shouldFail = true
    const factory = vi.fn(() => {
      if (shouldFail) throw new Error('계산 실패')
      return 1
    })
    const instance = new FunctionComponent(() => {
      useMemo(factory, [])
      return h('p', null)
    }, {})

    expect(() => instance.mount(document.createElement('div'))).toThrow('계산 실패')
    shouldFail = false
    expect(() => instance.mount(document.createElement('div'))).not.toThrow()
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('메모한 트리는 Diff가 내부를 보지 않고 넘어간다', () => {
    const trees: VNode[] = []
    const factory = vi.fn(() => h('ul', null, h('li', null, '무거운 목록')))
    const instance = new FunctionComponent(() => {
      const list = useMemo<VNode>(factory, [])
      const tree = h('div', null, list)
      trees.push(tree)
      return tree
    }, {})
    instance.mount(document.createElement('div'))
    instance.update()

    expect(diff(trees[0], trees[1])).toEqual([])
    expect(factory).toHaveBeenCalledOnce()
  })
})
