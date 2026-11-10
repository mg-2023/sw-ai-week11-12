import { beforeEach, describe, expect, it } from '../testing.mjs'
import { recordTouch } from '../../app/inspector.ts'
import type { TouchedNodes } from '../../app/inspector.ts'

let touched: TouchedNodes

beforeEach(() => {
  touched = new Map()
})

describe('recordTouch', () => {
  it('바뀐 노드와 연산 종류를 기록한다', () => {
    const element = document.createElement('p')

    recordTouch(touched, { type: 'PROPS', path: [], set: {}, remove: [] }, element)

    expect(touched.get(element)).toBe('PROPS')
  })

  it('삭제는 부모 노드에 기록한다', () => {
    const parent = document.createElement('ul')

    recordTouch(touched, { type: 'REMOVE', path: [], index: 0 }, parent)

    expect(touched.get(parent)).toBe('REMOVE')
  })

  it('핸들러 교체는 DOM을 바꾸지 않으므로 기록하지 않는다', () => {
    const element = document.createElement('p')

    recordTouch(touched, { type: 'LISTENERS', path: [], set: {}, remove: [] }, element)

    expect(touched.size).toBe(0)
  })
})
