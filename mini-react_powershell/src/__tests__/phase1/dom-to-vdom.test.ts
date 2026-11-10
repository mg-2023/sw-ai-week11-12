import { describe, expect, it } from '../testing.mjs'
import { childrenToVdom, domToVdom, htmlToVdom } from '../../phase1/dom-to-vdom.ts'
import { elementNode, textNode } from '../../phase1/types.ts'

function parseElement(html: string): Element {
  const template = document.createElement('template')
  template.innerHTML = html
  const element = template.content.firstElementChild
  if (!element) throw new Error('테스트 HTML에 요소가 없습니다.')
  return element
}

describe('domToVdom', () => {
  it('요소와 속성, 자식 글자를 트리로 바꾼다', () => {
    expect(domToVdom(parseElement('<p class="note" title="안내">안녕</p>'))).toEqual(
      elementNode('p', { class: 'note', title: '안내' }, [textNode('안녕')]),
    )
  })

  it('중첩된 구조를 그대로 옮긴다', () => {
    expect(domToVdom(parseElement('<ul><li>하나</li><li><b>둘</b></li></ul>'))).toEqual(
      elementNode('ul', {}, [
        elementNode('li', {}, [textNode('하나')]),
        elementNode('li', {}, [elementNode('b', {}, [textNode('둘')])]),
      ]),
    )
  })

  it('주석처럼 화면에 없는 노드는 null을 돌려준다', () => {
    expect(domToVdom(document.createComment('메모'))).toBeNull()
  })

  it('data-key를 key로 읽고 속성으로도 남긴다', () => {
    expect(domToVdom(parseElement('<li data-key="a">가</li>'))).toEqual(
      elementNode('li', { 'data-key': 'a' }, [textNode('가')], 'a'),
    )
  })

  it('SVG 태그의 대소문자를 유지한다', () => {
    const vnode = domToVdom(parseElement('<svg viewBox="0 0 1 1"><linearGradient></linearGradient></svg>'))
    expect(vnode).toMatchObject({
      tag: 'svg',
      props: { viewBox: '0 0 1 1' },
      children: [{ tag: 'linearGradient' }],
    })
  })
})

describe('공백 처리', () => {
  it('들여쓰기용 공백 노드는 버린다', () => {
    const vnode = domToVdom(parseElement('<div>\n  <p>가</p>\n  <p>나</p>\n</div>'))
    expect(vnode).toMatchObject({ children: [{ tag: 'p' }, { tag: 'p' }] })
  })

  it('한 줄 안의 공백은 내용이므로 남긴다', () => {
    const vnode = domToVdom(parseElement('<p><b>가</b> <i>나</i></p>'))
    expect(vnode).toMatchObject({ children: [{ tag: 'b' }, { text: ' ' }, { tag: 'i' }] })
  })

  it('&nbsp;만 있는 글자는 줄바꿈이 있어도 버리지 않는다', () => {
    const vnode = domToVdom(parseElement('<p> \n</p>'))
    expect(vnode).toMatchObject({ children: [{ text: ' \n' }] })
  })

  it('pre 안의 공백은 후손까지 모두 지킨다', () => {
    const vnode = domToVdom(parseElement('<pre><code>\n  a\n</code>\n</pre>'))
    expect(vnode).toMatchObject({
      children: [{ tag: 'code', children: [{ text: '\n  a\n' }] }, { text: '\n' }],
    })
  })

  it('이어진 글자 노드는 하나로 합치고 빈 글자는 버린다', () => {
    const parent = document.createElement('p')
    parent.append('가', '', '나', document.createComment('메모'), '다')
    expect(childrenToVdom(parent)).toEqual([textNode('가나다')])
  })
})

describe('사용자 입력 방어', () => {
  it('script 태그를 버린다', () => {
    expect(htmlToVdom('<script>alert(1)</script><p>가</p>')).toEqual([
      elementNode('p', {}, [textNode('가')]),
    ])
  })

  it('on으로 시작하는 속성을 버린다', () => {
    expect(htmlToVdom('<img src="a.png" onerror="alert(1)" ONCLICK="alert(2)">')).toEqual([
      elementNode('img', { src: 'a.png' }),
    ])
  })

  it('javascript: 주소를 대소문자와 제어 문자가 섞여도 버린다', () => {
    expect(htmlToVdom('<a href=" JaVa\tScript:alert(1)">가</a>')).toEqual([
      elementNode('a', {}, [textNode('가')]),
    ])
  })

  it('setAttribute가 거부할 이름의 속성을 버린다', () => {
    expect(htmlToVdom('<div @click="a" 1a="b" title="c"></div>')).toEqual([
      elementNode('div', { title: 'c' }),
    ])
  })
})

describe('htmlToVdom', () => {
  it('최상위 노드가 여러 개여도 모두 읽는다', () => {
    expect(htmlToVdom('<p>가</p>글자<p>나</p>')).toHaveLength(3)
  })

  it('빈 문자열은 빈 목록이다', () => {
    expect(htmlToVdom('')).toEqual([])
  })

  it('template 덕분에 tr 같은 문맥 의존 태그도 보존한다', () => {
    expect(htmlToVdom('<tr><td>가</td></tr>')).toMatchObject([{ tag: 'tr' }])
  })

  it('브라우저가 고친 구조를 그대로 읽는다', () => {
    expect(htmlToVdom('<table><tr><td>가</td></tr></table>')).toMatchObject([
      { tag: 'table', children: [{ tag: 'tbody' }] },
    ])
  })
})
