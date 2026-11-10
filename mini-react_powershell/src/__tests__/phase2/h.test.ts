import { describe, expect, it } from '../testing.mjs'
import { elementNode, textNode } from '../../phase1/types.ts'
import type { VNode } from '../../phase1/types.ts'
import { h } from '../../phase2/h.ts'

describe('h: 요소', () => {
  it('태그와 props, 자식으로 노드를 만든다', () => {
    expect(h('p', { title: '가' }, '안녕')).toEqual(elementNode('p', { title: '가' }, [textNode('안녕')]))
  })

  it('props가 null이어도 된다', () => {
    expect(h('p', null)).toEqual(elementNode('p'))
  })

  it('숫자 자식은 글자가 되고 0도 사라지지 않는다', () => {
    expect(h('p', null, 0, 1)).toEqual(elementNode('p', {}, [textNode('0'), textNode('1')]))
  })

  it('null, undefined, 불리언 자식은 화면에 나오지 않는다', () => {
    expect(h('p', null, null, undefined, true, false, '가')).toEqual(elementNode('p', {}, [textNode('가')]))
  })

  it('중첩 배열을 펼친다', () => {
    expect(h('ul', null, [[h('li', null)], [h('li', null)]])).toMatchObject({ children: [{}, {}] })
  })

  it('key는 노드로 옮기고 props에서 뺀다', () => {
    expect(h('li', { key: 'a', title: '가' })).toEqual(elementNode('li', { title: '가' }, [], 'a'))
  })

  it('key 0도 유효하다', () => {
    expect(h('li', { key: 0 })).toMatchObject({ key: 0 })
  })
})

describe('h: props 정리', () => {
  it('className과 htmlFor를 실제 속성 이름으로 바꾼다', () => {
    expect(h('label', { className: 'a', htmlFor: 'b' })).toMatchObject({ props: { class: 'a', for: 'b' } })
  })

  it('style 객체를 문자열로 바꾸고 낙타 표기를 케밥 표기로 바꾼다', () => {
    expect(h('div', { style: { fontSize: '12px', '--gap': '4px', color: null } })).toMatchObject({
      props: { style: 'font-size: 12px; --gap: 4px' },
    })
  })

  it('style 문자열은 그대로 둔다', () => {
    expect(h('div', { style: 'color: red' })).toMatchObject({ props: { style: 'color: red' } })
  })

  it('false, null, undefined 속성은 뺀다', () => {
    expect(h('button', { disabled: false, title: null, id: undefined })).toEqual(elementNode('button'))
  })

  it('aria-와 data-의 false는 글자로 남긴다', () => {
    expect(h('button', { 'aria-pressed': false, 'data-open': false })).toMatchObject({
      props: { 'aria-pressed': 'false', 'data-open': 'false' },
    })
  })

  it('aria-와 data-의 true도 글자로 남긴다', () => {
    expect(h('button', { 'aria-pressed': true, 'data-open': true })).toMatchObject({
      props: { 'aria-pressed': 'true', 'data-open': 'true' },
    })
  })

  it('disabled 같은 일반 속성의 true는 그대로 둔다', () => {
    expect(h('button', { disabled: true })).toMatchObject({ props: { disabled: true } })
  })

  it('빈 문자열 value는 지우지 않는다', () => {
    expect(h('input', { value: '' })).toMatchObject({ props: { value: '' } })
  })
})

describe('h: 자식 컴포넌트', () => {
  const Label = ({ text }: { text: string }): VNode => h('b', null, text)

  it('함수를 실행해 결과 트리로 펼친다', () => {
    expect(h(Label, { text: '가' })).toEqual(h('b', null, '가'))
  })

  it('key를 결과 트리의 맨 위 노드로 옮기고 props로는 넘기지 않는다', () => {
    let received: object = {}
    const Row = (props: object): VNode => {
      received = props
      return h('li', null)
    }
    expect(h(Row, { key: 'a' })).toMatchObject({ key: 'a' })
    expect(received).not.toHaveProperty('key')
  })

  it('자식을 children으로 전달한다', () => {
    const Box = ({ children }: { children?: VNode[] }): VNode => h('section', null, children)
    expect(h(Box, {}, '가')).toEqual(elementNode('section', {}, [textNode('가')]))
  })

  it('null을 돌려주면 빈 글자 노드가 자리를 지킨다', () => {
    const Nothing = (): null => null
    expect(h(Nothing, {})).toEqual(textNode(''))
  })
})
