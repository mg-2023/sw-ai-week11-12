import { describe, expect, it } from '../testing.mjs'
import { VdomHistory } from '../../phase1/history.ts'

describe('VdomHistory', () => {
  it('처음에는 초기값 하나만 있고 어느 쪽으로도 갈 수 없다', () => {
    const history = new VdomHistory('v1')
    expect(history.current).toBe('v1')
    expect(history.size).toBe(1)
    expect(history.canBack).toBe(false)
    expect(history.canForward).toBe(false)
  })

  it('뒤로 갔다가 앞으로 돌아온다', () => {
    const history = new VdomHistory('v1')
    history.push('v2')
    history.push('v3')

    expect(history.back()).toBe('v2')
    expect(history.back()).toBe('v1')
    expect(history.forward()).toBe('v2')
    expect(history.current).toBe('v2')
  })

  it('양 끝을 넘어가면 null이고 위치는 그대로다', () => {
    const history = new VdomHistory('v1')
    expect(history.back()).toBeNull()
    expect(history.forward()).toBeNull()
    expect(history.current).toBe('v1')
  })

  it('과거에서 새로 저장하면 앞쪽 기록을 버린다', () => {
    const history = new VdomHistory('v1')
    history.push('v2')
    history.push('v3')
    history.back()
    history.back()
    history.push('새 가지')

    expect(history.size).toBe(2)
    expect(history.current).toBe('새 가지')
    expect(history.canForward).toBe(false)
  })

  it('특정 위치로 바로 이동한다', () => {
    const history = new VdomHistory('v1')
    history.push('v2')
    history.push('v3')

    expect(history.go(0)).toBe('v1')
    expect(history.position).toBe(0)
  })

  it.each([[-1], [3], [1.5], [Number.NaN]])('잘못된 위치 %s에는 움직이지 않는다', (index) => {
    const history = new VdomHistory('v1')
    history.push('v2')
    history.push('v3')

    expect(history.go(index)).toBeNull()
    expect(history.current).toBe('v3')
  })

  it('한도를 넘으면 가장 오래된 기록부터 버린다', () => {
    const history = new VdomHistory('v1', 3)
    history.push('v2')
    history.push('v3')
    history.push('v4')

    expect(history.size).toBe(3)
    expect(history.current).toBe('v4')
    expect(history.go(0)).toBe('v2')
  })

  it('한도가 0 이하여도 현재 값 하나는 지킨다', () => {
    const history = new VdomHistory('v1', 0)
    history.push('v2')
    expect(history.size).toBe(1)
    expect(history.current).toBe('v2')
  })
})
