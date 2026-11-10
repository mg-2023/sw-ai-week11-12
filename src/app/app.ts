import { createDom } from '../phase1/patch.ts'
import { h } from '../phase2/h.ts'
import { createLabPage } from './lab-page.ts'
import { createTestPage } from './test-page.ts'
import { createThemeToggle } from './theme.ts'

type PageId = 'lab' | 'board'

const NAV_ITEMS: { id: PageId; label: string }[] = [
  { id: 'lab', label: 'Diff 실험실' },
  { id: 'board', label: '집중 보드' },
]

function pageFromHash(): PageId {
  return window.location.hash === '#board' ? 'board' : 'lab'
}

/** 두 페이지를 만들어 붙이고, 주소의 # 값에 따라 하나만 보여 줍니다. */
export function startApp(root: Element): void {
  const pages: Record<PageId, HTMLElement> = {
    lab: createLabPage(),
    board: createTestPage(),
  }

  const header = createDom(
    h(
      'header',
      { class: 'topbar' },
      h('a', { class: 'wordmark', href: '#lab' }, 'mini-react'),
      h(
        'nav',
        { class: 'topnav', 'aria-label': '페이지' },
        NAV_ITEMS.map(({ id, label }) => h('a', { href: `#${id}`, 'data-page': id }, label)),
      ),
    ),
  ) as HTMLElement
  header.append(createThemeToggle())

  const main = document.createElement('main')
  main.append(pages.lab, pages.board)
  root.replaceChildren(header, main)

  function showCurrentPage(): void {
    const current = pageFromHash()
    for (const { id } of NAV_ITEMS) {
      pages[id].hidden = id !== current
      const link = header.querySelector(`[data-page="${id}"]`)
      if (id === current) link?.setAttribute('aria-current', 'page')
      else link?.removeAttribute('aria-current')
    }
  }

  window.addEventListener('hashchange', () => {
    showCurrentPage()
    window.scrollTo(0, 0)
  })
  showCurrentPage()
}
