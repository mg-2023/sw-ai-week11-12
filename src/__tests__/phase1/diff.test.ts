import { describe, expect, it } from '../testing.mjs'
import { diff } from '../../phase1/diff.ts'
import { elementNode, textNode } from '../../phase1/types.ts'
import type { Patch, PatchType, VNode } from '../../phase1/types.ts'

const li = (text: string, key?: string) => elementNode('li', {}, [textNode(text)], key)
const list = (...children: VNode[]) => elementNode('ul', {}, children)
const types = (patches: Patch[]): PatchType[] => patches.map((patch) => patch.type)

describe('변경이 없을 때', () => {
  it('구조가 같으면 연산이 없다', () => {
    expect(diff(list(li('가'), li('나')), list(li('가'), li('나')))).toEqual([])
  })

  it('같은 객체면 내부를 보지 않고 끝낸다', () => {
    const shared = list(li('가'))
    expect(diff(shared, shared)).toEqual([])
  })

  it('입력 트리를 고치지 않는다', () => {
    const before = list(li('가', 'a'), li('나', 'b'))
    const after = list(li('나!', 'b'), li('다', 'c'))
    const snapshot = structuredClone({ before, after })
    diff(before, after)
    expect({ before, after }).toEqual(snapshot)
  })
})

describe('다섯 가지 기본 케이스', () => {
  it('1. 추가: 새 자식이 생기면 INSERT', () => {
    expect(diff(list(li('가')), list(li('가'), li('나')))).toEqual([
      { type: 'INSERT', path: [], index: 1, node: li('나') },
    ])
  })

  it('2. 삭제: 자식이 사라지면 REMOVE', () => {
    expect(diff(list(li('가'), li('나')), list(li('가')))).toEqual([
      { type: 'REMOVE', path: [], index: 1 },
    ])
  })

  it('3. 교체: 태그가 다르면 REPLACE', () => {
    const next = elementNode('section', {}, [textNode('가')])
    expect(diff(elementNode('div', {}, [textNode('가')]), next)).toEqual([
      { type: 'REPLACE', path: [], node: next },
    ])
  })

  it('3. 교체: 글자와 요소가 바뀌어도 REPLACE', () => {
    const next = elementNode('b', {}, [textNode('가')])
    expect(diff(textNode('가'), next)).toEqual([{ type: 'REPLACE', path: [], node: next }])
  })

  it('3. 교체: 자식 자리에서 태그가 바뀌면 그 자리만 REPLACE', () => {
    const next = elementNode('p', {}, [elementNode('em', {}, [textNode('가')])])
    const patches = diff(elementNode('p', {}, [elementNode('b', {}, [textNode('가')])]), next)
    expect(patches).toEqual([
      { type: 'REPLACE', path: [0], node: elementNode('em', {}, [textNode('가')]) },
    ])
  })

  it('4. 속성: 바뀐 값과 지운 이름만 담는다', () => {
    const before = elementNode('div', { id: 'a', title: 'b', class: 'c' })
    const after = elementNode('div', { id: 'a', title: 'x', lang: 'ko' })
    expect(diff(before, after)).toEqual([
      { type: 'PROPS', path: [], set: { title: 'x', lang: 'ko' }, remove: ['class'] },
    ])
  })

  it('5. 글자: 내용이 다르면 TEXT', () => {
    expect(diff(list(li('가')), list(li('나')))).toEqual([{ type: 'TEXT', path: [0, 0], text: '나' }])
  })
})

describe('key가 있는 목록', () => {
  it('맨 앞에 끼워도 기존 항목은 건드리지 않는다', () => {
    const patches = diff(list(li('가', 'a'), li('나', 'b')), list(li('새', 'n'), li('가', 'a'), li('나', 'b')))
    expect(patches).toEqual([{ type: 'INSERT', path: [], index: 0, node: li('새', 'n') }])
  })

  it('맨 앞 항목을 지워도 뒤 항목을 고치지 않는다', () => {
    const patches = diff(list(li('가', 'a'), li('나', 'b'), li('다', 'c')), list(li('나', 'b'), li('다', 'c')))
    expect(patches).toEqual([{ type: 'REMOVE', path: [], index: 0 }])
  })

  it('한 항목을 끝으로 옮기면 MOVE 하나로 끝난다', () => {
    const a = li('가', 'a')
    const b = li('나', 'b')
    const c = li('다', 'c')
    const d = li('라', 'd')
    expect(diff(list(a, b, c, d), list(b, c, d, a))).toEqual([{ type: 'MOVE', path: [], from: 0, to: 3 }])
  })

  it('끝 항목을 앞으로 옮겨도 MOVE 하나로 끝난다', () => {
    const items = ['a', 'b', 'c', 'd'].map((key) => li(key, key))
    const [a, b, c, d] = items
    expect(types(diff(list(a, b, c, d), list(d, a, b, c)))).toEqual(['MOVE'])
  })

  it('n개를 뒤집으면 움직일 수밖에 없는 n-1번만 MOVE 한다', () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((key) => li(key, key))
    expect(types(diff(list(...items), list(...items.toReversed())))).toEqual(['MOVE', 'MOVE', 'MOVE', 'MOVE'])
  })

  it('옮기면서 내용이 바뀌면 내부 연산이 옛 번호로 먼저 나온다', () => {
    const patches = diff(list(li('가', 'a'), li('나', 'b')), list(li('나!', 'b'), li('가', 'a')))
    expect(patches).toHaveLength(2)
    expect(patches[0]).toEqual({ type: 'TEXT', path: [1, 0], text: '나!' })
    // 둘 중 어느 쪽을 옮겨도 한 번이면 되므로 방향은 따지지 않습니다.
    expect(patches[1].type).toBe('MOVE')
  })

  it('key가 다르면 같은 자리여도 다른 노드로 본다', () => {
    expect(types(diff(list(li('가', 'a')), list(li('가', 'b'))))).toEqual(['REMOVE', 'INSERT'])
  })

  it('key가 같아도 태그가 다르면 다른 노드로 본다', () => {
    const next = elementNode('div', {}, [elementNode('p', {}, [], 'a')])
    expect(types(diff(elementNode('div', {}, [elementNode('li', {}, [], 'a')]), next))).toEqual([
      'REMOVE',
      'INSERT',
    ])
  })

  it('루트의 key가 바뀌면 내용이 같아도 교체한다', () => {
    const next = li('가', 'b')
    expect(diff(li('가', 'a'), next)).toEqual([{ type: 'REPLACE', path: [], node: next }])
  })

  it('숫자 key 1과 문자열 key "1"을 구분한다', () => {
    const before = elementNode('ul', {}, [elementNode('li', {}, [], 1)])
    const after = elementNode('ul', {}, [elementNode('li', {}, [], '1')])
    expect(types(diff(before, after))).toEqual(['REMOVE', 'INSERT'])
  })
})

describe('key가 없는 목록', () => {
  it('같은 태그끼리는 자리 순서로 비교한다', () => {
    const patches = diff(list(li('가'), li('나')), list(li('새'), li('가'), li('나')))
    expect(types(patches)).toEqual(['TEXT', 'TEXT', 'INSERT'])
  })

  it('태그가 다른 형제는 태그로 짝을 찾아 교체를 피한다', () => {
    const div = elementNode('div')
    const p = elementNode('p')
    const span = elementNode('span')
    expect(diff(elementNode('section', {}, [div, p, span]), elementNode('section', {}, [p, span]))).toEqual([
      { type: 'REMOVE', path: [], index: 0 },
    ])
  })

  it('글자 사이에 요소가 끼어들어도 글자를 다시 만들지 않는다', () => {
    const bold = elementNode('b')
    const patches = diff(elementNode('p', {}, [textNode('가')]), elementNode('p', {}, [bold, textNode('가')]))
    expect(patches).toEqual([{ type: 'INSERT', path: [], index: 0, node: bold }])
  })

  it('같은 자리의 다른 태그는 삭제와 추가 대신 교체 하나로 끝낸다', () => {
    const next = elementNode('section', {}, [elementNode('p')])
    expect(types(diff(elementNode('section', {}, [elementNode('div')]), next))).toEqual(['REPLACE'])
  })
})

describe('이벤트 핸들러', () => {
  const first = () => {}
  const second = () => {}

  it('핸들러 변경은 PROPS가 아닌 LISTENERS로 나온다', () => {
    expect(diff(elementNode('button', { onClick: first }), elementNode('button', { onClick: second }))).toEqual([
      { type: 'LISTENERS', path: [], set: { onClick: second }, remove: [] },
    ])
  })

  it('같은 함수면 연산이 없다', () => {
    expect(diff(elementNode('button', { onClick: first }), elementNode('button', { onClick: first }))).toEqual([])
  })

  it('핸들러가 사라지면 제거 연산이 나온다', () => {
    expect(diff(elementNode('button', { onClick: first }), elementNode('button'))).toEqual([
      { type: 'LISTENERS', path: [], set: {}, remove: ['onClick'] },
    ])
  })

  it('핸들러가 글자 속성으로 바뀌면 리스너도 함께 뗀다', () => {
    expect(types(diff(elementNode('a', { title: first }), elementNode('a', { title: '가' })))).toEqual([
      'PROPS',
      'LISTENERS',
    ])
  })
})

describe('엣지 케이스', () => {
  it('constructor 같은 속성 이름도 평범하게 비교한다', () => {
    const patches = diff(elementNode('div', { constructor: 'a' }), elementNode('div'))
    expect(patches).toEqual([{ type: 'PROPS', path: [], set: {}, remove: ['constructor'] }])
  })

  it('중복 key가 있어도 연산을 만들 수 있다', () => {
    expect(() => diff(list(li('가', 'a'), li('나', 'a')), list(li('나', 'a'), li('다', 'a'), li('라', 'a')))).not.toThrow()
  })

  it('모든 자식이 사라지면 뒤에서부터 지운다', () => {
    expect(diff(list(li('가'), li('나'), li('다')), list())).toEqual([
      { type: 'REMOVE', path: [], index: 2 },
      { type: 'REMOVE', path: [], index: 1 },
      { type: 'REMOVE', path: [], index: 0 },
    ])
  })
})
