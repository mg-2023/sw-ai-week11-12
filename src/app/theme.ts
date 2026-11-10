import { createDom } from '../phase1/patch.ts'
import { h } from '../phase2/h.ts'

type Theme = 'light' | 'dark'

export const THEME_KEY = 'mini-react:theme'

function savedTheme(): Theme | null {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    return saved === 'light' || saved === 'dark' ? saved : null
  } catch {
    return null
  }
}

function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // 저장이 막혀도 지금 화면의 테마는 바뀝니다.
  }
}

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** 고른 테마를 html의 data-theme에 적습니다. 색은 main.css의 토큰이 이 값을 보고 바꿉니다. */
export function createThemeToggle(): HTMLElement {
  const root = document.documentElement
  let theme = savedTheme() ?? systemTheme()

  const button = createDom(
    h('button', {
      type: 'button',
      class: 'quiet-button',
      'data-role': 'theme',
      onClick() {
        theme = theme === 'dark' ? 'light' : 'dark'
        saveTheme(theme)
        render()
      },
    }),
  ) as HTMLElement

  function render(): void {
    root.dataset.theme = theme
    button.textContent = theme === 'dark' ? '라이트 모드' : '다크 모드'
  }

  render()
  return button
}
