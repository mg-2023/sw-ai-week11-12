import { childrenToVdom, htmlToVdom } from '../phase1/dom-to-vdom.ts'
import { createDom } from '../phase1/patch.ts'
import { elementNode } from '../phase1/types.ts'
import type { VElement, VNode } from '../phase1/types.ts'
import { vdomToHtml } from '../phase1/vdom-to-html.ts'
import { h } from '../phase2/h.ts'
import { createLabControls } from './controls.ts'
import type { LabControls, LabTransition } from './controls.ts'
import {
  createMutationCounter,
  domPatches,
  recordTouch,
  renderNodeMap,
  renderPatchList,
} from './inspector.ts'
import type { TouchedNodes } from './inspector.ts'

export const SAMPLE_HTML = `
<article class="sample-card">
  <h2>이번 주 스터디</h2>
  <p class="sample-lead">Virtual DOM을 직접 구현하고 <strong>Diff</strong> 결과를 확인합니다.</p>
  <ul class="sample-list">
    <li data-key="dom">DOM을 Virtual DOM으로 변환</li>
    <li data-key="diff">두 트리를 비교</li>
    <li data-key="patch">바뀐 부분만 반영</li>
  </ul>
  <p class="sample-note">모임은 <em>목요일 저녁 7시</em>에 시작합니다.</p>
</article>
`

type TestMode = 'code' | 'visual'

interface Scenario {
  label: string
  /** 대상 요소를 찾지 못하면 false를 돌려줍니다. */
  edit: (content: DocumentFragment) => boolean
}

let addedItemCount = 0

const SCENARIOS: Scenario[] = [
  {
    label: '글자 바꾸기',
    edit(content) {
      const title = content.querySelector('h2')
      if (!title) return false
      title.textContent = title.textContent === '이번 주 스터디' ? '다음 주 스터디' : '이번 주 스터디'
      return true
    },
  },
  {
    label: '속성 바꾸기',
    edit(content) {
      const note = content.querySelector('.sample-note')
      note?.classList.toggle('is-urgent')
      return note !== null
    },
  },
  {
    label: '노드 추가',
    edit(content) {
      const list = content.querySelector('ul')
      if (!list) return false
      addedItemCount += 1
      const item = document.createElement('li')
      item.dataset.key = `added-${addedItemCount}`
      item.textContent = `추가한 항목 ${addedItemCount}`
      list.append(item)
      return true
    },
  },
  {
    label: '노드 삭제',
    edit(content) {
      const item = content.querySelector('ul > li:last-child')
      item?.remove()
      return item !== null
    },
  },
  {
    label: '태그 교체',
    edit(content) {
      const inline = content.querySelector('.sample-note em, .sample-note mark')
      if (!inline) return false
      const next = document.createElement(inline.localName === 'em' ? 'mark' : 'em')
      next.textContent = inline.textContent
      inline.replaceWith(next)
      return true
    },
  },
  {
    label: '순서 뒤집기',
    edit(content) {
      const list = content.querySelector('ul')
      if (!list) return false
      list.append(...Array.from(list.children).reverse())
      return true
    },
  },
]

/** 영역의 내용 전체를 담는 뿌리입니다. 영역에 최상위 태그가 여러 개여도 트리는 하나가 됩니다. */
function rootNode(children: VNode[]): VElement {
  return elementNode('div', {}, children)
}

function childrenOf(vnode: VNode): VNode[] {
  return vnode.kind === 'element' ? vnode.children : []
}

function required<T extends Element>(parent: ParentNode, selector: string): T {
  const element = parent.querySelector<T>(selector)
  if (!element) throw new Error(`화면 요소 ${selector}를 찾지 못했습니다.`)
  return element
}

function renderLayout(handlers: {
  onPatch: () => void
  onBack: () => void
  onForward: () => void
  onFirst: () => void
  onMode: (mode: TestMode) => void
  onScenario: (scenario: Scenario) => void
  onCodeKeyDown: (event: Event) => void
}): HTMLElement {
  const tree = h(
    'section',
    { class: 'page lab', 'aria-labelledby': 'lab-title' },
    h(
      'header',
      { class: 'page-head' },
      h('h1', { id: 'lab-title' }, '고친 곳만 실제 화면에 반영됩니다'),
      h('p', null, '테스트 영역을 고치고 Patch를 누르면, 실제 영역에서 달라진 노드만 바뀝니다.'),
    ),
    h(
      'div',
      { class: 'lab-grid' },
      h(
        'section',
        { class: 'area area-real', 'aria-labelledby': 'real-title' },
        h('h2', { class: 'area-title', id: 'real-title' }, '실제 영역'),
        h('div', { class: 'area-body', 'data-role': 'real' }),
        // 샘플 내용이 아니라 영역의 고정 부품입니다. 그래서 테스트 영역에 안 나오고 Diff도 건드리지 않습니다.
        h('div', { class: 'area-foot' }, h('button', { type: 'button', class: 'sample-button' }, '참가 신청')),
      ),
      h(
        'div',
        { class: 'spine' },
        h(
          'button',
          { type: 'button', class: 'patch-button', 'data-role': 'patch', onClick: handlers.onPatch },
          'Patch',
        ),
        h(
          'div',
          { class: 'history-buttons' },
          h('button', { type: 'button', class: 'quiet-button', 'data-role': 'back', onClick: handlers.onBack }, '뒤로가기'),
          h('button', { type: 'button', class: 'quiet-button', 'data-role': 'forward', onClick: handlers.onForward }, '앞으로가기'),
          // 초기화가 아니라 기록의 첫 버전(v1)으로 이동합니다. 뒤 기록은 그대로 남아 앞으로가기로 돌아갈 수 있습니다.
          h('button', { type: 'button', class: 'quiet-button', 'data-role': 'first', onClick: handlers.onFirst }, 'v1로'),
        ),
        h('ol', { class: 'timeline', 'data-role': 'timeline', 'aria-label': '저장된 버전' }),
      ),
      h(
        'section',
        { class: 'area area-test', 'aria-labelledby': 'test-title' },
        h(
          'div',
          { class: 'area-title-row' },
          h('h2', { class: 'area-title', id: 'test-title' }, '테스트 영역'),
          h(
            'div',
            { class: 'mode-switch', role: 'group', 'aria-label': '편집 방식' },
            h('button', { type: 'button', 'data-mode': 'code', onClick: () => handlers.onMode('code') }, 'HTML 코드'),
            h('button', { type: 'button', 'data-mode': 'visual', onClick: () => handlers.onMode('visual') }, '화면에서 고치기'),
          ),
        ),
        h('textarea', {
          class: 'code-editor',
          'data-role': 'code',
          spellcheck: 'false',
          'aria-label': '테스트 영역 HTML 코드',
          onKeyDown: handlers.onCodeKeyDown,
        }),
        h('div', {
          class: 'area-body visual-editor',
          'data-role': 'visual',
          contenteditable: 'true',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': '테스트 영역 화면 편집',
          hidden: true,
        }),
        h(
          'div',
          { class: 'scenarios', role: 'group', 'aria-label': '예시 수정' },
          SCENARIOS.map((scenario) =>
            h('button', { type: 'button', class: 'chip', onClick: () => handlers.onScenario(scenario) }, scenario.label),
          ),
        ),
      ),
    ),
    h('p', { class: 'lab-status', 'data-role': 'status', role: 'status' }),
    h(
      'div',
      { class: 'report' },
      h(
        'section',
        { class: 'report-map', 'aria-labelledby': 'map-title' },
        h('h2', { id: 'map-title' }, '이번 Patch가 건드린 노드'),
        h(
          'p',
          { class: 'map-caption' },
          '네모는 DOM 요소, 동그라미는 글자 노드입니다. 색이 있는 칸만 바뀌었습니다.',
        ),
        h('div', { class: 'node-map', 'data-role': 'map', 'aria-hidden': 'true' }),
        h(
          'dl',
          { class: 'metrics' },
          h('div', null, h('dt', null, 'Diff 연산'), h('dd', { 'data-role': 'patch-count' }, '0')),
          h('div', null, h('dt', null, '실제 DOM 변경'), h('dd', { 'data-role': 'mutation-count' }, '0')),
          h('div', null, h('dt', null, '실제 영역 노드'), h('dd', { 'data-role': 'node-count' }, '0')),
        ),
        h(
          'p',
          { class: 'map-caption' },
          '실제 DOM 변경은 브라우저의 MutationObserver가 센 값입니다. 이동 한 번은 빼기와 끼우기, 두 건으로 셉니다.',
        ),
      ),
      h(
        'section',
        { class: 'report-ops', 'aria-labelledby': 'ops-title' },
        h('h2', { id: 'ops-title' }, '연산 목록'),
        h('ol', { class: 'op-list', 'data-role': 'ops' }),
        h(
          'details',
          { class: 'vdom-details' },
          h('summary', null, '현재 Virtual DOM 보기'),
          h('pre', { class: 'vdom-json', 'data-role': 'json' }),
        ),
      ),
    ),
  )

  return createDom(tree) as HTMLElement
}

/** 테스트 영역은 코드와 화면 두 얼굴을 가지며, 어느 쪽이든 읽으면 Virtual DOM이 나옵니다. */
function createTestArea(page: HTMLElement) {
  const code = required<HTMLTextAreaElement>(page, '[data-role="code"]')
  const visual = required<HTMLElement>(page, '[data-role="visual"]')
  const modeButtons = Array.from(page.querySelectorAll<HTMLButtonElement>('[data-mode]'))
  let mode: TestMode = 'code'

  function read(): VNode {
    return rootNode(mode === 'code' ? htmlToVdom(code.value) : childrenToVdom(visual))
  }

  function write(vnode: VNode): void {
    const children = childrenOf(vnode)
    code.value = vdomToHtml(children)
    visual.replaceChildren(...children.map((child) => createDom(child)))
  }

  function renderMode(): void {
    code.hidden = mode !== 'code'
    visual.hidden = mode !== 'visual'
    for (const button of modeButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === mode))
    }
  }

  function setMode(next: TestMode): void {
    if (next === mode) return
    const snapshot = read()
    mode = next
    write(snapshot)
    renderMode()
  }

  renderMode()
  return { read, write, setMode }
}

/** Phase 1 검증 페이지를 만듭니다. 조립만 하고, 규칙은 controls.ts에 있습니다. */
export function createLabPage(): HTMLElement {
  let controls: LabControls | null = null
  let testArea: ReturnType<typeof createTestArea> | null = null

  const setStatus = (message: string) => {
    required(page, '[data-role="status"]').textContent = message
  }

  const page = renderLayout({
    onPatch: () => controls?.patch(),
    onBack: () => controls?.back(),
    onForward: () => controls?.forward(),
    onFirst: () => controls?.jumpTo(0),
    onMode: (mode) => testArea?.setMode(mode),
    onScenario(scenario) {
      if (!testArea) return
      const template = document.createElement('template')
      template.innerHTML = vdomToHtml(childrenOf(testArea.read()))
      if (!scenario.edit(template.content)) {
        setStatus(`'${scenario.label}'에 쓸 요소가 테스트 영역에 없습니다. 뒤로가기로 샘플을 되돌려 보세요.`)
        return
      }
      const edited = rootNode(childrenToVdom(template.content))
      testArea.write(edited)
      setStatus('테스트 영역을 고쳤습니다. Patch를 누르면 실제 영역에 반영됩니다.')
    },
    onCodeKeyDown(event) {
      const { key, ctrlKey, metaKey } = event as KeyboardEvent
      if (key === 'Enter' && (ctrlKey || metaKey)) {
        event.preventDefault()
        controls?.patch()
      }
    },
  })

  const real = required<HTMLElement>(page, '[data-role="real"]')
  const timeline = required<HTMLElement>(page, '[data-role="timeline"]')
  const backButton = required<HTMLButtonElement>(page, '[data-role="back"]')
  const forwardButton = required<HTMLButtonElement>(page, '[data-role="forward"]')
  const firstButton = required<HTMLButtonElement>(page, '[data-role="first"]')
  testArea = createTestArea(page)

  // 샘플 속 링크나 폼이 실험 페이지를 떠나게 만들지 않도록 막습니다.
  for (const type of ['click', 'submit']) {
    real.addEventListener(type, (event) => {
      if (type === 'submit' || (event.target as Element).closest('a')) event.preventDefault()
    })
  }

  // 1) 실제 영역의 샘플 HTML을 Virtual DOM 트리로 바꿉니다.
  real.innerHTML = SAMPLE_HTML
  const initial = rootNode(childrenToVdom(real))

  // 2) 들여쓰기 공백은 트리에서 빠졌으므로, 경로 번호가 맞도록 DOM을 트리 그대로 다시 만듭니다.
  real.replaceChildren(...initial.children.map((child) => createDom(child)))

  // 3) 방금 만든 Virtual DOM으로 테스트 영역을 그립니다.
  testArea.write(initial)

  const mutations = createMutationCounter(real)
  const touched: TouchedNodes = new Map()

  function renderTimeline(active: LabControls): void {
    const { history } = active
    const items = Array.from({ length: history.size }, (_, index) =>
      createDom(
        h(
          'li',
          null,
          h(
            'button',
            {
              type: 'button',
              class: 'timeline-step',
              'aria-current': index === history.position ? 'step' : null,
              onClick: () => active.jumpTo(index),
            },
            `v${index + 1}`,
          ),
        ),
      ),
    )
    timeline.replaceChildren(...items)
    backButton.disabled = !history.canBack
    forwardButton.disabled = !history.canForward
    firstButton.disabled = history.position === 0
  }

  function messageFor(action: LabTransition['action'], changes: number, version: number): string {
    if (action !== 'patch') return `지금 버전은 v${version}입니다. 실제 영역과 테스트 영역이 함께 바뀌었습니다.`
    if (changes === 0) return '바뀐 곳이 없어서 실제 영역을 건드리지 않았습니다.'
    return `연산 ${changes}개로 실제 영역을 고쳤습니다. 지금 버전은 v${version}입니다.`
  }

  function renderReport(active: LabControls, transition: LabTransition | null): void {
    const patches = transition?.patches ?? []
    const { total } = renderNodeMap(required(page, '[data-role="map"]'), real, touched)
    touched.clear()

    required(page, '[data-role="patch-count"]').textContent = String(domPatches(patches).length)
    required(page, '[data-role="mutation-count"]').textContent = String(mutations.take())
    required(page, '[data-role="node-count"]').textContent = String(total)
    required(page, '[data-role="json"]').textContent = JSON.stringify(active.history.current, null, 2)
    renderPatchList(required(page, '[data-role="ops"]'), patches)
    renderTimeline(active)

    setStatus(
      transition
        ? messageFor(transition.action, patches.length, active.history.position + 1)
        : '테스트 영역을 고친 뒤 Patch를 눌러 보세요. 코드 입력 중에는 Ctrl+Enter로도 됩니다.',
    )
  }

  const activeTestArea = testArea
  const active = createLabControls({
    realRoot: real,
    initial,
    readTestArea: activeTestArea.read,
    writeTestArea: activeTestArea.write,
    onApply: (patch, node) => recordTouch(touched, patch, node),
    onTransition: (transition) => renderReport(active, transition),
  })
  controls = active
  renderReport(active, null)

  return page
}
