import { afterEach, beforeEach, describe, expect, it, vi } from '../testing.mjs'
import { createLabPage } from '../../app/lab-page.ts'

let page: HTMLElement

const find = <T extends Element = HTMLElement>(role: string) =>
  page.querySelector(`[data-role="${role}"]`) as unknown as T
const real = () => find('real')
const code = () => find<HTMLTextAreaElement>('code')
const visual = () => find('visual')
const click = (role: string) => find<HTMLButtonElement>(role).click()
const status = () => find('status').textContent
const number = (role: string) => Number(find(role).textContent)

function clickButton(label: string): void {
  const button = Array.from(page.querySelectorAll('button')).find((item) => item.textContent === label)
  if (!button) throw new Error(`${label} 버튼이 없습니다.`)
  button.click()
}

beforeEach(() => {
  page = createLabPage()
  document.body.append(page)
})

afterEach(() => {
  page.remove()
  vi.restoreAllMocks()
})

describe('페이지를 처음 열면', () => {
  it('실제 영역에 샘플이 있고 테스트 영역 코드가 같은 내용을 보여 준다', () => {
    expect(real().querySelector('h2')?.textContent).toBe('이번 주 스터디')
    expect(code().value).toContain('<h2>이번 주 스터디</h2>')
    expect(visual().querySelector('h2')?.textContent).toBe('이번 주 스터디')
  })

  it('실제 영역에 들여쓰기 공백 노드가 남아 있지 않다', () => {
    const card = real().querySelector('article') as Element
    expect(card.childNodes).toHaveLength(card.children.length)
  })

  it('처음에는 뒤로가기와 앞으로가기가 꺼져 있다', () => {
    expect(find<HTMLButtonElement>('back').disabled).toBe(true)
    expect(find<HTMLButtonElement>('forward').disabled).toBe(true)
  })

  it('아무것도 고치지 않고 Patch를 누르면 변화가 없다', () => {
    click('patch')
    expect(number('patch-count')).toBe(0)
    expect(number('mutation-count')).toBe(0)
    expect(status()).toContain('바뀐 곳이 없어서')
    expect(find<HTMLButtonElement>('back').disabled).toBe(true)
  })

  it('참가 신청은 실제 영역에만 있고 테스트 영역에는 없다', () => {
    expect(page.querySelector('.area-real .sample-button')).not.toBeNull()
    expect(code().value).not.toContain('참가 신청')
    expect(visual().textContent).not.toContain('참가 신청')
  })

  it('Patch를 눌러도 참가 신청은 그대로 남는다', () => {
    const button = page.querySelector('.area-real .sample-button')
    code().value = '<p>전부 바꿈</p>'
    click('patch')
    expect(page.querySelector('.area-real .sample-button')).toBe(button)
  })

  it('샘플의 참가 신청은 눌러도 아무 일도 일어나지 않는다', () => {
    const html = real().innerHTML
    const message = status()

    page.querySelector<HTMLButtonElement>('.area-real .sample-button')?.click()

    expect(real().innerHTML).toBe(html)
    expect(status()).toBe(message)
    expect(page.querySelectorAll('.timeline-step')).toHaveLength(1)
  })
})

describe('Patch', () => {
  it('고친 곳만 실제 영역에 반영한다', () => {
    const title = real().querySelector('h2')
    const list = real().querySelector('ul')

    code().value = code().value.replace('이번 주 스터디', '다음 주 스터디')
    click('patch')

    expect(real().querySelector('h2')).toBe(title)
    expect(real().querySelector('ul')).toBe(list)
    expect(title?.textContent).toBe('다음 주 스터디')
  })

  it('연산 개수와 MutationObserver가 본 변경 수가 같다', () => {
    code().value = code().value.replace('이번 주 스터디', '다음 주 스터디')
    click('patch')

    expect(number('patch-count')).toBe(1)
    expect(number('mutation-count')).toBe(1)
    expect(page.querySelectorAll('.op-row')).toHaveLength(1)
  })

  it('노드 지도의 칸 수가 실제 노드 수와 같고 바뀐 칸에 색이 있다', () => {
    code().value = code().value.replace('이번 주 스터디', '다음 주 스터디')
    click('patch')

    expect(page.querySelectorAll('.cell')).toHaveLength(number('node-count'))
    expect(page.querySelectorAll('.cell-text')).toHaveLength(1)
  })

  it('key가 있는 항목의 순서를 바꾸면 같은 li가 이동한다', () => {
    const first = real().querySelector('li')
    clickButton('순서 뒤집기')
    click('patch')

    expect(real().querySelector('li:last-child')).toBe(first)
    expect(page.querySelector('.op-move')).not.toBeNull()
  })

  it('Ctrl+Enter로도 Patch가 된다', () => {
    code().value = '<p>단축키</p>'
    code().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, cancelable: true }))
    expect(real().textContent).toBe('단축키')
  })

  it('실제 영역보다 긴 내용도 거절하지 않는다', () => {
    code().value = '<p>줄</p>'.repeat(200)
    click('patch')

    expect(real().querySelectorAll('p')).toHaveLength(200)
    expect(page.querySelectorAll('.timeline-step')).toHaveLength(2)
  })

  it('줄이 꺾이지 않는 수식도 MathML로 반영하고 되돌릴 수 있다', () => {
    const before = real().innerHTML
    code().value = '<math display="block"><mfrac><mn>1</mn><mn>2</mn></mfrac></math>'
    click('patch')

    expect(real().querySelector('mfrac')?.namespaceURI).toBe('http://www.w3.org/1998/Math/MathML')

    click('back')
    expect(real().innerHTML).toBe(before)
  })

  it('최상위 태그가 여러 개여도 된다', () => {
    code().value = '<p>가</p><p>나</p>글자'
    click('patch')
    expect(real().innerHTML).toBe('<p>가</p><p>나</p>글자')
  })

  it('내용을 전부 지워도 되고 되돌릴 수 있다', () => {
    const before = real().innerHTML
    code().value = ''
    click('patch')
    expect(real().innerHTML).toBe('')

    click('back')
    expect(real().innerHTML).toBe(before)
  })

  it('닫히지 않은 태그는 브라우저가 고친 구조로 반영한다', () => {
    code().value = '<div><p>가'
    click('patch')
    expect(real().innerHTML).toBe('<div><p>가</p></div>')
  })

  it('입력한 script와 onerror는 실행되지 않고 실제 영역에 들어가지 않는다', () => {
    code().value = '<script>window.hacked = true</script><img src="x" onerror="window.hacked = true"><p>가</p>'
    click('patch')

    expect(real().querySelector('script')).toBeNull()
    expect(real().querySelector('img')?.hasAttribute('onerror')).toBe(false)
    expect((window as unknown as { hacked?: boolean }).hacked).toBeUndefined()
  })

  it('표와 SVG, 폼 요소를 섞어도 반영된다', () => {
    code().value =
      '<table><tr><td>가</td></tr></table><svg viewBox="0 0 2 2"><circle r="1"></circle></svg><input value="값" disabled>'
    click('patch')

    expect(real().querySelector('tbody')).not.toBeNull()
    expect(real().querySelector('circle')?.namespaceURI).toBe('http://www.w3.org/2000/svg')
    expect(real().querySelector('input')?.value).toBe('값')
  })

  it('실제 영역의 링크를 눌러도 페이지를 떠나지 않는다', () => {
    code().value = '<a href="#elsewhere">이동</a>'
    click('patch')

    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    real().querySelector('a')?.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })
})

describe('뒤로가기와 앞으로가기', () => {
  it('실제 영역과 테스트 영역의 코드, 화면이 함께 바뀐다', () => {
    const original = code().value
    code().value = original.replace('이번 주', '다음 주')
    click('patch')

    click('back')
    expect(real().querySelector('h2')?.textContent).toBe('이번 주 스터디')
    expect(code().value).toBe(original)
    expect(visual().querySelector('h2')?.textContent).toBe('이번 주 스터디')

    click('forward')
    expect(real().querySelector('h2')?.textContent).toBe('다음 주 스터디')
    expect(code().value).toContain('다음 주 스터디')
  })

  it('버튼 상태와 버전 표시가 위치를 따라간다', () => {
    code().value = '<p>가</p>'
    click('patch')
    expect(find<HTMLButtonElement>('back').disabled).toBe(false)
    expect(page.querySelectorAll('.timeline-step')).toHaveLength(2)

    click('back')
    expect(find<HTMLButtonElement>('back').disabled).toBe(true)
    expect(find<HTMLButtonElement>('forward').disabled).toBe(false)
    expect(page.querySelector('[aria-current="step"]')?.textContent).toBe('v1')
  })

  it('버전은 30개까지만 남는다', () => {
    for (let count = 0; count < 35; count += 1) {
      code().value = `<p>${count}</p>`
      click('patch')
    }
    expect(page.querySelectorAll('.timeline-step')).toHaveLength(30)
  })

  it('버전 버튼으로 원하는 시점에 바로 간다', () => {
    code().value = '<p>둘째</p>'
    click('patch')
    code().value = '<p>셋째</p>'
    click('patch')

    const steps = page.querySelectorAll<HTMLButtonElement>('.timeline-step')
    steps[1].click()
    expect(real().textContent).toBe('둘째')
  })

  it('되돌린 뒤 아무것도 안 고치고 Patch를 누르면 변화가 없다', () => {
    code().value = '<p>가</p>'
    click('patch')
    click('back')
    click('patch')
    expect(number('patch-count')).toBe(0)
  })
})

describe('화면에서 고치기', () => {
  it('화면 편집 내용을 Patch로 반영한다', () => {
    clickButton('화면에서 고치기')
    ;(visual().querySelector('h2') as Element).textContent = '화면에서 고친 제목'
    click('patch')
    expect(real().querySelector('h2')?.textContent).toBe('화면에서 고친 제목')
  })

  it('코드에서 고친 내용이 화면 편집으로 넘어오고 반대도 같다', () => {
    code().value = '<p>코드에서 씀</p>'
    clickButton('화면에서 고치기')
    expect(visual().textContent).toBe('코드에서 씀')

    ;(visual().querySelector('p') as Element).textContent = '화면에서 씀'
    clickButton('HTML 코드')
    expect(code().value).toBe('<p>화면에서 씀</p>')
  })

  it('고른 편집 방식만 보인다', () => {
    clickButton('화면에서 고치기')
    expect(code().hidden).toBe(true)
    expect(visual().hidden).toBe(false)
  })
})

describe('예시 수정 버튼', () => {
  it.each([
    ['글자 바꾸기', '.op-text'],
    ['속성 바꾸기', '.op-props'],
    ['노드 추가', '.op-insert'],
    ['노드 삭제', '.op-remove'],
    ['태그 교체', '.op-replace'],
    ['순서 뒤집기', '.op-move'],
  ])('%s는 해당 연산을 만든다', (label, badge) => {
    clickButton(label)
    click('patch')
    expect(page.querySelector(badge)).not.toBeNull()
  })

  it('누르기만 하면 실제 영역은 아직 그대로다', () => {
    const before = real().innerHTML
    clickButton('글자 바꾸기')
    expect(real().innerHTML).toBe(before)
  })

  it('대상이 없으면 이유를 알려 주고 코드를 망가뜨리지 않는다', () => {
    code().value = '<p>목록 없음</p>'
    clickButton('노드 삭제')
    expect(status()).toContain('노드 삭제')
    expect(code().value).toBe('<p>목록 없음</p>')
  })
})
