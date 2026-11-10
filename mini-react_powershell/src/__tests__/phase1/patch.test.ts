import { describe, expect, it, vi } from '../testing.mjs'
import { diff } from '../../phase1/diff.ts'
import { applyPatches, createDom } from '../../phase1/patch.ts'
import { elementNode, textNode } from '../../phase1/types.ts'
import type { Key, Patch, VNode } from '../../phase1/types.ts'

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'

function html(node: Node): string {
  const host = document.createElement('div')
  host.append(node.cloneNode(true))
  return host.innerHTML
}

/** 옛 트리에서 시작해 패치한 결과와, 새 트리를 처음부터 만든 결과가 같아야 합니다. */
function expectPatchedEqualsFresh(before: VNode, after: VNode): void {
  const host = document.createElement('div')
  const dom = createDom(before)
  host.append(dom)

  const patched = applyPatches(dom, diff(before, after))
  const fresh = createDom(after)

  if (!patched.isEqualNode(fresh)) {
    throw new Error(`결과가 다릅니다.\n패치: ${html(patched)}\n새로: ${html(fresh)}`)
  }
}

describe('createDom', () => {
  it('글자 노드를 만든다', () => {
    expect(createDom(textNode('가')).nodeValue).toBe('가')
  })

  it('요소와 속성, 자식을 만든다', () => {
    const dom = createDom(elementNode('p', { class: 'a' }, [textNode('가')]))
    expect(html(dom)).toBe('<p class="a">가</p>')
  })

  it('true는 값 없는 속성, false는 속성 없음이다', () => {
    const dom = createDom(elementNode('button', { disabled: true, hidden: false })) as HTMLButtonElement
    expect(dom.disabled).toBe(true)
    expect(dom.hasAttribute('hidden')).toBe(false)
  })

  it('SVG 안의 요소는 SVG 네임스페이스로 만든다', () => {
    const dom = createDom(elementNode('svg', { viewBox: '0 0 1 1' }, [elementNode('circle')])) as Element
    expect(dom.namespaceURI).toBe(SVG_NAMESPACE)
    expect(dom.firstElementChild?.namespaceURI).toBe(SVG_NAMESPACE)
    expect(dom.getAttribute('viewBox')).toBe('0 0 1 1')
  })

  it('foreignObject 안쪽은 다시 HTML로 만든다', () => {
    const dom = createDom(
      elementNode('svg', {}, [elementNode('foreignObject', {}, [elementNode('div')])]),
    ) as Element
    expect(dom.querySelector('div')?.namespaceURI).toBe(HTML_NAMESPACE)
  })

  it('select의 value는 option을 붙인 뒤에 적용된다', () => {
    const dom = createDom(
      elementNode('select', { value: 'b' }, [
        elementNode('option', { value: 'a' }),
        elementNode('option', { value: 'b' }),
      ]),
    ) as HTMLSelectElement
    expect(dom.value).toBe('b')
  })
})

describe('applyPatches', () => {
  it('글자만 바꾸면 요소를 다시 만들지 않는다', () => {
    const before = elementNode('p', {}, [textNode('가')])
    const dom = createDom(before)
    const textDom = dom.firstChild
    applyPatches(dom, diff(before, elementNode('p', {}, [textNode('나')])))
    expect(dom.firstChild).toBe(textDom)
    expect(dom.textContent).toBe('나')
  })

  it('속성을 설정하고 제거한다', () => {
    const before = elementNode('div', { id: 'a', title: 'b' })
    const dom = createDom(before) as Element
    applyPatches(dom, diff(before, elementNode('div', { id: 'x' })))
    expect(dom.getAttribute('id')).toBe('x')
    expect(dom.hasAttribute('title')).toBe(false)
  })

  it('요소를 교체한다', () => {
    const before = elementNode('div', {}, [elementNode('b', {}, [textNode('가')])])
    const dom = createDom(before)
    applyPatches(dom, diff(before, elementNode('div', {}, [elementNode('i', {}, [textNode('가')])])))
    expect(html(dom)).toBe('<div><i>가</i></div>')
  })

  it('루트가 교체되면 새 루트를 돌려주고 부모에도 반영한다', () => {
    const host = document.createElement('div')
    const before = elementNode('b')
    const dom = createDom(before)
    host.append(dom)

    const next = applyPatches(dom, diff(before, elementNode('i')))
    expect(next).toBe(host.firstChild)
    expect(host.innerHTML).toBe('<i></i>')
  })

  it('MOVE는 같은 DOM 노드를 재사용한다', () => {
    const item = (key: string) => elementNode('li', {}, [textNode(key)], key)
    const before = elementNode('ul', {}, [item('a'), item('b'), item('c')])
    const dom = createDom(before)
    const [first, second, third] = Array.from(dom.childNodes)

    applyPatches(dom, diff(before, elementNode('ul', {}, [item('c'), item('a'), item('b')])))
    expect(Array.from(dom.childNodes)).toEqual([third, first, second])
  })

  it('옮겨진 input은 사용자가 입력한 값을 잃지 않는다', () => {
    const field = (key: string) => elementNode('input', {}, [], key)
    const before = elementNode('form', {}, [field('a'), field('b')])
    const dom = createDom(before) as Element
    const input = dom.firstChild as HTMLInputElement
    input.value = '입력값'

    applyPatches(dom, diff(before, elementNode('form', {}, [field('b'), field('a')])))
    expect(dom.lastChild).toBe(input)
    expect(input.value).toBe('입력값')
  })

  it('SVG 안에 추가한 노드도 SVG 네임스페이스다', () => {
    const before = elementNode('svg')
    const dom = createDom(before) as Element
    applyPatches(dom, diff(before, elementNode('svg', {}, [elementNode('circle')])))
    expect(dom.firstElementChild?.namespaceURI).toBe(SVG_NAMESPACE)
  })

  it('연산마다 건드린 노드를 알려 준다', () => {
    const before = elementNode('p', {}, [textNode('가')])
    const dom = createDom(before)
    const onApply = vi.fn()
    applyPatches(dom, diff(before, elementNode('p', {}, [textNode('나')])), onApply)
    expect(onApply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'TEXT' }), dom.firstChild)
  })

  it('DOM과 맞지 않는 경로는 조용히 넘기지 않고 오류를 낸다', () => {
    const patch: Patch = { type: 'TEXT', path: [3], text: '가' }
    expect(() => applyPatches(document.createElement('div'), [patch])).toThrow('[3]')
  })
})

describe('폼 요소의 현재 값', () => {
  it('사용자가 입력한 뒤에도 value가 바뀐다', () => {
    const before = elementNode('input', { value: '가' })
    const dom = createDom(before) as HTMLInputElement
    dom.value = '사용자 입력'
    applyPatches(dom, diff(before, elementNode('input', { value: '나' })))
    expect(dom.value).toBe('나')
  })

  it('value를 지우면 빈 값이 된다', () => {
    const before = elementNode('input', { value: '가' })
    const dom = createDom(before) as HTMLInputElement
    applyPatches(dom, diff(before, elementNode('input')))
    expect(dom.value).toBe('')
  })

  it('checked를 켜고 끈다', () => {
    const before = elementNode('input', { type: 'checkbox', checked: true })
    const dom = createDom(before) as HTMLInputElement
    expect(dom.checked).toBe(true)
    applyPatches(dom, diff(before, elementNode('input', { type: 'checkbox' })))
    expect(dom.checked).toBe(false)
  })

  it('값이 같으면 다시 넣지 않아 커서가 유지된다', () => {
    const before = elementNode('input', { value: '가나다', title: 'a' })
    const dom = createDom(before) as HTMLInputElement
    dom.setSelectionRange(1, 1)
    applyPatches(dom, [{ type: 'PROPS', path: [], set: { value: '가나다' }, remove: [] }])
    expect(dom.selectionStart).toBe(1)
  })

  it('파일 입력의 value는 건드리지 않아 오류가 나지 않는다', () => {
    expect(() => createDom(elementNode('input', { type: 'file', value: 'a.txt' }))).not.toThrow()
  })
})

describe('이벤트 핸들러', () => {
  it('핸들러를 교체해도 addEventListener는 한 번만 부른다', () => {
    const first = vi.fn()
    const second = vi.fn()
    const before = elementNode('button', { onClick: first })
    const dom = createDom(before) as HTMLButtonElement
    const addEventListener = vi.spyOn(dom, 'addEventListener')

    applyPatches(dom, diff(before, elementNode('button', { onClick: second })))
    dom.click()

    expect(addEventListener).not.toHaveBeenCalled()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
  })

  it('핸들러를 제거하면 더 이상 불리지 않는다', () => {
    const handler = vi.fn()
    const before = elementNode('button', { onClick: handler })
    const dom = createDom(before) as HTMLButtonElement
    applyPatches(dom, diff(before, elementNode('button')))
    dom.click()
    expect(handler).not.toHaveBeenCalled()
  })

  it('onKeyDown 같은 이름을 소문자 이벤트로 연결한다', () => {
    const handler = vi.fn()
    const dom = createDom(elementNode('input', { onKeyDown: handler }))
    dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    expect(handler).toHaveBeenCalledOnce()
  })
})

/** 시드가 같으면 같은 순서를 내는 난수입니다. 실패를 그대로 재현할 수 있습니다. */
function createRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

const TAGS = ['div', 'p', 'span', 'li']
const WORDS = ['가', '나', '다', '라', '']
const KEYS = ['a', 'b', 'c', 'd', 'e', 'f', 'g']

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]
}

function randomProps(random: () => number) {
  const props: Record<string, string> = {}
  if (random() < 0.4) props.class = pick(random, WORDS)
  if (random() < 0.3) props.title = pick(random, WORDS)
  return props
}

function randomChildren(random: () => number, depth: number, allowDuplicateKeys: boolean): VNode[] {
  const count = Math.floor(random() * 6)
  const unusedKeys = [...KEYS]
  const useKeys = random() < 0.5

  return Array.from({ length: count }, () => {
    if (random() < 0.3) return textNode(pick(random, WORDS))

    let key: Key | undefined
    if (useKeys && random() < 0.85) {
      key = allowDuplicateKeys
        ? pick(random, KEYS)
        : unusedKeys.splice(Math.floor(random() * unusedKeys.length), 1)[0]
    }

    const children = depth > 0 ? randomChildren(random, depth - 1, allowDuplicateKeys) : []
    return elementNode(pick(random, TAGS), randomProps(random), children, key)
  })
}

function randomTree(random: () => number, allowDuplicateKeys = false): VNode {
  return elementNode('div', {}, randomChildren(random, 3, allowDuplicateKeys))
}

describe('무작위 트리 대조', () => {
  it('고유 key가 섞인 트리 1000쌍을 패치한 결과가 새로 만든 DOM과 같다', () => {
    const random = createRandom(20261106)
    for (let round = 0; round < 1000; round += 1) {
      expectPatchedEqualsFresh(randomTree(random), randomTree(random))
    }
  })

  it('중복 key가 섞인 트리 500쌍도 결과가 틀어지지 않는다', () => {
    const random = createRandom(7)
    for (let round = 0; round < 500; round += 1) {
      expectPatchedEqualsFresh(randomTree(random, true), randomTree(random, true))
    }
  })

  it('패치 뒤 다시 Diff하면 남은 연산이 없다', () => {
    const random = createRandom(99)
    for (let round = 0; round < 200; round += 1) {
      const after = randomTree(random)
      expect(diff(after, structuredClone(after))).toEqual([])
    }
  })

  it('큰 목록을 섞어도 맞고, LIS 덕분에 MOVE가 전체보다 적다', () => {
    const random = createRandom(3)
    const items = Array.from({ length: 300 }, (_, index) =>
      elementNode('li', {}, [textNode(String(index))], index),
    )
    const shuffled = [...items]
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1))
      ;[shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]]
    }

    const before = elementNode('ul', {}, items)
    const after = elementNode('ul', {}, shuffled)
    expectPatchedEqualsFresh(before, after)
    expect(diff(before, after).length).toBeLessThan(items.length)
  })
})
