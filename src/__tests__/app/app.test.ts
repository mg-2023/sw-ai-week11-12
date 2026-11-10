import { afterEach, beforeEach, describe, expect, it, vi } from '../testing.mjs'
import { startApp } from '../../app/app.ts'
import { THEME_KEY } from '../../app/theme.ts'

// jsdom에는 scrollTo가 없고, hash 이벤트가 테스트 뒤에 도착할 수 있어서 파일 전체에서 대체합니다.
const scrollTo = vi.fn()
window.scrollTo = scrollTo as unknown as typeof window.scrollTo

let root: HTMLElement

const labPage = () => root.querySelector('.lab') as HTMLElement
const boardPage = () => root.querySelector('.board-page') as HTMLElement

function goTo(hash: string): void {
  window.location.hash = hash
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

beforeEach(() => {
  localStorage.clear()
  window.location.hash = ''
  scrollTo.mockClear()
  root = document.createElement('div')
  document.body.append(root)
  startApp(root)
})

afterEach(() => {
  root.remove()
})

describe('테마', () => {
  const button = () => root.querySelector('[data-role="theme"]') as HTMLButtonElement

  it('누르면 테마가 바뀌고 버튼 글자가 다음 테마를 가리킨다', () => {
    const first = document.documentElement.dataset.theme
    button().click()

    expect(document.documentElement.dataset.theme).not.toBe(first)
    button().click()
    expect(document.documentElement.dataset.theme).toBe(first)
  })

  it('고른 테마를 저장하고 다시 열면 불러온다', () => {
    localStorage.setItem(THEME_KEY, 'light')
    root.replaceChildren()
    startApp(root)
    button().click()

    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
    expect(button().textContent).toBe('라이트 모드')

    root.replaceChildren()
    startApp(root)
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('저장값이 이상하면 무시한다', () => {
    localStorage.setItem(THEME_KEY, 'purple')
    root.replaceChildren()
    startApp(root)
    expect(['light', 'dark']).toContain(document.documentElement.dataset.theme)
  })
})

describe('startApp', () => {
  it('처음에는 실험실만 보인다', () => {
    expect(labPage().hidden).toBe(false)
    expect(boardPage().hidden).toBe(true)
    expect(root.querySelector('[aria-current="page"]')?.textContent).toBe('Diff 실험실')
  })

  it('주소의 # 값이 바뀌면 페이지가 바뀌고 맨 위로 간다', () => {
    goTo('#board')
    expect(labPage().hidden).toBe(true)
    expect(boardPage().hidden).toBe(false)
    expect(root.querySelector('[aria-current="page"]')?.textContent).toBe('집중 보드')
    expect(scrollTo).toHaveBeenCalledWith(0, 0)
  })

  it('알 수 없는 # 값이면 실험실을 보여 준다', () => {
    goTo('#없는-페이지')
    expect(labPage().hidden).toBe(false)
  })

  it('페이지를 오가도 각 페이지의 상태가 유지된다', () => {
    const code = root.querySelector('[data-role="code"]') as HTMLTextAreaElement
    code.value = '<p>작성 중</p>'
    goTo('#board')
    goTo('#lab')
    expect(code.value).toBe('<p>작성 중</p>')
  })
})
