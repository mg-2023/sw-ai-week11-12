import { describe, expect, it, vi } from '../../testing.mjs'
import { FunctionComponent } from '../../../phase2/function-component.ts'
import { h } from '../../../phase2/h.ts'
import { useEffect } from '../../../phase2/hooks/use-effect.ts'
import type { Cleanup } from '../../../phase2/hooks/use-effect.ts'
import type { Deps } from '../../../phase2/hooks/deps.ts'
import { useState } from '../../../phase2/hooks/use-state.ts'

const flush = () => Promise.resolve()

function setup(effect: () => Cleanup | void, getDeps: () => Deps | undefined) {
  const instance = new FunctionComponent(() => {
    useEffect(effect, getDeps())
    return h('p', null)
  }, {})
  instance.mount(document.createElement('div'))
  return instance
}

describe('useEffect 실행 시점', () => {
  it('화면 반영이 끝난 뒤에 실행한다', () => {
    const container = document.createElement('div')
    let textDuringEffect: string | null = null
    new FunctionComponent(() => {
      useEffect(() => {
        textDuringEffect = container.textContent
      }, [])
      return h('p', null, '그려짐')
    }, {}).mount(container)

    expect(textDuringEffect).toBe('그려짐')
  })

  it('렌더 함수 실행 중에는 아직 실행하지 않는다', () => {
    const order: string[] = []
    new FunctionComponent(() => {
      useEffect(() => {
        order.push('effect')
      })
      order.push('render')
      return h('p', null)
    }, {}).mount(document.createElement('div'))

    expect(order).toEqual(['render', 'effect'])
  })
})

describe('useEffect deps', () => {
  it('deps가 없으면 렌더마다 실행한다', () => {
    const effect = vi.fn()
    const instance = setup(effect, () => undefined)
    instance.update()
    instance.update()
    expect(effect).toHaveBeenCalledTimes(3)
  })

  it('빈 배열이면 처음 한 번만 실행한다', () => {
    const effect = vi.fn()
    const instance = setup(effect, () => [])
    instance.update()
    expect(effect).toHaveBeenCalledOnce()
  })

  it('deps 값이 바뀔 때만 실행한다', () => {
    const effect = vi.fn()
    let value = 1
    const instance = setup(effect, () => [value])

    instance.update()
    expect(effect).toHaveBeenCalledTimes(1)

    value = 2
    instance.update()
    expect(effect).toHaveBeenCalledTimes(2)
  })

  it('deps는 Object.is로 비교한다', () => {
    const effect = vi.fn()
    const instance = setup(effect, () => [Number.NaN])
    instance.update()
    expect(effect).toHaveBeenCalledOnce()
  })

  it('deps 길이가 바뀌면 실행한다', () => {
    const effect = vi.fn()
    let deps: Deps = [1]
    const instance = setup(effect, () => deps)
    deps = [1, 2]
    instance.update()
    expect(effect).toHaveBeenCalledTimes(2)
  })

  it('effect는 그 렌더 시점의 값을 본다', async () => {
    const seen: number[] = []
    let increase = () => {}
    new FunctionComponent(() => {
      const [count, setCount] = useState(0)
      increase = () => setCount(count + 1)
      useEffect(() => {
        seen.push(count)
      }, [count])
      return h('p', null)
    }, {}).mount(document.createElement('div'))

    increase()
    await flush()
    expect(seen).toEqual([0, 1])
  })
})

describe('useEffect 정리 함수', () => {
  it('다음 effect 전에 이전 정리 함수를 부른다', () => {
    const order: string[] = []
    let value = 1
    const instance = setup(
      () => {
        const current = value
        order.push(`실행 ${current}`)
        return () => order.push(`정리 ${current}`)
      },
      () => [value],
    )

    value = 2
    instance.update()
    expect(order).toEqual(['실행 1', '정리 1', '실행 2'])
  })

  it('deps가 그대로면 정리 함수도 부르지 않는다', () => {
    const cleanup = vi.fn()
    const instance = setup(() => cleanup, () => [])
    instance.update()
    expect(cleanup).not.toHaveBeenCalled()
  })

  it('unmount 때 부르고 두 번 부르지 않는다', () => {
    const cleanup = vi.fn()
    const instance = setup(() => cleanup, () => [])
    instance.unmount()
    instance.unmount()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('모든 정리 함수를 먼저 부르고 새 effect를 실행한다', () => {
    const order: string[] = []
    const instance = new FunctionComponent(() => {
      useEffect(() => {
        order.push('실행 A')
        return () => order.push('정리 A')
      })
      useEffect(() => {
        order.push('실행 B')
        return () => order.push('정리 B')
      })
      return h('p', null)
    }, {})
    instance.mount(document.createElement('div'))
    order.length = 0

    instance.update()
    expect(order).toEqual(['정리 A', '정리 B', '실행 A', '실행 B'])
  })

  it('정리 함수를 돌려주지 않아도 된다', () => {
    const instance = setup(() => {}, () => undefined)
    expect(() => instance.update()).not.toThrow()
    expect(() => instance.unmount()).not.toThrow()
  })

  it('타이머 effect는 정리 함수 덕분에 멈춘 뒤 늘어나지 않는다', async () => {
    vi.useFakeTimers()
    let ticks = 0
    let setRunning = (_running: boolean) => {}
    const instance = new FunctionComponent(() => {
      const [running, set] = useState(true)
      setRunning = set
      useEffect(() => {
        if (!running) return
        const timer = setInterval(() => {
          ticks += 1
        }, 1000)
        return () => clearInterval(timer)
      }, [running])
      return h('p', null)
    }, {})
    instance.mount(document.createElement('div'))

    vi.advanceTimersByTime(2000)
    setRunning(false)
    await flush()
    vi.advanceTimersByTime(5000)

    expect(ticks).toBe(2)
    vi.useRealTimers()
  })
})

describe('useEffect와 렌더 실패', () => {
  it('렌더가 실패하면 그 렌더의 effect를 실행하지 않고, 성공한 렌더에서 다시 시도한다', () => {
    const effect = vi.fn()
    const instance = new FunctionComponent(({ value, fail }: { value: number; fail: boolean }) => {
      useEffect(effect, [value])
      if (fail) throw new Error('렌더 실패')
      return h('p', null)
    }, { value: 1, fail: false })
    instance.mount(document.createElement('div'))

    expect(() => instance.update({ value: 2, fail: true })).toThrow('렌더 실패')
    expect(effect).toHaveBeenCalledTimes(1)

    instance.update({ value: 2, fail: false })
    expect(effect).toHaveBeenCalledTimes(2)
  })
})
