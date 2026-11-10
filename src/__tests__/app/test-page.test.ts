import { afterEach, beforeEach, describe, expect, it, vi } from '../testing.mjs'
import {
  MAX_FOCUS_MINUTES,
  MAX_TASKS,
  MAX_TRASH,
  STORAGE_KEY,
  TRASH_KEY,
  createTestPage,
  formatClock,
  formatCount,
  formatDuration,
  formatMinutes,
  formatTime,
  selectTasks,
} from '../../app/test-page.ts'
import type { Task } from '../../app/test-page.ts'

let page: HTMLElement

const flush = () => Promise.resolve()
const find = <T extends Element = HTMLElement>(role: string) =>
  page.querySelector(`[data-role="${role}"]`) as unknown as T
const number = (role: string) => Number(find(role).textContent)
const titles = () => Array.from(page.querySelectorAll('.task-title')).map((item) => item.textContent)

function button(label: string, parent: ParentNode = page): HTMLButtonElement {
  const found = Array.from(parent.querySelectorAll('button')).find((item) => item.textContent === label)
  if (!found) throw new Error(`${label} 버튼이 없습니다.`)
  return found
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flush()
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await flush()
}

async function press(target: HTMLButtonElement): Promise<void> {
  target.click()
  await flush()
}

async function addTask(title: string): Promise<void> {
  await type(find('draft'), title)
  page.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await flush()
}

function openPage(): void {
  page = createTestPage()
  document.body.append(page)
}

beforeEach(() => {
  localStorage.clear()
  openPage()
})

afterEach(() => {
  page.remove()
  vi.useRealTimers()
})

describe('할 일 다루기', () => {
  it('처음에 시작 목록을 보여 준다', () => {
    expect(titles()).toHaveLength(4)
  })

  it('입력해서 추가하면 목록 끝에 붙고 입력칸이 비워진다', async () => {
    await addTask('새 할 일')
    expect(titles().at(-1)).toBe('새 할 일')
    expect(find<HTMLInputElement>('draft').value).toBe('')
  })

  it('공백만 입력하면 추가되지 않는다', async () => {
    await addTask('   ')
    expect(titles()).toHaveLength(4)
  })

  it('체크하면 끝낸 일이 되고 진행 표시가 바뀐다', async () => {
    const checkbox = page.querySelector('input[type="checkbox"]') as HTMLInputElement
    checkbox.click()
    await flush()

    expect(page.querySelector('.task')?.classList.contains('is-done')).toBe(true)
    expect(page.querySelector('.board-count')?.textContent).toBe('4개 중 2개 끝냄')
  })

  it('삭제하면 그 항목만 사라지고 나머지 DOM은 그대로다', async () => {
    const rows = page.querySelectorAll('.task')
    await press(button('삭제', rows[1]))

    const after = page.querySelectorAll('.task')
    expect(after).toHaveLength(3)
    expect(after[0]).toBe(rows[0])
    expect(after[1]).toBe(rows[2])
  })

  it('우선순위 버튼은 높음, 보통, 낮음을 돌아가며 바꾼다', async () => {
    const priority = page.querySelector('.priority') as HTMLButtonElement
    expect(priority.textContent).toBe('높음')
    await press(priority)
    expect(priority.textContent).toBe('보통')
    await press(priority)
    await press(priority)
    expect(priority.textContent).toBe('높음')
  })

  it('끝낸 일을 한 번에 지운다', async () => {
    await press(button('끝낸 일 지우기'))
    expect(titles()).toHaveLength(3)
    expect(button('끝낸 일 지우기').disabled).toBe(true)
  })

  it('모두 지우면 다음 행동을 안내한다', async () => {
    for (const row of Array.from(page.querySelectorAll('.task'))) await press(button('삭제', row))
    expect(page.querySelector('.board-empty')?.textContent).toContain('첫 할 일')
  })
})

describe('찾기와 정렬', () => {
  it('보기를 바꾸면 조건에 맞는 일만 나온다', async () => {
    await press(button('끝낸 일'))
    expect(titles()).toEqual(['Reflow와 Repaint 차이 정리'])
  })

  it('입력할 때마다 찾고 입력칸의 포커스를 잃지 않는다', async () => {
    const search = find<HTMLInputElement>('search')
    search.focus()
    await type(search, 'readme')

    expect(titles()).toEqual(['README에 데모 화면 넣기'])
    expect(document.activeElement).toBe(search)
  })

  it('찾는 일이 없으면 조건을 바꾸라고 안내한다', async () => {
    await type(find('search'), '없는 글자')
    expect(page.querySelector('.board-empty')?.textContent).toContain('검색어')
  })

  it('정렬을 바꾸면 항목을 새로 만들지 않고 옮긴다', async () => {
    const rows = Array.from(page.querySelectorAll('.task'))
    await choose(find('sort'), 'title')

    const sorted = Array.from(page.querySelectorAll('.task'))
    expect(new Set(sorted)).toEqual(new Set(rows))
    expect(sorted).not.toEqual(rows)
    expect(page.querySelector('.op-move')).not.toBeNull()
  })

  it('보기 초기화는 상태 세 개를 바꿔도 렌더가 한 번이다', async () => {
    await press(button('끝낸 일'))
    await type(find('search'), 'reflow')
    await choose(find('sort'), 'title')
    const before = number('render-count')

    await press(find('reset-view'))

    expect(number('render-count')).toBe(before + 1)
    expect(titles()).toHaveLength(4)
    expect(find<HTMLInputElement>('search').value).toBe('')
  })
})

describe('집중 타이머', () => {
  const seed: Task[] = [
    { id: 'a', title: '짧은 일', priority: 'high', done: false, focusedSeconds: 0, plannedMinutes: 5 },
    { id: 'b', title: '긴 일', priority: 'normal', done: false, focusedSeconds: 0, plannedMinutes: 25 },
    { id: 'c', title: '끝낸 일', priority: 'low', done: true, focusedSeconds: 1500, plannedMinutes: 25 },
  ]

  beforeEach(() => {
    vi.useFakeTimers()
    page.remove()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    openPage()
  })

  async function tick(seconds: number): Promise<void> {
    for (let second = 0; second < seconds; second += 1) {
      vi.advanceTimersByTime(1000)
      await flush()
      await flush()
    }
  }

  const taskRow = (index: number) => page.querySelectorAll<HTMLElement>('.task')[index]

  async function startFocus(): Promise<void> {
    await press(button('집중하기', taskRow(0)))
    await press(button('시작하기'))
  }

  const warning = () => page.querySelector('[role="alert"]')
  const pressed = (target: HTMLButtonElement) => target.getAttribute('aria-pressed')

  it('일을 고르면 그 일의 계획 시간으로 타이머가 맞춰진다', async () => {
    await press(button('집중하기', taskRow(0)))
    expect(find('clock').textContent).toBe('05:00')

    await press(button('집중하기', taskRow(1)))
    expect(find('clock').textContent).toBe('25:00')
  })

  it('새 할 일을 만들 때 직접 쓴 시간이 계획 시간이 된다', async () => {
    await type(find('draft-minutes'), '7')
    await addTask('새 일')

    expect(taskRow(3).textContent).toContain('계획 7분')
    await press(button('집중하기', taskRow(3)))
    expect(find('clock').textContent).toBe('07:00')
  })

  it.each(['2', '91', '', '3.5'])('계획 시간 %s은 받지 않고 이유를 알려 준다', async (value) => {
    await type(find('draft-minutes'), value)
    await type(find('draft'), '새 일')

    expect(button('추가하기').disabled).toBe(true)
    expect(page.querySelector('.field-note')?.textContent).toContain('3분부터 1시간 30분까지')
  })

  it.each(['3', '90'])('계획 시간 %s분은 받는다', async (value) => {
    await type(find('draft-minutes'), value)
    await type(find('draft'), '새 일')
    expect(button('추가하기').disabled).toBe(false)
  })

  it('고른 일의 줄 전체에 표시가 붙고 다른 일을 고르면 옮겨 간다', async () => {
    await press(button('집중하기', taskRow(0)))
    expect(taskRow(0).classList.contains('is-focus')).toBe(true)

    await press(button('집중하기', taskRow(1)))
    expect(taskRow(0).classList.contains('is-focus')).toBe(false)
    expect(taskRow(1).classList.contains('is-focus')).toBe(true)
  })

  it('실제로 한 시간은 0분이어도 총 시간 칸으로 보인다', () => {
    expect(taskRow(0).querySelector('.task-minutes')?.textContent).toBe('총 0초')
    expect(taskRow(2).querySelector('.task-minutes')?.textContent).toBe('총 25분')
  })

  it('고른 일 없이 시간을 추가하면 더하지 않고 경고를 보여 준다', async () => {
    expect(button('+5분').disabled).toBe(false)

    await press(button('+5분'))

    expect(find('clock').textContent).toBe('25:00')
    expect(warning()?.textContent).toContain('고르지 않았습니다')
  })

  it('고른 일을 한 번 더 누르면 선택이 취소된다', async () => {
    await press(button('집중하기', taskRow(0)))
    await press(button('고른 일', taskRow(0)))

    expect(button('집중하기', taskRow(0))).toBeDefined()
    expect(taskRow(0).classList.contains('is-focus')).toBe(false)
    expect(find('clock').textContent).toBe('25:00')
    expect(page.querySelector('.timer-task')?.textContent).toContain('고르세요')
  })

  it('돌아가는 중에 취소하면 타이머가 멈추고 시간은 쌓이지 않는다', async () => {
    await startFocus()
    await tick(2)
    await press(button('고른 일', taskRow(0)))
    await tick(2)

    expect(find('clock').textContent).toBe('25:00')
    expect(button('시작하기')).toBeDefined()
    expect(taskRow(0).querySelector('.task-minutes')?.textContent).toBe('총 0초')
  })

  it('취소한 뒤에 다시 고를 수 있다', async () => {
    await press(button('집중하기', taskRow(0)))
    await press(button('고른 일', taskRow(0)))
    await press(button('집중하기', taskRow(0)))

    expect(find('clock').textContent).toBe('05:00')
    expect(taskRow(0).classList.contains('is-focus')).toBe(true)
  })

  it('시간 추가는 돌아가는 중에도 남은 시간에 더해진다', async () => {
    await startFocus()
    await tick(1)
    await press(button('+5분'))

    expect(find('clock').textContent).toBe('09:59')
    await tick(1)
    expect(find('clock').textContent).toBe('09:58')
  })

  it('더한 시간까지 집중 시간에 쌓이고, 끝내면 계획 시간으로 돌아온다', async () => {
    await startFocus()
    await press(button('+5분'))
    await tick(600)
    await press(button('끝내기'))

    expect(page.querySelector('.task-minutes')?.textContent).toBe('총 10분')
    expect(find('clock').textContent).toBe('05:00')
  })

  it('5초 테스트는 고른 일이 없어도 바로 돌고 경고를 지운다', async () => {
    await press(button('시작하기'))
    expect(warning()).not.toBeNull()

    await press(button('5초 테스트'))
    expect(find('clock').textContent).toBe('00:05')
    expect(page.querySelector('.timer-task')?.textContent).toBe('5초 테스트')
    expect(warning()).toBeNull()

    await tick(2)
    expect(find('clock').textContent).toBe('00:03')
  })

  it('고른 일 없는 5초 테스트도 끝나면 알림을 요청하고 넘긴 시간을 잰다', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    await press(button('5초 테스트'))
    await tick(7)

    expect(find('clock').textContent).toBe('+00:02')
    expect(JSON.parse(request.mock.calls[0][1]?.body as string).message).toBe('5초 테스트')
    request.mockRestore()
  })

  it('고른 일 없는 5초 테스트는 끝내도 어떤 일에도 시간이 쌓이지 않는다', async () => {
    await press(button('5초 테스트'))
    await tick(3)
    await press(button('끝내기'))

    expect(find('clock').textContent).toBe('25:00')
    expect(taskRow(0).querySelector('.task-minutes')?.textContent).toBe('총 0초')
    expect(page.querySelector('.board-focused')?.textContent).toContain('25분')
  })

  it('고른 일 없는 5초 테스트도 멈추고 이어서 돌리고 시간을 더할 수 있다', async () => {
    await press(button('5초 테스트'))
    await tick(1)
    await press(button('멈추기'))
    await tick(2)
    expect(find('clock').textContent).toBe('00:04')

    await press(button('시작하기'))
    await tick(1)
    expect(find('clock').textContent).toBe('00:03')
    expect(warning()).toBeNull()

    await press(button('+5분'))
    expect(find('clock').textContent).toBe('05:03')
  })

  it('5초 테스트는 바로 돌고, 끝나면 알림을 요청하고 넘긴 시간을 잰다', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    await press(button('집중하기', taskRow(0)))
    await press(button('5초 테스트'))
    expect(find('clock').textContent).toBe('00:05')

    await tick(5)
    expect(find('clock').textContent).toBe('00:00')
    expect(request).toHaveBeenCalledOnce()

    await tick(2)
    expect(find('clock').textContent).toBe('+00:02')
    request.mockRestore()
  })

  it('5초 테스트를 끝내면 실제 시간이 쌓이고 계획 시간으로 돌아온다', async () => {
    await press(button('집중하기', taskRow(0)))
    await press(button('5초 테스트'))
    await tick(7)
    await press(button('끝내기'))

    expect(taskRow(0).querySelector('.task-minutes')?.textContent).toBe('총 7초')
    expect(find('clock').textContent).toBe('05:00')
  })

  it('처음으로는 타이머 칸 안에 있고 시작 버튼 줄에서는 빠진다', () => {
    expect(page.querySelector('.timer .timer-reset')?.textContent).toBe('처음으로')
    expect(page.querySelector('.timer-actions')?.textContent).not.toContain('처음으로')
  })

  it('총 시간이 계획 시간을 넘으면 그 칸에만 표시가 붙는다', async () => {
    const minutes = (index: number) => taskRow(index).querySelector('.task-minutes') as HTMLElement
    expect(minutes(2).classList.contains('is-over-plan')).toBe(false)

    await startFocus()
    await tick(300)
    await press(button('끝내기'))
    expect(minutes(0).classList.contains('is-over-plan')).toBe(false)

    await press(button('시작하기'))
    await tick(1)
    await press(button('끝내기'))
    expect(minutes(0).classList.contains('is-over-plan')).toBe(true)
    expect(minutes(1).classList.contains('is-over-plan')).toBe(false)
  })

  it('시작 전에는 끝내기가 꺼져 있다', async () => {
    expect(button('끝내기').disabled).toBe(true)
    await press(button('집중하기', taskRow(0)))
    expect(button('끝내기').disabled).toBe(true)
  })

  it('중간에 끝내면 지난 시간이 초까지 쌓이고 타이머가 돌아온다', async () => {
    await startFocus()
    await tick(100)
    await press(button('끝내기'))
    await tick(2)

    expect(taskRow(0).querySelector('.task-minutes')?.textContent).toBe('총 1분 40초')
    expect(find('clock').textContent).toBe('05:00')
    expect(button('시작하기')).toBeDefined()
    expect(button('끝내기').disabled).toBe(true)
  })

  it('멈춘 상태에서도 끝낼 수 있다', async () => {
    await startFocus()
    await tick(5)
    await press(button('멈추기'))
    await tick(3)
    await press(button('끝내기'))

    expect(taskRow(0).querySelector('.task-minutes')?.textContent).toBe('총 5초')
  })

  it('여러 번 끝내면 시간이 합쳐진다', async () => {
    await startFocus()
    await tick(40)
    await press(button('끝내기'))
    await press(button('시작하기'))
    await tick(30)
    await press(button('끝내기'))

    expect(taskRow(0).querySelector('.task-minutes')?.textContent).toBe('총 1분 10초')
    expect(page.querySelector('.board-focused')?.textContent).toContain('26분 10초')
  })

  it('집중 시간은 0인 단위를 빼고 읽는다', () => {
    expect(formatDuration(0)).toBe('0초')
    expect(formatDuration(45)).toBe('45초')
    expect(formatDuration(60)).toBe('1분')
    expect(formatDuration(340)).toBe('5분 40초')
    expect(formatDuration(3600)).toBe('1시간')
    expect(formatDuration(3725)).toBe('1시간 2분 5초')
  })

  it('시간이 다 되면 멈추지 않고 넘긴 시간을 계속 잰다', async () => {
    await startFocus()
    await tick(300)
    expect(find('clock').textContent).toBe('00:00')
    expect(button('끝내기')).toBeDefined()

    await tick(3)
    expect(find('clock').textContent).toBe('+00:03')
    expect(find('clock').classList.contains('is-over')).toBe(true)
  })

  it('넘긴 시간까지 집중 시간에 쌓인다', async () => {
    await startFocus()
    await tick(420)
    await press(button('끝내기'))

    expect(page.querySelector('.task-minutes')?.textContent).toBe('총 7분')
    expect(find('clock').textContent).toBe('05:00')
    await tick(2)
    expect(find('clock').textContent).toBe('05:00')
  })

  it('넘긴 뒤에도 시간을 더하면 다시 줄어든다', async () => {
    await startFocus()
    await tick(302)
    await press(button('+5분'))

    expect(find('clock').textContent).toBe('04:58')
    expect(button('멈추기')).toBeDefined()
  })

  it('전체 6시간이 지나면 저절로 끝나고 쌓인다', async () => {
    await startFocus()
    vi.advanceTimersByTime(MAX_FOCUS_MINUTES * 60 * 1000)
    await flush()
    await flush()
    await flush()

    expect(page.querySelector('.task-minutes')?.textContent).toBe('총 6시간')
    expect(find('clock').textContent).toBe('05:00')
    expect(button('시작하기')).toBeDefined()
  })

  it('시간이 끝나면 고른 일의 이름으로 알림을 한 번 요청한다', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    await startFocus()
    await tick(303)

    expect(request).toHaveBeenCalledOnce()
    expect(JSON.parse(request.mock.calls[0][1]?.body as string)).toEqual({
      title: '집중 시간이 끝났습니다',
      message: '짧은 일',
    })
    request.mockRestore()
  })

  it('시간이 남아 있으면 알림을 요청하지 않는다', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    await startFocus()
    await tick(10)

    expect(request).not.toHaveBeenCalled()
    request.mockRestore()
  })

  it('알림 프로그램이 꺼져 있어도 타이머는 정상으로 돈다', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('연결 실패'))
    await startFocus()
    await tick(302)

    expect(find('clock').textContent).toBe('+00:02')
    request.mockRestore()
  })

  it('처음으로를 누르면 더한 시간이 사라지고 계획 시간으로 돌아간다', async () => {
    await press(button('집중하기', taskRow(0)))
    await press(button('+10분'))
    expect(find('clock').textContent).toBe('15:00')

    await press(button('처음으로'))
    expect(find('clock').textContent).toBe('05:00')
  })

  it('6시간을 넘게 눌러도 6시간에 맞춰지고, 6시간이면 추가 버튼이 전부 꺼진다', async () => {
    await press(button('집중하기', taskRow(1)))
    for (let count = 0; count < 11; count += 1) await press(button('+30분'))

    expect(find('clock').textContent).toBe('5:55:00')
    expect(button('+30분').disabled).toBe(false)

    await press(button('+30분'))

    expect(find('clock').textContent).toBe(`${MAX_FOCUS_MINUTES / 60}:00:00`)
    for (const label of ['+5분', '+10분', '+30분']) expect(button(label).disabled).toBe(true)
  })

  it('돌아가는 중에 6시간에 맞춰도 지난 시간까지 전체 6시간으로 계산한다', async () => {
    await press(button('집중하기', taskRow(1)))
    await press(button('시작하기'))
    await tick(60)
    for (let count = 0; count < 12; count += 1) await press(button('+30분'))

    expect(find('clock').textContent).toBe('5:59:00')
    expect(button('+5분').disabled).toBe(true)
  })

  it('넘긴 시간은 +를 붙여 보여 준다', () => {
    expect(formatClock(1)).toBe('00:01')
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(-1)).toBe('+00:01')
    expect(formatClock(-3661)).toBe('+1:01:01')
  })

  it('시계는 60분부터 시간 단위가 붙는다', () => {
    expect(formatTime(3599)).toBe('59:59')
    expect(formatTime(3600)).toBe('1:00:00')
    expect(formatTime(5400)).toBe('1:30:00')
  })

  it('분 표시도 60분부터 시간 단위로 바뀐다', () => {
    expect(formatMinutes(59)).toBe('59분')
    expect(formatMinutes(60)).toBe('1시간')
    expect(formatMinutes(90)).toBe('1시간 30분')
  })

  it('보기 칩과 고른 일도 눌린 상태로 남는다', async () => {
    expect(pressed(button('전체'))).toBe('true')

    await press(button('집중하기', page.querySelector('.task') as HTMLElement))

    expect(pressed(button('고른 일'))).toBe('true')
  })

  it('고른 일이 없으면 시작하지 않고 경고를 보여 준다', async () => {
    expect(warning()).toBeNull()

    await press(button('시작하기'))
    await tick(2)

    expect(find('clock').textContent).toBe('25:00')
    expect(button('시작하기')).toBeDefined()
    expect(warning()?.textContent).toContain('고르지 않았습니다')
  })

  it('경고를 띄워도 바뀐 노드는 경고 문단 하나다', async () => {
    await press(button('시작하기'))
    expect(number('patch-count')).toBe(1)
  })

  it('일을 고르면 경고가 사라지고 시작할 수 있다', async () => {
    await press(button('시작하기'))
    await startFocus()
    await tick(1)

    expect(warning()).toBeNull()
    expect(find('clock').textContent).toBe('04:59')
  })

  it('고를 일이 없으면 먼저 추가하라고 알려 주고, 추가하면 문구가 바뀐다', async () => {
    for (const task of page.querySelectorAll<HTMLElement>('.task')) {
      await press(button('삭제', task))
    }
    await press(button('시작하기'))
    expect(warning()?.textContent).toContain('먼저 추가')

    await addTask('새 일')
    expect(warning()?.textContent).toContain('고르지 않았습니다')
  })

  it('첫 1초에는 끝내기 버튼이 켜지면서 연산이 하나 더 생긴다', async () => {
    await startFocus()
    await tick(1)

    expect(find('clock').textContent).toBe('04:59')
    expect(number('patch-count')).toBe(2)
    expect(number('mutation-count')).toBe(2)
  })

  it('그 뒤로는 1초마다 글자 노드 하나만 바뀐다', async () => {
    await startFocus()
    await tick(2)

    expect(find('clock').textContent).toBe('04:58')
    expect(number('patch-count')).toBe(1)
    expect(number('mutation-count')).toBe(1)
  })

  it('시간이 줄어도 useMemo 덕분에 목록을 다시 계산하지 않는다', async () => {
    await startFocus()
    const before = number('memo-count')
    await tick(5)
    expect(number('memo-count')).toBe(before)
  })

  it('멈추면 시간이 그대로이고 처음으로를 누르면 되돌아간다', async () => {
    await startFocus()
    await tick(2)
    await press(button('멈추기'))
    await tick(3)
    expect(find('clock').textContent).toBe('04:58')

    await press(button('처음으로'))
    expect(find('clock').textContent).toBe('05:00')
  })

  it('끝내기를 누르면 고른 일에 집중 시간이 쌓이고 타이머가 돌아온다', async () => {
    await startFocus()
    await tick(300)
    await press(button('끝내기'))

    expect(find('clock').textContent).toBe('05:00')
    expect(page.querySelector('.task-minutes')?.textContent).toBe('총 5분')
    expect(page.querySelector('.board-focused')?.textContent).toContain('30분')
    expect(button('시작하기').disabled).toBe(false)
  })

  it('집중 중인 일을 지우면 타이머가 멈춘다', async () => {
    await startFocus()
    await press(button('삭제', page.querySelector('.task') as HTMLElement))
    await tick(2)

    expect(find('clock').textContent).toBe('25:00')

    await press(button('시작하기'))
    await tick(1)
    expect(find('clock').textContent).toBe('25:00')
    expect(warning()).not.toBeNull()
  })

  it('돌아가는 동안 document.title에 남은 시간이 나온다', async () => {
    await startFocus()
    await tick(1)
    expect(document.title).toContain('04:59')
  })
})

describe('이름 바로 수정', () => {
  const firstTitle = () => page.querySelector('.task .task-title') as HTMLButtonElement
  const editor = () => find<HTMLInputElement>('title-edit')

  async function key(name: string): Promise<void> {
    editor().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
    await flush()
  }

  async function startEdit(): Promise<void> {
    await press(firstTitle())
    await flush()
  }

  it('이름을 누르면 그 자리에 입력칸이 열리고 포커스가 간다', async () => {
    const title = firstTitle().textContent
    await startEdit()

    expect(editor().value).toBe(title)
    expect(document.activeElement).toBe(editor())
  })

  it('수정하기 버튼으로도 입력칸이 열리고, 고치는 동안에는 버튼이 사라진다', async () => {
    const row = page.querySelector('.task') as HTMLElement
    await press(button('수정하기', row))
    await flush()

    expect(document.activeElement).toBe(editor())
    expect(row.textContent).not.toContain('수정하기')

    await type(editor(), '버튼으로 고침')
    await key('Enter')
    expect(titles()[0]).toBe('버튼으로 고침')
    expect(button('수정하기', page.querySelector('.task') as HTMLElement)).toBeDefined()
  })

  it('이름을 눌러도 체크되지 않는다', async () => {
    await startEdit()
    expect((page.querySelector('.task input[type="checkbox"]') as HTMLInputElement).checked).toBe(false)
  })

  it('Enter를 누르면 저장되고 입력칸이 닫힌다', async () => {
    await startEdit()
    await type(editor(), '새 이름')
    await key('Enter')

    expect(editor()).toBeNull()
    expect(titles()[0]).toBe('새 이름')
  })

  it('다른 곳을 누르면 저장된다', async () => {
    await startEdit()
    await type(editor(), '새 이름')
    editor().blur()
    await flush()

    expect(titles()[0]).toBe('새 이름')
  })

  it('Esc를 누르면 원래 이름으로 돌아간다', async () => {
    const title = firstTitle().textContent
    await startEdit()
    await type(editor(), '버릴 이름')
    await key('Escape')
    await flush()

    expect(editor()).toBeNull()
    expect(titles()[0]).toBe(title)
  })

  it('비워 두면 원래 이름을 유지한다', async () => {
    const title = firstTitle().textContent
    await startEdit()
    await type(editor(), '   ')
    await key('Enter')

    expect(titles()[0]).toBe(title)
  })

  it('고른 일의 이름을 바꾸면 타이머의 이름도 바뀌고 시간과 우선순위는 그대로다', async () => {
    const row = page.querySelector('.task') as HTMLElement
    const plan = row.querySelector('.task-plan')?.textContent
    const priority = row.querySelector('.priority')?.textContent
    await press(button('집중하기', row))
    await startEdit()
    await type(editor(), '새 이름')
    await key('Enter')

    expect(page.querySelector('.timer-task')?.textContent).toBe('새 이름')
    expect(page.querySelector('.task-plan')?.textContent).toBe(plan)
    expect(page.querySelector('.priority')?.textContent).toBe(priority)
  })

  it('긴 이름도 그대로 저장한다', async () => {
    await startEdit()
    await type(editor(), '가'.repeat(100))
    await key('Enter')

    expect(titles()[0]).toBe('가'.repeat(100))
  })

  it('고친 이름은 다시 열어도 남아 있다', async () => {
    await startEdit()
    await type(editor(), '새 이름')
    await key('Enter')
    page.remove()
    openPage()

    expect(titles()[0]).toBe('새 이름')
  })
})

describe('지운 일 기록', () => {
  const deletedBox = () => page.querySelectorAll<HTMLElement>('.trash-box')[0]
  const clearedBox = () => page.querySelectorAll<HTMLElement>('.trash-box')[1]
  const names = (box: HTMLElement) => Array.from(box.querySelectorAll('.trash-title')).map((item) => item.textContent)
  const row = (title: string) =>
    Array.from(page.querySelectorAll<HTMLElement>('.task')).find((item) => item.textContent?.includes(title)) as HTMLElement

  async function removeFirst(): Promise<string> {
    const task = page.querySelector('.task') as HTMLElement
    const title = task.querySelector('.task-title')?.textContent as string
    await press(button('삭제', task))
    return title
  }

  it('삭제한 일은 위 칸에, 끝낸 일 지우기는 아래 칸에 이름이 남는다', async () => {
    const title = await removeFirst()
    await press(button('끝낸 일 지우기'))

    expect(names(deletedBox())).toEqual([title])
    expect(names(clearedBox())).toEqual(['Reflow와 Repaint 차이 정리'])
  })

  it('복원하면 우선순위와 시간까지 그대로 돌아온다', async () => {
    await press(button('끝낸 일 지우기'))
    await press(button('복원', clearedBox()))

    const restored = row('Reflow와 Repaint 차이 정리')
    expect(restored.querySelector('.priority')?.textContent).toBe('보통')
    expect(restored.querySelector('.task-plan')?.textContent).toBe('계획 25분')
    expect(restored.querySelector('.task-minutes')?.textContent).toBe('총 25분')
    expect(restored.classList.contains('is-done')).toBe(true)
    expect(names(clearedBox())).toEqual([])
  })

  it('낮은 우선순위와 5분 계획도 그대로 돌아온다', async () => {
    await press(button('삭제', row('README')))
    await press(button('복원', deletedBox()))

    expect(row('README').querySelector('.priority')?.textContent).toBe('낮음')
    expect(row('README').querySelector('.task-plan')?.textContent).toBe('계획 5분')
  })

  it('하나씩 삭제하면 기록에서만 사라지고 복원되지 않는다', async () => {
    const first = await removeFirst()
    const second = await removeFirst()
    await press(button('삭제', deletedBox().querySelector('.trash-row') as HTMLElement))

    expect(names(deletedBox())).toEqual([second])
    expect(titles()).not.toContain(first)
  })

  it('전체 복원과 전체 삭제는 그 칸만 처리한다', async () => {
    await removeFirst()
    await removeFirst()
    await press(button('끝낸 일 지우기'))

    await press(button('전체 복원', deletedBox()))
    expect(names(deletedBox())).toEqual([])
    expect(names(clearedBox())).toHaveLength(1)
    expect(titles()).toHaveLength(3)

    await press(button('전체 삭제', clearedBox()))
    expect(names(clearedBox())).toEqual([])
    expect(titles()).toHaveLength(3)
  })

  it(`기록은 ${MAX_TRASH}개까지이고 넘으면 맨 위부터 사라진다`, async () => {
    for (let count = 0; count < MAX_TRASH; count += 1) await addTask(`일 ${count}`)

    const removed: string[] = []
    for (let count = 0; count < MAX_TRASH + 2; count += 1) removed.push(await removeFirst())

    expect(names(deletedBox())).toEqual(removed.slice(-MAX_TRASH))
  })

  it('목록이 가득 차면 복원이 꺼지고 이유를 알려 준다', async () => {
    await removeFirst()
    for (let count = titles().length; count < MAX_TASKS; count += 1) await addTask(`일 ${count}`)

    expect(button('복원', deletedBox()).disabled).toBe(true)
    expect(button('전체 복원', deletedBox()).disabled).toBe(true)
    expect(page.querySelector('.trash-note')?.textContent).toContain('복원할 수 없습니다')
  })

  it('자리가 모자라면 들어갈 만큼만 복원하고 나머지는 기록에 남는다', async () => {
    const first = await removeFirst()
    const second = await removeFirst()
    for (let count = titles().length; count < MAX_TASKS - 1; count += 1) await addTask(`일 ${count}`)

    await press(button('전체 복원', deletedBox()))

    expect(titles()).toContain(first)
    expect(names(deletedBox())).toEqual([second])
  })

  it('다시 열어도 기록이 남아 있다', async () => {
    const title = await removeFirst()
    page.remove()
    openPage()
    expect(names(deletedBox())).toEqual([title])
  })

  it('기록 저장값이 깨져 있으면 빈 기록으로 시작한다', () => {
    page.remove()
    localStorage.setItem(TRASH_KEY, '{깨진 값')
    openPage()
    expect(names(deletedBox())).toEqual([])
  })
})

describe('입력 한도', () => {
  const note = () => page.querySelector('.field-note')?.textContent

  it('렌더 기록 숫자는 999를 넘으면 999+로 멈춘다', () => {
    expect(formatCount(999)).toBe('999')
    expect(formatCount(1000)).toBe('999+')
    expect(formatCount(123456)).toBe('999+')
  })

  it('입력칸에 글자 수 한도가 없다', async () => {
    expect(find('draft').hasAttribute('maxlength')).toBe(false)
    expect(find('search').hasAttribute('maxlength')).toBe(false)

    await addTask('가'.repeat(100))
    expect(titles()).toContain('가'.repeat(100))
  })

  it('검색 결과가 1개면 글자를 더 쳐도 렌더하지 않고, 지워서 2개가 되면 다시 렌더한다', async () => {
    await type(find('search'), 'eff')
    expect(titles()).toHaveLength(1)
    const renders = find('render-count').textContent

    await type(find('search'), 'effe')
    await type(find('search'), 'effec')
    await type(find('search'), 'eff')
    expect(find('render-count').textContent).toBe(renders)

    await type(find('search'), 'ef')
    expect(titles()).toHaveLength(2)
    expect(find('render-count').textContent).not.toBe(renders)
  })

  it('결과가 2개 이상이면 글자마다 렌더한다', async () => {
    await type(find('search'), 'e')
    const renders = find('render-count').textContent

    await type(find('search'), 'ef')
    expect(find('render-count').textContent).not.toBe(renders)
  })

  it('남은 1개와 맞지 않는 글자를 치면 없다는 화면을 보여 준다', async () => {
    await type(find('search'), 'eff')
    await type(find('search'), 'effz')

    expect(titles()).toHaveLength(0)
  })

  it('결과가 다른 일 1개로 바뀌면 다시 그린다', async () => {
    await type(find('search'), 'eff')
    await type(find('search'), 'README')

    expect(titles()).toHaveLength(1)
    expect(titles()[0]).toContain('README')
  })

  it('검색어를 다 지우면 전체 목록으로 돌아간다', async () => {
    const all = titles().length
    await type(find('search'), 'eff')
    await type(find('search'), '')

    expect(titles()).toHaveLength(all)
  })

  it('할 일이 한도에 차면 더 추가되지 않고, 지우면 다시 된다', async () => {
    const before = titles().length
    for (let count = before; count < MAX_TASKS + 3; count += 1) await addTask(`일 ${count}`)

    expect(titles()).toHaveLength(MAX_TASKS)
    expect(note()).toContain(`${MAX_TASKS}개까지`)

    await press(button('삭제', page.querySelector('.task') as HTMLElement))
    await addTask('다시 추가')
    expect(titles()).toHaveLength(MAX_TASKS)
    expect(titles()).toContain('다시 추가')
  })
})

describe('저장', () => {
  it('바뀐 목록을 저장하고 다시 열면 불러온다', async () => {
    await addTask('저장될 일')
    page.remove()
    openPage()
    expect(titles()).toContain('저장될 일')
  })

  it.each([
    ['JSON이 아닌 값', '{깨진 값'],
    ['배열이 아닌 값', '{"a":1}'],
    ['모양이 다른 항목', '[{"id":1}]'],
  ])('%s이 저장돼 있으면 시작 목록으로 돌아간다', (_name, saved) => {
    page.remove()
    localStorage.setItem(STORAGE_KEY, saved)
    openPage()
    expect(titles()).toHaveLength(4)
  })

  it('집중 시간을 분으로 저장하던 때의 목록도 그대로 불러온다', () => {
    page.remove()
    localStorage.setItem(STORAGE_KEY, JSON.stringify([{ id: 'x', title: '옛 일', priority: 'low', done: false, focusedMinutes: 25, plannedMinutes: 5 }]))
    openPage()

    expect(page.querySelector('.task-minutes')?.textContent).toBe('총 25분')
  })

  it('계획 시간이 없던 때 저장한 목록도 25분으로 불러온다', () => {
    page.remove()
    localStorage.setItem(STORAGE_KEY, JSON.stringify([{ id: 'x', title: '옛 일', priority: 'low', done: false, focusedMinutes: 0 }]))
    openPage()

    expect(titles()).toEqual(['옛 일'])
    expect(page.querySelector('.task-plan')?.textContent).toBe('계획 25분')
  })

  it('저장이 막혀도 화면은 계속 동작한다', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('용량 초과')
    })
    await addTask('저장 실패해도 보임')
    expect(titles()).toContain('저장 실패해도 보임')
    setItem.mockRestore()
  })
})

describe('순수 함수', () => {
  const tasks: Task[] = [
    { id: '1', title: '나', priority: 'low', done: false, focusedSeconds: 0, plannedMinutes: 25 },
    { id: '2', title: '가', priority: 'high', done: true, focusedSeconds: 0, plannedMinutes: 25 },
  ]

  it('원본 배열을 바꾸지 않고 정렬한다', () => {
    const snapshot = [...tasks]
    expect(selectTasks(tasks, 'all', '', 'title').map((task) => task.id)).toEqual(['2', '1'])
    expect(tasks).toEqual(snapshot)
  })

  it('우선순위순으로 정렬한다', () => {
    expect(selectTasks(tasks, 'all', '', 'priority')[0].id).toBe('2')
  })

  it('검색어 앞뒤 공백을 무시한다', () => {
    expect(selectTasks(tasks, 'all', '  가 ', 'created')).toHaveLength(1)
  })

  it.each([
    [0, '00:00'],
    [59, '00:59'],
    [60, '01:00'],
    [1500, '25:00'],
  ])('%i초는 %s로 표시한다', (seconds, text) => {
    expect(formatTime(seconds)).toBe(text)
  })
})
