import { beforeEach, describe, expect, it, vi } from '../testing.mjs'
import { createLabControls } from '../../app/controls.ts'
import type { LabControls, LabTransition } from '../../app/controls.ts'
import { createDom } from '../../phase1/patch.ts'
import { elementNode, textNode } from '../../phase1/types.ts'
import type { VNode } from '../../phase1/types.ts'

const page = (text: string) => elementNode('div', {}, [elementNode('p', {}, [textNode(text)])])

describe('createLabControls', () => {
  let testArea: VNode
  let real: HTMLElement
  let transitions: LabTransition[]
  let controls: LabControls
  let writeTestArea: ReturnType<typeof vi.fn>

  beforeEach(() => {
    const initial = page('처음')
    testArea = initial
    real = createDom(initial) as HTMLElement
    transitions = []
    writeTestArea = vi.fn((vnode: VNode) => {
      testArea = vnode
    })
    controls = createLabControls({
      realRoot: real,
      initial,
      readTestArea: () => testArea,
      writeTestArea,
      onTransition: (transition) => transitions.push(transition),
    })
  })

  it('Patch를 누르면 실제 영역이 바뀌고 기록이 늘어난다', () => {
    testArea = page('둘째')
    controls.patch()

    expect(real.textContent).toBe('둘째')
    expect(controls.history.size).toBe(2)
    expect(transitions.at(-1)?.patches).toEqual([{ type: 'TEXT', path: [0, 0], text: '둘째' }])
  })

  it('바뀐 게 없으면 기록을 늘리지 않는다', () => {
    testArea = page('처음')
    controls.patch()

    expect(controls.history.size).toBe(1)
    expect(transitions.at(-1)).toMatchObject({ action: 'patch', patches: [] })
  })

  it('뒤로가기는 실제 영역과 테스트 영역을 함께 되돌린다', () => {
    testArea = page('둘째')
    controls.patch()
    controls.back()

    expect(real.textContent).toBe('처음')
    expect(writeTestArea).toHaveBeenCalledOnce()
    expect(testArea).toEqual(page('처음'))
  })

  it('앞으로가기로 다시 돌아온다', () => {
    testArea = page('둘째')
    controls.patch()
    controls.back()
    controls.forward()

    expect(real.textContent).toBe('둘째')
    expect(testArea).toEqual(page('둘째'))
  })

  it('기록 이동도 전체를 다시 그리지 않고 바뀐 곳만 고친다', () => {
    const paragraph = real.firstChild
    testArea = page('둘째')
    controls.patch()
    controls.back()

    expect(real.firstChild).toBe(paragraph)
    expect(transitions.at(-1)?.patches).toHaveLength(1)
  })

  it('갈 곳이 없으면 아무 일도 하지 않는다', () => {
    controls.back()
    controls.forward()
    controls.jumpTo(9)

    expect(transitions).toEqual([])
    expect(writeTestArea).not.toHaveBeenCalled()
  })

  it('특정 버전으로 바로 이동한다', () => {
    testArea = page('둘째')
    controls.patch()
    testArea = page('셋째')
    controls.patch()
    controls.jumpTo(0)

    expect(real.textContent).toBe('처음')
    expect(transitions.at(-1)?.action).toBe('jump')
  })

  it('되돌아간 뒤 새로 Patch하면 앞쪽 기록이 사라진다', () => {
    testArea = page('둘째')
    controls.patch()
    controls.back()
    testArea = page('새 가지')
    controls.patch()

    expect(controls.history.size).toBe(2)
    expect(controls.history.canForward).toBe(false)
    expect(real.textContent).toBe('새 가지')
  })
})
