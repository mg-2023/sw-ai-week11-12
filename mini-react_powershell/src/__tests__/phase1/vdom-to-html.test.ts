import { describe, expect, it } from '../testing.mjs'
import { diff } from '../../phase1/diff.ts'
import { htmlToVdom } from '../../phase1/dom-to-vdom.ts'
import { elementNode, textNode } from '../../phase1/types.ts'
import { vdomToHtml } from '../../phase1/vdom-to-html.ts'

describe('vdomToHtml', () => {
  it('자식이 전부 요소면 줄을 나누고 들여쓴다', () => {
    const tree = elementNode('ul', {}, [
      elementNode('li', {}, [textNode('가')]),
      elementNode('li', {}, [textNode('나')]),
    ])
    expect(vdomToHtml([tree])).toBe('<ul>\n  <li>가</li>\n  <li>나</li>\n</ul>')
  })

  it('글자가 섞이면 공백을 만들지 않으려고 한 줄로 쓴다', () => {
    const tree = elementNode('p', {}, [textNode('가 '), elementNode('b', {}, [textNode('나')])])
    expect(vdomToHtml([tree])).toBe('<p>가 <b>나</b></p>')
  })

  it('닫는 태그가 없는 요소를 구분한다', () => {
    expect(vdomToHtml([elementNode('img', { src: 'a.png' })])).toBe('<img src="a.png">')
  })

  it('글자와 속성의 특수 문자를 이스케이프한다', () => {
    const tree = elementNode('p', { title: 'a"b&c' }, [textNode('<x> & y')])
    expect(vdomToHtml([tree])).toBe('<p title="a&quot;b&amp;c">&lt;x&gt; &amp; y</p>')
  })

  it('style 안의 글자는 이스케이프하지 않는다', () => {
    const tree = elementNode('style', {}, [textNode('a > b { color: red }')])
    expect(vdomToHtml([tree])).toBe('<style>a > b { color: red }</style>')
  })

  it('값이 없는 속성은 이름만 쓰고 함수는 뺀다', () => {
    const tree = elementNode('input', { disabled: '', checked: true, hidden: false, onClick: () => {} })
    expect(vdomToHtml([tree])).toBe('<input disabled checked>')
  })
})

describe('왕복 안정성: 코드로 바꿨다가 다시 읽어도 트리가 같다', () => {
  const samples: [string, string][] = [
    ['일반 구조', '<article class="a"><h2>제목</h2><p>본문 <strong>강조</strong> 끝</p></article>'],
    ['공백이 든 인라인', '<p><b>가</b> <i>나</i></p>'],
    ['목록과 key', '<ul><li data-key="a">가</li><li data-key="b">나</li></ul>'],
    ['표', '<table><thead><tr><th>가</th></tr></thead><tbody><tr><td>나</td></tr></tbody></table>'],
    ['폼', '<form><label for="a">이름</label><input id="a" value="값" disabled></form>'],
    ['SVG', '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"></circle></svg>'],
    ['pre', '<pre>\n\n  들여쓴 글\n</pre>'],
    ['pre 안의 요소', '<pre><code>a</code><code>b</code></pre>'],
    ['textarea', '<textarea>\n가\n</textarea>'],
    ['특수 문자', '<p title="&quot;&amp;">&lt;b&gt; &amp; &nbsp;</p>'],
    ['style', '<style>a > b { color: red }</style>'],
    ['최상위 글자', '글자<p>가</p>글자'],
    ['빈 요소', '<div></div><p></p>'],
  ]

  it.each(samples)('%s', (_name, html) => {
    const first = htmlToVdom(html)
    const second = htmlToVdom(vdomToHtml(first))
    expect(second).toEqual(first)

    // 실험실의 진짜 조건입니다. 고치지 않고 Patch를 누르면 연산이 없어야 합니다.
    expect(diff(elementNode('div', {}, first), elementNode('div', {}, second))).toEqual([])
  })
})
