import { afterEach, describe, expect, it, vi } from '../testing.mjs'
import type { VNode } from '../../phase1/types.ts'
import { FunctionComponent } from '../../phase2/function-component.ts'
import type { Component, FunctionComponentOptions } from '../../phase2/function-component.ts'
import { h } from '../../phase2/h.ts'
import { useEffect } from '../../phase2/hooks/use-effect.ts'
import { useMemo } from '../../phase2/hooks/use-memo.ts'
import { useState } from '../../phase2/hooks/use-state.ts'
import type { SetState } from '../../phase2/hooks/use-state.ts'

const flush = () => Promise.resolve()

function mountInto<P>(component: Component<P>, props: P, options?: FunctionComponentOptions) {
  const container = document.createElement('div')
  const instance = new FunctionComponent(component, props, options)
  instance.mount(container)
  return { container, instance }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('mount', () => {
  it('컴포넌트 결과를 컨테이너에 그린다', () => {
    const { container } = mountInto(({ name }: { name: string }) => h('p', null, name), { name: '가' })
    expect(container.innerHTML).toBe('<p>가</p>')
  })

  it('null을 돌려주는 컴포넌트도 그릴 수 있다', () => {
    const { container, instance } = mountInto(() => null, {})
    expect(container.textContent).toBe('')
    expect(instance.renderCount).toBe(1)
  })

  it('두 번 mount하면 오류를 낸다', () => {
    const { container, instance } = mountInto(() => h('p', null), {})
    expect(() => instance.mount(container)).toThrow('이미 mount')
  })

  it('hooks 배열에 Hook 호출 수만큼 칸이 생긴다', () => {
    const { instance } = mountInto(() => {
      useState(0)
      useMemo(() => 1, [])
      useEffect(() => {})
      return h('p', null)
    }, {})
    expect(instance.hooks.map((slot) => slot.kind)).toEqual(['state', 'memo', 'effect'])
  })
})

describe('update', () => {
  it('상태가 바뀌면 화면이 자동으로 바뀐다', async () => {
    let setCount: SetState<number> = () => {}
    const { container } = mountInto(() => {
      const [count, set] = useState(0)
      setCount = set
      return h('p', null, `횟수 ${count}`)
    }, {})

    setCount(1)
    await flush()
    expect(container.textContent).toBe('횟수 1')
  })

  it('전체를 다시 만들지 않고 바뀐 노드만 고친다', async () => {
    let setCount: SetState<number> = () => {}
    const { container } = mountInto(() => {
      const [count, set] = useState(0)
      setCount = set
      return h('section', null, h('h2', null, '제목'), h('p', null, String(count)))
    }, {})
    const section = container.firstChild
    const title = container.querySelector('h2')
    const paragraph = container.querySelector('p')

    setCount(1)
    await flush()

    expect(container.firstChild).toBe(section)
    expect(container.querySelector('h2')).toBe(title)
    expect(container.querySelector('p')).toBe(paragraph)
  })

  it('새 props로 다시 그릴 수 있다', () => {
    const { container, instance } = mountInto(({ name }: { name: string }) => h('p', null, name), { name: '가' })
    instance.update({ name: '나' })
    expect(container.textContent).toBe('나')
  })

  it('루트 태그가 바뀌어도 이후 업데이트가 이어진다', async () => {
    let setOn: SetState<boolean> = () => {}
    const { container } = mountInto(() => {
      const [on, set] = useState(false)
      setOn = set
      return on ? h('b', null, '켬') : h('i', null, '끔')
    }, {})

    setOn(true)
    await flush()
    expect(container.innerHTML).toBe('<b>켬</b>')

    setOn(false)
    await flush()
    expect(container.innerHTML).toBe('<i>끔</i>')
  })

  it('다시 그려도 입력칸의 포커스와 커서가 유지된다', async () => {
    let setDraft: SetState<string> = () => {}
    const { container } = mountInto(() => {
      const [draft, set] = useState('')
      setDraft = set
      return h('div', null, h('input', { value: draft }), h('p', null, draft))
    }, {})
    document.body.append(container)

    const input = container.querySelector('input') as HTMLInputElement
    input.focus()
    input.value = '가나다'
    input.setSelectionRange(1, 1)

    setDraft('가나다')
    await flush()

    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(1)
    container.remove()
  })

  it('새로 만들어진 핸들러가 최신 상태를 본다', async () => {
    const { container } = mountInto(() => {
      const [count, setCount] = useState(0)
      return h('button', { onClick: () => setCount(count + 1) }, String(count))
    }, {})
    const button = container.querySelector('button') as HTMLButtonElement

    button.click()
    await flush()
    button.click()
    await flush()

    expect(button.textContent).toBe('2')
  })

  it('화면 반영 뒤 연산 목록을 알려 준다', async () => {
    const onCommit = vi.fn()
    let setCount: SetState<number> = () => {}
    mountInto(
      () => {
        const [count, set] = useState(0)
        setCount = set
        return h('p', null, String(count))
      },
      {},
      { onCommit },
    )

    setCount(1)
    await flush()

    expect(onCommit).toHaveBeenLastCalledWith({
      phase: 'update',
      renderCount: 2,
      patches: [{ type: 'TEXT', path: [0], text: '1' }],
    })
  })
})

describe('Batching', () => {
  it('한 번의 흐름에서 여러 상태를 바꿔도 렌더는 한 번이다', async () => {
    let setA: SetState<number> = () => {}
    let setB: SetState<number> = () => {}
    const { container, instance } = mountInto(() => {
      const [a, updateA] = useState(0)
      const [b, updateB] = useState(0)
      setA = updateA
      setB = updateB
      return h('p', null, `${a}-${b}`)
    }, {})

    setA(1)
    setB(2)
    setA(3)
    expect(instance.renderCount).toBe(1)

    await flush()
    expect(instance.renderCount).toBe(2)
    expect(container.textContent).toBe('3-2')
  })

  it('update()를 직접 불렀다면 예약된 렌더는 건너뛴다', async () => {
    let setCount: SetState<number> = () => {}
    const { instance } = mountInto(() => {
      const [count, set] = useState(0)
      setCount = set
      return h('p', null, String(count))
    }, {})

    setCount(1)
    instance.update()
    await flush()
    expect(instance.renderCount).toBe(2)
  })

  it('렌더 중 상태를 바꿔도 결과가 화면에 반영된다', async () => {
    const { container } = mountInto(() => {
      const [count, setCount] = useState(0)
      if (count < 2) setCount(count + 1)
      return h('p', null, String(count))
    }, {})
    await flush()
    await flush()
    await flush()
    expect(container.textContent).toBe('2')
  })
})

describe('Hook 규칙', () => {
  it('컴포넌트 밖에서 부르면 오류를 낸다', () => {
    expect(() => useState(0)).toThrow('렌더링되는 동안')
  })

  it('자식 컴포넌트에서 useState를 부르면 오류를 낸다', () => {
    const Child = (): VNode => {
      useState(0)
      return h('p', null)
    }
    expect(() => mountInto(() => h(Child, {}), {})).toThrow('루트 컴포넌트에서만')
  })

  it.each([
    ['useEffect', () => useEffect(() => {})],
    ['useMemo', () => useMemo(() => 1, [])],
  ])('자식 컴포넌트에서 %s도 막는다', (_name, callHook) => {
    const Child = (): VNode => {
      callHook()
      return h('p', null)
    }
    expect(() => mountInto(() => h(Child, {}), {})).toThrow('루트 컴포넌트에서만')
  })

  it('손자 컴포넌트에서도 막고, 빠져나오면 루트의 Hook은 다시 된다', () => {
    const Grandchild = (): VNode => {
      useState(0)
      return h('p', null)
    }
    const Child = (): VNode => h(Grandchild, {})
    expect(() => mountInto(() => h(Child, {}), {})).toThrow('루트 컴포넌트에서만')

    const { instance } = mountInto(() => {
      useState(0)
      return h('p', null)
    }, {})
    expect(instance.hooks).toHaveLength(1)
  })

  it('Hook 순서가 바뀌면 오류를 낸다', () => {
    const { instance } = mountInto(({ swap }: { swap: boolean }) => {
      if (swap) {
        useMemo(() => 1, [])
        useState(0)
      } else {
        useState(0)
        useMemo(() => 1, [])
      }
      return h('p', null)
    }, { swap: false })

    expect(() => instance.update({ swap: true })).toThrow('Hook 순서가 바뀌었습니다')
  })

  it('Hook이 늘어나면 오류를 낸다', () => {
    const { instance } = mountInto(({ extra }: { extra: boolean }) => {
      useState(0)
      if (extra) useState(1)
      return h('p', null)
    }, { extra: false })

    expect(() => instance.update({ extra: true })).toThrow('늘어났습니다')
  })

  it('Hook이 줄어들면 오류를 낸다', () => {
    const { instance } = mountInto(({ extra }: { extra: boolean }) => {
      useState(0)
      if (extra) useState(1)
      return h('p', null)
    }, { extra: true })

    expect(() => instance.update({ extra: false })).toThrow('줄었습니다')
  })

  it('렌더가 실패해도 화면과 다음 렌더는 살아 있다', () => {
    const { container, instance } = mountInto(({ fail }: { fail: boolean }) => {
      useState(0)
      if (fail) throw new Error('렌더 실패')
      return h('p', null, '정상')
    }, { fail: false })

    expect(() => instance.update({ fail: true })).toThrow('렌더 실패')
    expect(container.textContent).toBe('정상')
    expect(() => instance.update({ fail: false })).not.toThrow()
    expect(() => useState(0)).toThrow('렌더링되는 동안')
  })
})

describe('자식 컴포넌트와 props', () => {
  it('부모 상태가 props로 내려가고 이벤트가 위로 올라온다', async () => {
    const Display = ({ value }: { value: number }): VNode => h('output', null, String(value))
    const Button = ({ onPress }: { onPress: () => void }): VNode =>
      h('button', { onClick: onPress }, '더하기')

    const { container } = mountInto(() => {
      const [count, setCount] = useState(0)
      return h('div', null, h(Display, { value: count }), h(Button, { onPress: () => setCount(count + 1) }))
    }, {})

    ;(container.querySelector('button') as HTMLButtonElement).click()
    await flush()
    expect(container.querySelector('output')?.textContent).toBe('1')
  })

  it('key를 준 자식 컴포넌트 목록은 순서가 바뀌어도 DOM을 재사용한다', async () => {
    const Row = ({ label }: { label: string }): VNode => h('li', null, label)
    let setItems: SetState<string[]> = () => {}
    const { container } = mountInto(() => {
      const [items, set] = useState(['가', '나', '다'])
      setItems = set
      return h('ul', null, items.map((item) => h(Row, { key: item, label: item })))
    }, {})
    const first = container.querySelector('li')

    setItems(['다', '나', '가'])
    await flush()

    expect(container.querySelector('li:last-child')).toBe(first)
  })
})

describe('unmount', () => {
  it('화면에서 내리고 정리 함수를 부른다', () => {
    const cleanup = vi.fn()
    const { container, instance } = mountInto(() => {
      useEffect(() => cleanup, [])
      return h('p', null)
    }, {})

    instance.unmount()
    expect(container.innerHTML).toBe('')
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('내린 뒤 상태를 바꿔도 아무 일도 일어나지 않는다', async () => {
    let setCount: SetState<number> = () => {}
    const { instance } = mountInto(() => {
      const [count, set] = useState(0)
      setCount = set
      return h('p', null, String(count))
    }, {})

    instance.unmount()
    setCount(1)
    await flush()
    expect(instance.renderCount).toBe(1)
  })

  it('예약된 렌더가 있어도 내리면 취소된다', async () => {
    let setCount: SetState<number> = () => {}
    const { instance } = mountInto(() => {
      const [count, set] = useState(0)
      setCount = set
      return h('p', null, String(count))
    }, {})

    setCount(1)
    instance.unmount()
    await flush()
    expect(instance.renderCount).toBe(1)
  })
})

describe('무한 루프 방지', () => {
  it('deps 없는 effect가 계속 상태를 바꾸면 경고하고 멈춘다', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { instance } = mountInto(() => {
      const [count, setCount] = useState(0)
      useEffect(() => {
        setCount(count + 1)
      })
      return h('p', null, String(count))
    }, {})

    for (let turn = 0; turn < 80; turn += 1) await flush()

    expect(consoleError).toHaveBeenCalledOnce()
    expect(instance.renderCount).toBeLessThan(60)
  })
})
