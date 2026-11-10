import { createDom } from '../phase1/patch.ts'
import type { PatchType, VNode } from '../phase1/types.ts'
import { FunctionComponent } from '../phase2/function-component.ts'
import type { Commit } from '../phase2/function-component.ts'
import { h } from '../phase2/h.ts'
import { useEffect } from '../phase2/hooks/use-effect.ts'
import { useMemo } from '../phase2/hooks/use-memo.ts'
import { useState } from '../phase2/hooks/use-state.ts'
import {
  createMutationCounter,
  domPatches,
  recordTouch,
  renderNodeMap,
  renderPatchList,
} from './inspector.ts'
import { notifyDesktop } from './notify.ts'

type Priority = 'high' | 'normal' | 'low'
type Filter = 'all' | 'active' | 'done'
type SortBy = 'created' | 'priority' | 'title'

export interface Task {
  id: string
  title: string
  priority: Priority
  done: boolean
  /** 실제로 집중한 시간입니다. 중간에 끊어도 맞도록 초 단위로 쌓습니다. */
  focusedSeconds: number
  /** 만들 때 정한 집중 시간입니다. 이 일을 고르면 타이머가 이 값으로 맞춰집니다. */
  plannedMinutes: number
}

/** 계획 시간이 없던 때와 집중 시간을 분으로 저장하던 때의 목록도 읽을 수 있어야 합니다. */
type SavedTask = Omit<Task, 'plannedMinutes' | 'focusedSeconds'> & {
  plannedMinutes?: number
  focusedSeconds?: number
  focusedMinutes?: number
}

/** 지운 일은 통째로 보관합니다. 복원할 때 시간과 우선순위까지 그대로 돌아옵니다. */
interface Trash {
  deleted: Task[]
  cleared: Task[]
}

type TrashBin = keyof Trash

interface BoardStats {
  total: number
  done: number
  remaining: number
  focusedSeconds: number
}

/** 화면 바깥에서 관찰할 숫자입니다. 상태가 아니므로 바뀌어도 다시 그리지 않습니다. */
export interface BoardMetrics {
  memoRuns: number
}

interface FocusBoardProps {
  metrics: BoardMetrics
}

export const STORAGE_KEY = 'mini-react:focus-board'
export const TRASH_KEY = 'mini-react:focus-board-trash'

const PRIORITIES: Priority[] = ['high', 'normal', 'low']
const PRIORITY_LABELS: Record<Priority, string> = { high: '높음', normal: '보통', low: '낮음' }
const FILTER_LABELS: Record<Filter, string> = { all: '전체', active: '남은 일', done: '끝낸 일' }
const SORT_LABELS: Record<SortBy, string> = { created: '추가한 순서', priority: '우선순위', title: '제목' }
const ADD_CHOICES = [5, 10, 30]
const DEFAULT_FOCUS_MINUTES = 25
const TEST_TIMER_SECONDS = 5
const TEST_TIMER_LABEL = '5초 테스트'
/** 한 번의 집중이 넘을 수 없는 전체 시간입니다. 더한 시간과 초과 시간을 모두 포함합니다. */
export const MAX_FOCUS_MINUTES = 360
export const MIN_PLAN_MINUTES = 3
export const MAX_PLAN_MINUTES = 90

// 목록과 기록이 한눈에 보이는 만큼만 받습니다.
export const MAX_TASKS = 20
export const MAX_TRASH = 5
const MAX_RECORD_COUNT = 999

const STARTER_TASKS: Task[] = [
  { id: 'starter-1', title: 'Diff 다섯 가지 케이스 설명 연습', priority: 'high', done: false, focusedSeconds: 0, plannedMinutes: 25 },
  { id: 'starter-2', title: 'useEffect 정리 함수 복습', priority: 'normal', done: false, focusedSeconds: 0, plannedMinutes: 15 },
  { id: 'starter-3', title: 'Reflow와 Repaint 차이 정리', priority: 'normal', done: true, focusedSeconds: 1500, plannedMinutes: 25 },
  { id: 'starter-4', title: 'README에 데모 화면 넣기', priority: 'low', done: false, focusedSeconds: 0, plannedMinutes: 5 },
]

let createdTaskCount = 0

function isTask(value: unknown): value is SavedTask {
  if (typeof value !== 'object' || value === null) return false
  const task = value as Partial<SavedTask>
  return (
    (task.plannedMinutes === undefined || typeof task.plannedMinutes === 'number') &&
    typeof task.id === 'string' &&
    typeof task.title === 'string' &&
    PRIORITIES.includes(task.priority as Priority) &&
    typeof task.done === 'boolean' &&
    (typeof task.focusedSeconds === 'number' || typeof task.focusedMinutes === 'number')
  )
}

/** 저장소는 언제든 비거나 깨질 수 있으므로, 읽을 수 없으면 시작 데이터로 돌아갑니다. */
function loadTasks(): Task[] {
  try {
    return readTasks(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')) ?? STARTER_TASKS
  } catch {
    return STARTER_TASKS
  }
}

function readTasks(saved: unknown): Task[] | null {
  if (!Array.isArray(saved) || !saved.every(isTask)) return null
  return saved.map(({ focusedMinutes, ...task }) => ({
    ...task,
    plannedMinutes: task.plannedMinutes ?? DEFAULT_FOCUS_MINUTES,
    focusedSeconds: task.focusedSeconds ?? (focusedMinutes ?? 0) * 60,
  }))
}

function loadTrash(): Trash {
  try {
    const saved = JSON.parse(localStorage.getItem(TRASH_KEY) ?? 'null') as Partial<Trash> | null
    return { deleted: readTasks(saved?.deleted) ?? [], cleared: readTasks(saved?.cleared) ?? [] }
  } catch {
    return { deleted: [], cleared: [] }
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 시크릿 모드나 용량 초과로 저장이 막혀도 화면은 계속 동작합니다.
  }
}

export function selectTasks(tasks: readonly Task[], filter: Filter, query: string, sortBy: SortBy): Task[] {
  const keyword = query.trim().toLowerCase()
  const visible = tasks.filter((task) => {
    if (filter === 'active' && task.done) return false
    if (filter === 'done' && !task.done) return false
    return task.title.toLowerCase().includes(keyword)
  })

  if (sortBy === 'priority') {
    return visible.toSorted((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority))
  }
  if (sortBy === 'title') {
    return visible.toSorted((a, b) => a.title.localeCompare(b.title, 'ko'))
  }
  return visible
}

function summarize(tasks: readonly Task[]): BoardStats {
  const done = tasks.filter((task) => task.done).length
  return {
    total: tasks.length,
    done,
    remaining: tasks.length - done,
    focusedSeconds: tasks.reduce((sum, task) => sum + task.focusedSeconds, 0),
  }
}

export function formatTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0')
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`
}

/** 시간이 다 되면 멈추지 않고 넘긴 시간을 +로 셉니다. */
export function formatClock(secondsLeft: number): string {
  return secondsLeft < 0 ? `+${formatTime(-secondsLeft)}` : formatTime(secondsLeft)
}

/** 집중한 시간을 시간, 분, 초로 읽습니다. 0인 단위는 뺍니다. */
export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts = [hours && `${hours}시간`, minutes && `${minutes}분`, seconds && `${seconds}초`]
  return parts.filter(Boolean).join(' ') || '0초'
}

function isValidPlan(minutes: string): boolean {
  const value = Number(minutes)
  return Number.isInteger(value) && value >= MIN_PLAN_MINUTES && value <= MAX_PLAN_MINUTES
}

/** 60분부터는 시간 단위로 읽습니다. */
export function formatMinutes(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes}분`
  return minutes === 0 ? `${hours}시간` : `${hours}시간 ${minutes}분`
}

/**
 * 검색 결과가 1개 이하로 좁혀지면 글자를 더 쳐도 보이는 목록이 그대로입니다.
 * 이때는 상태로 올리지 않습니다. 상태가 그대로면 렌더도 일어나지 않습니다.
 * 결과가 2개 이상으로 늘거나 보이는 일이 달라지면 다시 그립니다.
 */
function keepsNarrowResult(shown: readonly Task[], next: readonly Task[]): boolean {
  return shown.length <= 1 && next.length <= 1 && shown[0]?.id === next[0]?.id
}

/** 타이머가 돌면 렌더는 계속 일어나므로, 보여 주는 숫자만 한도에서 멈춥니다. */
export function formatCount(count: number): string {
  return count > MAX_RECORD_COUNT ? `${MAX_RECORD_COUNT}+` : String(count)
}

/** 남은 일이 없으면 고를 수가 없으므로, 고르라는 말 대신 할 수 있는 일을 알려 줍니다. */
function pickWarningFor(remaining: number): string {
  return remaining > 0
    ? "집중할 일을 고르지 않았습니다. 아래 목록에서 '집중하기'를 누르세요."
    : '고를 수 있는 일이 없습니다. 새로 할 일을 먼저 추가하세요.'
}

/* 자식 컴포넌트: 상태 없이 props만 받아 트리를 돌려주는 순수 함수입니다. */

function Progress({ stats }: { stats: BoardStats }): VNode {
  const percent = stats.total === 0 ? 0 : Math.round((stats.done / stats.total) * 100)
  return h(
    'section',
    { class: 'board-progress', 'aria-label': '진행 상황' },
    h('p', { class: 'board-count' }, `${stats.total}개 중 ${stats.done}개 끝냄`),
    h(
      'div',
      {
        class: 'progress-track',
        role: 'progressbar',
        'aria-label': '끝낸 일 비율',
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': percent,
      },
      h('div', { class: 'progress-fill', style: { width: `${percent}%` } }),
    ),
    h('p', { class: 'board-focused' }, `오늘 집중한 시간 ${formatDuration(stats.focusedSeconds)}`),
  )
}

interface FocusTimerProps {
  task: Task | undefined
  secondsLeft: number
  running: boolean
  sessionMinutes: number
  canFinish: boolean
  warning: string | null
  onToggle: () => void
  onFinish: () => void
  onReset: () => void
  onAddTime: (minutes: number) => void
}

function timerCaption(task: Task | undefined, running: boolean): string {
  if (task) return task.title
  return running ? TEST_TIMER_LABEL : '아래 목록에서 집중할 일을 고르세요'
}

function FocusTimer(props: FocusTimerProps): VNode {
  const { task, secondsLeft, running, sessionMinutes, canFinish, warning, onToggle, onFinish, onReset, onAddTime } = props
  return h(
    'section',
    { class: 'timer', 'aria-label': '집중 타이머' },
    h('button', { type: 'button', class: 'quiet-button timer-reset', onClick: onReset }, '처음으로'),
    h('p', { class: 'timer-task' }, timerCaption(task, running)),
    h(
      'p',
      { class: secondsLeft < 0 ? 'timer-clock is-over' : 'timer-clock', role: 'timer', 'data-role': 'clock' },
      formatClock(secondsLeft),
    ),
    h(
      'div',
      { class: 'timer-actions' },
      h('button', { type: 'button', class: 'solid-button', onClick: onToggle }, running ? '멈추기' : '시작하기'),
      h('button', { type: 'button', class: 'quiet-button', disabled: !canFinish, onClick: onFinish }, '끝내기'),
      h(
        'div',
        { class: 'timer-lengths', role: 'group', 'aria-label': '시간 추가' },
        ADD_CHOICES.map((choice) =>
          h(
            'button',
            {
              key: choice,
              type: 'button',
              class: 'chip',
              disabled: sessionMinutes >= MAX_FOCUS_MINUTES,
              onClick: () => onAddTime(choice),
            },
            `+${choice}분`,
          ),
        ),
      ),
    ),
    warning ? h('p', { class: 'timer-warning', role: 'alert' }, warning) : null,
  )
}

interface ComposerProps {
  draft: string
  priority: Priority
  minutes: string
  isFull: boolean
  onDraft: (value: string) => void
  onPriority: (priority: Priority) => void
  onMinutes: (minutes: string) => void
  onSubmit: () => void
}

function composerNote(minutes: string, isFull: boolean): string | null {
  if (isFull) return `할 일은 ${MAX_TASKS}개까지입니다. 지운 뒤에 더 추가할 수 있습니다.`
  return isValidPlan(minutes) ? null : `시간은 ${MIN_PLAN_MINUTES}분부터 ${formatMinutes(MAX_PLAN_MINUTES)}까지 정할 수 있습니다.`
}

function Composer(props: ComposerProps): VNode {
  const { draft, priority, minutes, isFull, onDraft, onPriority, onMinutes, onSubmit } = props
  const note = composerNote(minutes, isFull)
  const canAdd = draft.trim() !== '' && !isFull && isValidPlan(minutes)
  return h(
    'form',
    {
      class: 'composer',
      onSubmit(event: Event) {
        event.preventDefault()
        onSubmit()
      },
    },
    h('input', {
      class: 'composer-input',
      type: 'text',
      value: draft,
      placeholder: '새로 할 일을 적으세요',
      'aria-label': '새로 할 일',
      'data-role': 'draft',
      onInput: (event: Event) => onDraft((event.target as HTMLInputElement).value),
    }),
    h(
      'select',
      {
        class: 'field',
        value: priority,
        'aria-label': '우선순위',
        onChange: (event: Event) => onPriority((event.target as HTMLSelectElement).value as Priority),
      },
      PRIORITIES.map((option) => h('option', { key: option, value: option }, PRIORITY_LABELS[option])),
    ),
    h(
      'label',
      { class: 'minutes-field' },
      h('input', {
        class: 'field',
        type: 'number',
        min: MIN_PLAN_MINUTES,
        max: MAX_PLAN_MINUTES,
        value: minutes,
        'aria-label': '집중 시간(분)',
        'data-role': 'draft-minutes',
        onInput: (event: Event) => onMinutes((event.target as HTMLInputElement).value),
      }),
      '분',
    ),
    h('button', { type: 'submit', class: 'solid-button', disabled: !canAdd }, '추가하기'),
    note ? h('p', { class: 'field-note', role: 'status' }, note) : null,
  )
}

interface ToolbarProps {
  filter: Filter
  query: string
  sortBy: SortBy
  hasDone: boolean
  onFilter: (filter: Filter) => void
  onQuery: (query: string) => void
  onSort: (sortBy: SortBy) => void
  onResetView: () => void
  onClearDone: () => void
}

function Toolbar(props: ToolbarProps): VNode {
  const { filter, query, sortBy, hasDone, onFilter, onQuery, onSort, onResetView, onClearDone } = props
  const filters = Object.keys(FILTER_LABELS) as Filter[]
  const sorts = Object.keys(SORT_LABELS) as SortBy[]

  return h(
    'div',
    { class: 'toolbar' },
    h(
      'div',
      { class: 'toolbar-row', role: 'group', 'aria-label': '보기' },
      filters.map((option) =>
        h(
          'button',
          {
            key: option,
            type: 'button',
            class: 'chip',
            'aria-pressed': option === filter,
            onClick: () => onFilter(option),
          },
          FILTER_LABELS[option],
        ),
      ),
    ),
    h(
      'div',
      { class: 'toolbar-row' },
      h('input', {
        class: 'field toolbar-search',
        type: 'search',
        value: query,
        placeholder: '제목으로 찾기',
        'aria-label': '제목으로 찾기',
        'data-role': 'search',
        onInput: (event: Event) => onQuery((event.target as HTMLInputElement).value),
      }),
      h(
        'select',
        {
          class: 'field',
          value: sortBy,
          'aria-label': '정렬',
          'data-role': 'sort',
          onChange: (event: Event) => onSort((event.target as HTMLSelectElement).value as SortBy),
        },
        sorts.map((option) => h('option', { key: option, value: option }, SORT_LABELS[option])),
      ),
      h('button', { type: 'button', class: 'quiet-button', 'data-role': 'reset-view', onClick: onResetView }, '보기 초기화'),
      h('button', { type: 'button', class: 'quiet-button', disabled: !hasDone, onClick: onClearDone }, '끝낸 일 지우기'),
    ),
  )
}

interface TaskRowProps {
  task: Task
  isFocus: boolean
  editingTitle: string | null
  onToggle: (id: string) => void
  onCyclePriority: (id: string) => void
  onPickFocus: (id: string) => void
  onRemove: (id: string) => void
  onStartEdit: (id: string) => void
  onEditTitle: (title: string) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
}

/** Esc로 취소한 입력칸은 사라질 때 생기는 blur로 저장되면 안 됩니다. */
const cancelledEdits = new WeakSet<EventTarget>()

interface TitleEditorProps {
  title: string
  onEditTitle: (title: string) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
}

function TitleEditor({ title, onEditTitle, onSaveEdit, onCancelEdit }: TitleEditorProps): VNode {
  return h('input', {
    class: 'field task-title-input',
    type: 'text',
    value: title,
    'aria-label': '할 일 이름',
    'data-role': 'title-edit',
    onInput: (event: Event) => onEditTitle((event.target as HTMLInputElement).value),
    onKeyDown(event: Event) {
      const { key, isComposing, target } = event as KeyboardEvent
      if (isComposing) return
      if (key === 'Enter') onSaveEdit()
      if (key === 'Escape' && target) {
        cancelledEdits.add(target)
        onCancelEdit()
      }
    },
    onBlur(event: Event) {
      if (event.target && !cancelledEdits.has(event.target)) onSaveEdit()
    },
  })
}

function TaskRow(props: TaskRowProps): VNode {
  const { task, isFocus, editingTitle, onToggle, onCyclePriority, onPickFocus, onRemove, onStartEdit } = props
  const { onEditTitle, onSaveEdit, onCancelEdit } = props
  const priorityLabel = PRIORITY_LABELS[task.priority]
  const classes = ['task', task.done ? 'is-done' : '', isFocus ? 'is-focus' : ''].filter(Boolean).join(' ')
  return h(
    'li',
    { class: classes, 'data-task': task.id },
    h(
      'div',
      { class: 'task-main' },
      h('input', {
        type: 'checkbox',
        checked: task.done,
        'aria-label': `${task.title} 끝냄`,
        onChange: () => onToggle(task.id),
      }),
      editingTitle === null
        ? h(
            'button',
            { type: 'button', class: 'task-title', title: '눌러서 이름 바꾸기', onClick: () => onStartEdit(task.id) },
            task.title,
          )
        : h(TitleEditor, { title: editingTitle, onEditTitle, onSaveEdit, onCancelEdit }),
      editingTitle === null
        ? h('button', { type: 'button', class: 'text-button', onClick: () => onStartEdit(task.id) }, '수정하기')
        : null,
    ),
    h('span', { class: 'task-plan' }, `계획 ${task.plannedMinutes}분`),
    h(
      'span',
      // 계획 시간에 도달하면(같아도) 색을 칠하고, 넘었을 때만 is-over-plan 을 따로 붙입니다.
      {
        class:
          task.focusedSeconds > task.plannedMinutes * 60
            ? 'task-minutes is-plan-met is-over-plan'
            : task.focusedSeconds === task.plannedMinutes * 60
              ? 'task-minutes is-plan-met'
              : 'task-minutes',
      },
      `총 ${formatDuration(task.focusedSeconds)}`,
    ),
    h(
      'button',
      {
        type: 'button',
        class: `priority priority-${task.priority}`,
        'aria-label': `우선순위 ${priorityLabel}, 눌러서 바꾸기`,
        onClick: () => onCyclePriority(task.id),
      },
      priorityLabel,
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'text-button',
        disabled: task.done,
        'aria-pressed': isFocus,
        onClick: () => onPickFocus(task.id),
      },
      isFocus ? '고른 일' : '집중하기',
    ),
    h('button', { type: 'button', class: 'text-button', onClick: () => onRemove(task.id) }, '삭제'),
  )
}

interface Editing {
  id: string
  title: string
}

interface TaskListProps extends Omit<TaskRowProps, 'task' | 'isFocus' | 'editingTitle'> {
  tasks: Task[]
  focusId: string | null
  editing: Editing | null
  isBoardEmpty: boolean
}

function TaskList({ tasks, focusId, editing, isBoardEmpty, ...handlers }: TaskListProps): VNode {
  if (tasks.length === 0) {
    return h(
      'p',
      { class: 'board-empty' },
      isBoardEmpty
        ? '할 일이 없습니다. 위 입력칸에 첫 할 일을 적어 보세요.'
        : '조건에 맞는 일이 없습니다. 검색어를 지우거나 보기를 바꿔 보세요.',
    )
  }

  return h(
    'ul',
    { class: 'task-list' },
    tasks.map((task) =>
      h(TaskRow, {
        key: task.id,
        task,
        isFocus: task.id === focusId,
        editingTitle: editing?.id === task.id ? editing.title : null,
        ...handlers,
      }),
    ),
  )
}

interface TrashBoxProps {
  title: string
  tasks: Task[]
  canRestore: boolean
  onRestore: (id: string) => void
  onForget: (id: string) => void
  onRestoreAll: () => void
  onForgetAll: () => void
}

function TrashBox(props: TrashBoxProps): VNode {
  const { title, tasks, canRestore, onRestore, onForget, onRestoreAll, onForgetAll } = props
  const isEmpty = tasks.length === 0

  return h(
    'section',
    { class: 'trash-box', 'aria-label': title },
    h(
      'div',
      { class: 'trash-head' },
      h('h3', null, `${title} ${tasks.length}/${MAX_TRASH}`),
      h('button', { type: 'button', class: 'text-button', disabled: isEmpty || !canRestore, onClick: onRestoreAll }, '전체 복원'),
      h('button', { type: 'button', class: 'text-button', disabled: isEmpty, onClick: onForgetAll }, '전체 삭제'),
    ),
    isEmpty
      ? h('p', { class: 'trash-empty' }, '기록이 없습니다.')
      : h(
          'ul',
          { class: 'trash-list' },
          tasks.map((task) =>
            h(
              'li',
              { key: task.id, class: 'trash-row' },
              h('span', { class: 'trash-title', title: task.title }, task.title),
              h('button', { type: 'button', class: 'text-button', disabled: !canRestore, onClick: () => onRestore(task.id) }, '복원'),
              h('button', { type: 'button', class: 'text-button', onClick: () => onForget(task.id) }, '삭제'),
            ),
          ),
        ),
  )
}

/* 루트 컴포넌트: 모든 상태와 Hook은 여기에만 있습니다(Lifting State Up). */

export function FocusBoard({ metrics }: FocusBoardProps): VNode {
  const [tasks, setTasks] = useState<Task[]>(loadTasks)
  const [draft, setDraft] = useState('')
  const [draftPriority, setDraftPriority] = useState<Priority>('normal')
  const [draftMinutes, setDraftMinutes] = useState(String(DEFAULT_FOCUS_MINUTES))
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState<SortBy>('created')
  const [focusId, setFocusId] = useState<string | null>(null)
  const [focusMinutes, setFocusMinutes] = useState(DEFAULT_FOCUS_MINUTES)
  const [secondsLeft, setSecondsLeft] = useState(DEFAULT_FOCUS_MINUTES * 60)
  const [running, setRunning] = useState(false)
  const [showPickWarning, setShowPickWarning] = useState(false)
  const [trash, setTrash] = useState<Trash>(loadTrash)
  const [editing, setEditing] = useState<Editing | null>(null)

  // 타이머가 1초마다 다시 그려도 tasks와 조건이 그대로면 목록은 재계산되지 않습니다.
  const visibleTasks = useMemo(() => {
    metrics.memoRuns += 1
    return selectTasks(tasks, filter, query, sortBy)
  }, [tasks, filter, query, sortBy])
  const stats = useMemo(() => summarize(tasks), [tasks])
  const focusTask = tasks.find((task) => task.id === focusId)
  const plannedMinutes = focusTask?.plannedMinutes ?? DEFAULT_FOCUS_MINUTES

  useEffect(() => {
    save(STORAGE_KEY, tasks)
  }, [tasks])

  useEffect(() => {
    document.title = running
      ? `${formatClock(secondsLeft)} 집중 중 | mini-react`
      : `남은 일 ${stats.remaining}개 | mini-react`
    return () => {
      document.title = 'mini-react'
    }
  }, [running, secondsLeft, stats.remaining])

  // 정리 함수가 없으면 멈춘 뒤에도 타이머가 살아남아 시간이 두 배로 줄어듭니다.
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setSecondsLeft((seconds) => seconds - 1), 1000)
    return () => clearInterval(timer)
  }, [running])

  useEffect(() => {
    if (secondsLeft === 0) notifyDesktop('집중 시간이 끝났습니다', focusTask?.title ?? TEST_TIMER_LABEL)
    if (elapsedSeconds() >= MAX_FOCUS_MINUTES * 60) finishFocus()
  }, [secondsLeft])

  useEffect(() => {
    save(TRASH_KEY, trash)
  }, [trash])

  // 입력칸은 화면에 붙은 뒤에야 포커스를 받을 수 있어서 effect에서 합니다.
  useEffect(() => {
    if (!editing) return
    const input = document.querySelector<HTMLInputElement>('[data-role="title-edit"]')
    input?.focus()
    input?.select()
  }, [editing?.id])

  function resetTimer(minutes: number = plannedMinutes): void {
    setRunning(false)
    setFocusMinutes(minutes)
    setSecondsLeft(minutes * 60)
  }

  /** 돌아가는 중에도 더할 수 있습니다. 한도를 넘게 누르면 한도까지만 더합니다. */
  function addTime(minutes: number): void {
    if (!canControlTimer()) {
      setShowPickWarning(true)
      return
    }
    const added = Math.min(minutes, MAX_FOCUS_MINUTES - focusMinutes)
    setFocusMinutes((total) => total + added)
    setSecondsLeft((seconds) => seconds + added * 60)
  }

  function elapsedSeconds(): number {
    return Math.round(focusMinutes * 60 - secondsLeft)
  }

  /** 시간 종료 동작을 오래 기다리지 않고 확인하는 테스트용 타이머입니다. */
  function startTestTimer(): void {
    setShowPickWarning(false)
    setFocusMinutes(TEST_TIMER_SECONDS / 60)
    setSecondsLeft(TEST_TIMER_SECONDS)
    setRunning(true)
  }

  /** 고른 일이 없어도 테스트 타이머가 돌고 있으면 멈추기와 시간 추가가 됩니다. */
  function canControlTimer(): boolean {
    return Boolean(focusTask) || running || elapsedSeconds() > 0
  }

  /** 중간에 끊어도, 시간을 넘겨도 실제로 지난 시간만큼 쌓고 타이머를 계획 시간으로 돌립니다. */
  function finishFocus(): void {
    const seconds = elapsedSeconds()
    if (focusId) changeTask(focusId, (task) => ({ ...task, focusedSeconds: task.focusedSeconds + seconds }))
    resetTimer()
  }

  function toggleTimer(): void {
    if (!canControlTimer()) {
      setShowPickWarning(true)
      return
    }
    setRunning((value) => !value)
  }

  function changeQuery(next: string): void {
    const searching = query !== '' && next !== ''
    if (searching && keepsNarrowResult(visibleTasks, selectTasks(tasks, filter, next, sortBy))) return
    setQuery(next)
  }

  function addTask(): void {
    const title = draft.trim()
    if (title === '' || tasks.length >= MAX_TASKS || !isValidPlan(draftMinutes)) return
    createdTaskCount += 1
    const task: Task = {
      id: `task-${Date.now().toString(36)}-${createdTaskCount}`,
      title,
      priority: draftPriority,
      done: false,
      focusedSeconds: 0,
      plannedMinutes: Number(draftMinutes),
    }
    setTasks((list) => [...list, task])
    setDraft('')
  }

  function changeTask(id: string, change: (task: Task) => Task): void {
    setTasks((list) => list.map((task) => (task.id === id ? change(task) : task)))
  }

  /** 새 기록은 아래에 붙고, 칸이 차면 맨 위의 오래된 기록부터 사라집니다. */
  function removeTasks(shouldRemove: (task: Task) => boolean, bin: TrashBin): void {
    const removed = tasks.filter(shouldRemove)
    if (removed.some((task) => task.id === focusId)) {
      setFocusId(null)
      resetTimer(DEFAULT_FOCUS_MINUTES)
    }
    setTasks((list) => list.filter((task) => !shouldRemove(task)))
    setTrash((current) => ({ ...current, [bin]: [...current[bin], ...removed].slice(-MAX_TRASH) }))
  }

  /** 목록에 남은 자리만큼 위에서부터 돌려놓습니다. 못 돌아간 일은 기록에 남습니다. */
  function restoreTasks(bin: TrashBin, shouldRestore: (task: Task) => boolean): void {
    const restored = trash[bin].filter(shouldRestore).slice(0, MAX_TASKS - tasks.length)
    setTasks((list) => [...list, ...restored])
    setTrash((current) => ({ ...current, [bin]: current[bin].filter((task) => !restored.includes(task)) }))
  }

  function forgetTasks(bin: TrashBin, shouldForget: (task: Task) => boolean): void {
    setTrash((current) => ({ ...current, [bin]: current[bin].filter((task) => !shouldForget(task)) }))
  }

  function startEdit(id: string): void {
    const task = tasks.find((item) => item.id === id)
    if (task) setEditing({ id, title: task.title })
  }

  /** 비워 두면 이름을 지운 게 아니라 고치다 만 것으로 보고 원래 이름을 둡니다. */
  function saveEdit(): void {
    if (!editing) return
    const title = editing.title.trim()
    if (title !== '') changeTask(editing.id, (task) => ({ ...task, title }))
    setEditing(null)
  }

  function trashBoxProps(bin: TrashBin, title: string): TrashBoxProps {
    return {
      title,
      tasks: trash[bin],
      canRestore: tasks.length < MAX_TASKS,
      onRestore: (id) => restoreTasks(bin, (task) => task.id === id),
      onForget: (id) => forgetTasks(bin, (task) => task.id === id),
      onRestoreAll: () => restoreTasks(bin, () => true),
      onForgetAll: () => forgetTasks(bin, () => true),
    }
  }

  const main = h(
    'div',
    { class: 'board-main' },
    h(Progress, { stats }),
    h(FocusTimer, {
      task: focusTask,
      secondsLeft,
      running,
      sessionMinutes: focusMinutes,
      canFinish: elapsedSeconds() > 0,
      warning: showPickWarning ? pickWarningFor(stats.remaining) : null,
      onToggle: toggleTimer,
      onFinish: finishFocus,
      onReset: () => resetTimer(),
      onAddTime: addTime,
    }),
    h(Composer, {
      draft,
      priority: draftPriority,
      minutes: draftMinutes,
      isFull: tasks.length >= MAX_TASKS,
      onDraft: setDraft,
      onPriority: setDraftPriority,
      onMinutes: setDraftMinutes,
      onSubmit: addTask,
    }),
    h(Toolbar, {
      filter,
      query,
      sortBy,
      hasDone: stats.done > 0,
      onFilter: setFilter,
      onQuery: changeQuery,
      onSort: setSortBy,
      onClearDone: () => removeTasks((task) => task.done, 'cleared'),
      // 상태 세 개를 바꿔도 Batching 덕분에 렌더는 한 번만 일어납니다.
      onResetView() {
        setFilter('all')
        setQuery('')
        setSortBy('created')
      },
    }),
    h(TaskList, {
      tasks: visibleTasks,
      focusId,
      editing,
      isBoardEmpty: tasks.length === 0,
      onStartEdit: startEdit,
      onEditTitle: (title) => setEditing((current) => current && { ...current, title }),
      onSaveEdit: saveEdit,
      onCancelEdit: () => setEditing(null),
      onToggle: (id) => changeTask(id, (task) => ({ ...task, done: !task.done })),
      onCyclePriority: (id) =>
        changeTask(id, (task) => ({
          ...task,
          priority: PRIORITIES[(PRIORITIES.indexOf(task.priority) + 1) % PRIORITIES.length],
        })),
      onPickFocus(id) {
        // 고른 일을 다시 누르면 선택을 취소합니다.
        const isCancel = id === focusId
        setFocusId(isCancel ? null : id)
        setShowPickWarning(false)
        resetTimer(isCancel ? DEFAULT_FOCUS_MINUTES : tasks.find((task) => task.id === id)?.plannedMinutes)
      },
      onRemove: (id) => removeTasks((task) => task.id === id, 'deleted'),
    }),
  )

  return h(
    'div',
    { class: 'board' },
    main,
    h('button', { type: 'button', class: 'quiet-button test-timer', onClick: startTestTimer }, TEST_TIMER_LABEL),
    h(
      'aside',
      { class: 'trash', 'aria-labelledby': 'trash-title' },
      h('h2', { id: 'trash-title' }, '지운 일 기록'),
      h(TrashBox, trashBoxProps('deleted', '삭제한 일')),
      h(TrashBox, trashBoxProps('cleared', '끝낸 일')),
      tasks.length >= MAX_TASKS
        ? h('p', { class: 'trash-note' }, `할 일이 ${MAX_TASKS}개라서 복원할 수 없습니다. 먼저 하나를 지워 주세요.`)
        : null,
    ),
  )
}

function renderPageLayout(): HTMLElement {
  return createDom(
    h(
      'section',
      { class: 'page board-page', 'aria-labelledby': 'board-title' },
      h(
        'header',
        { class: 'page-head' },
        h('h1', { id: 'board-title' }, '오늘 집중할 일'),
        h('p', null, '직접 만든 Hook으로 동작하는 앱입니다. 마지막 렌더 기록에서 다시 그릴 때마다 바뀐 양을 볼 수 있습니다.'),
      ),
      h(
        'div',
        { class: 'board-grid' },
        h('div', { 'data-role': 'board-root' }),
        h(
          'aside',
          { class: 'inspector', 'aria-labelledby': 'inspector-title' },
          h('h2', { id: 'inspector-title' }, '마지막 렌더 기록'),
          h(
            'dl',
            { class: 'metrics' },
            h('div', null, h('dt', null, '렌더 횟수'), h('dd', { 'data-role': 'render-count' }, '0')),
            h('div', null, h('dt', null, 'Diff 연산'), h('dd', { 'data-role': 'patch-count' }, '0')),
            h('div', null, h('dt', null, '실제 DOM 변경'), h('dd', { 'data-role': 'mutation-count' }, '0')),
            h('div', null, h('dt', null, '목록 재계산'), h('dd', { 'data-role': 'memo-count' }, '0')),
          ),
          h('div', { class: 'node-map', 'data-role': 'map', 'aria-hidden': 'true' }),
          h('p', { class: 'map-caption', 'data-role': 'map-caption' }),
          h('ol', { class: 'op-list', 'data-role': 'ops' }),
        ),
      ),
    ),
  ) as HTMLElement
}

/**
 * 렌더 기록은 일부러 컴포넌트 바깥에 있습니다. 렌더 결과를 상태로 보여 주면
 * 그 상태 변경이 또 렌더를 부르는 끝없는 고리가 되기 때문입니다.
 */
export function createTestPage(): HTMLElement {
  const page = renderPageLayout()
  const mount = page.querySelector<HTMLElement>('[data-role="board-root"]')
  if (!mount) throw new Error('앱을 붙일 자리를 찾지 못했습니다.')

  const field = (role: string) => page.querySelector(`[data-role="${role}"]`) as HTMLElement
  const metrics: BoardMetrics = { memoRuns: 0 }
  const touched = new Map<Node, PatchType>()
  const mutations = createMutationCounter(mount)

  function report(commit: Commit): void {
    const changes = domPatches(commit.patches)
    const { total, changed } = renderNodeMap(field('map'), mount as HTMLElement, touched)
    touched.clear()

    field('render-count').textContent = formatCount(commit.renderCount)
    field('patch-count').textContent = String(changes.length)
    field('mutation-count').textContent = String(commit.phase === 'mount' ? 0 : mutations.take())
    field('memo-count').textContent = formatCount(metrics.memoRuns)
    field('map-caption').textContent = `전체 ${total}개 노드 중 ${changed}개를 건드렸습니다.`
    renderPatchList(field('ops'), commit.patches)
  }

  const component = new FunctionComponent(
    FocusBoard,
    { metrics },
    {
      onApply: (patch, node) => recordTouch(touched, patch, node),
      onCommit: report,
    },
  )
  component.mount(mount)
  mutations.take()

  return page
}
