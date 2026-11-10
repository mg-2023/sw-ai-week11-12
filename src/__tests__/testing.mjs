// 테스트 프레임워크 없이 Node에 내장된 node:test로 돌리기 위한 작은 도구입니다.
// 테스트 파일은 여기서 describe, it, expect, vi를 가져다 씁니다.
import assert from 'node:assert/strict'
import { describe, it as nodeIt, beforeEach, afterEach, mock } from 'node:test'
import { JSDOM } from 'jsdom'

/* 브라우저 대신 쓸 jsdom의 값을 전역에 올립니다. */

const { window } = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:3000/',
  pretendToBeVisual: true,
})

// Node에도 같은 이름이 있지만 jsdom 요소와 함께 쓰려면 jsdom 쪽 값이어야 합니다.
const OVERRIDDEN_GLOBALS = [
  'Event', 'EventTarget', 'CustomEvent', 'DOMException', 'Storage', 'localStorage', 'sessionStorage', 'navigator',
]

for (const key of Object.getOwnPropertyNames(window)) {
  if (key in globalThis && !OVERRIDDEN_GLOBALS.includes(key)) continue
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}

globalThis.window = window
globalThis.document = window.document

/* 값 비교 */

class ObjectContaining {
  constructor(expected) {
    this.expected = expected
  }
}

const isPlainObject = (value) => {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function matchesPartial(actual, expected) {
  if (expected instanceof ObjectContaining) return matchesPartial(actual, expected.expected)
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => matchesPartial(actual[index], item))
  }
  if (isPlainObject(expected)) {
    if (typeof actual !== 'object' || actual === null) return false
    return Object.keys(expected).every((key) => matchesPartial(actual[key], expected[key]))
  }
  return Object.is(actual, expected)
}

function equals(actual, expected) {
  if (expected instanceof ObjectContaining) return matchesPartial(actual, expected.expected)
  if (Object.is(actual, expected)) return true
  if (actual instanceof Set && expected instanceof Set) {
    return actual.size === expected.size && [...actual].every((item) => expected.has(item))
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.length === expected.length && actual.every((item, index) => equals(item, expected[index]))
  }
  if (isPlainObject(actual) && isPlainObject(expected)) {
    // 값이 undefined인 속성은 없는 것과 같게 봅니다.
    const keys = new Set([...Object.keys(actual), ...Object.keys(expected)])
    return [...keys].every((key) => equals(actual[key], expected[key]))
  }
  return false
}

const show = (value) => {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function thrownBy(run) {
  try {
    run()
  } catch (error) {
    return { error }
  }
  return null
}

function matchesError(error, expected) {
  if (expected === undefined) return true
  if (typeof expected === 'string') return String(error?.message).includes(expected)
  if (expected instanceof RegExp) return expected.test(String(error?.message))
  return error instanceof expected
}

const MATCHERS = {
  toBe: (actual, expected) => Object.is(actual, expected),
  toEqual: equals,
  toMatchObject: matchesPartial,
  toContain: (actual, item) => (typeof actual === 'string' ? actual.includes(item) : [...actual].includes(item)),
  toHaveLength: (actual, length) => actual.length === length,
  toHaveProperty: (actual, key) => actual !== null && actual !== undefined && key in Object(actual),
  toBeNull: (actual) => actual === null,
  toBeUndefined: (actual) => actual === undefined,
  toBeDefined: (actual) => actual !== undefined,
  toBeLessThan: (actual, limit) => actual < limit,
  toBeLessThanOrEqual: (actual, limit) => actual <= limit,
  toThrow(actual, expected) {
    const thrown = thrownBy(actual)
    return thrown !== null && matchesError(thrown.error, expected)
  },
  toHaveBeenCalled: (actual) => actual.mock.calls.length > 0,
  toHaveBeenCalledOnce: (actual) => actual.mock.calls.length === 1,
  toHaveBeenCalledTimes: (actual, times) => actual.mock.calls.length === times,
  toHaveBeenCalledWith: (actual, ...args) => actual.mock.calls.some((call) => equals(call, args)),
  toHaveBeenLastCalledWith: (actual, ...args) => equals(actual.mock.calls.at(-1), args),
  toHaveBeenCalledExactlyOnceWith: (actual, ...args) => actual.mock.calls.length === 1 && equals(actual.mock.calls[0], args),
}

function buildMatchers(actual, negated) {
  const matchers = {}
  for (const [name, check] of Object.entries(MATCHERS)) {
    matchers[name] = (...expected) => {
      if (check(actual, ...expected) === negated) {
        assert.fail(`expect(${show(actual)})${negated ? '.not' : ''}.${name}(${expected.map(show).join(', ')})`)
      }
    }
  }
  return matchers
}

export function expect(actual) {
  return { ...buildMatchers(actual, false), not: buildMatchers(actual, true) }
}

expect.objectContaining = (expected) => new ObjectContaining(expected)

/* 함수 호출 기록과 가짜 타이머 */

const restorers = new Set()

function createMock(implementation = () => undefined) {
  let current = implementation

  function fake(...args) {
    fake.mock.calls.push(args)
    fake.mock.contexts.push(this)
    return current.apply(this, args)
  }

  fake.mock = { calls: [], contexts: [] }
  fake.mockClear = () => {
    fake.mock.calls.length = 0
    fake.mock.contexts.length = 0
    return fake
  }
  fake.mockImplementation = (next) => {
    current = next
    return fake
  }
  fake.mockReturnValue = (value) => fake.mockImplementation(() => value)
  fake.mockResolvedValue = (value) => fake.mockImplementation(() => Promise.resolve(value))
  fake.mockRejectedValue = (error) => fake.mockImplementation(() => Promise.reject(error))
  fake.mockRestore = () => {}
  return fake
}

function findDescriptor(target, key) {
  for (let owner = target; owner; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)
    if (descriptor) return descriptor
  }
  return undefined
}

function spyOn(target, key, accessor) {
  const hadOwn = Object.hasOwn(target, key)
  const original = findDescriptor(target, key)
  const slot = accessor ?? 'value'
  const spy = createMock(function callOriginal(...args) {
    return original[slot].apply(this, args)
  })

  Object.defineProperty(target, key, { ...original, [slot]: spy, configurable: true })

  const restore = () => {
    restorers.delete(restore)
    if (hadOwn) Object.defineProperty(target, key, original)
    else delete target[key]
  }
  spy.mockRestore = restore
  restorers.add(restore)
  return spy
}

export const vi = {
  fn: createMock,
  spyOn,
  restoreAllMocks() {
    for (const restore of [...restorers]) restore()
  },
  useFakeTimers() {
    mock.timers.reset()
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })

    // Node의 가짜 타이머는 시간 없이 부른 setTimeout을 실행하지 않아서 0을 채워 줍니다.
    const fakeSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = (run, delay = 0, ...args) => fakeSetTimeout(run, delay, ...args)
  },
  useRealTimers() {
    mock.timers.reset()
  },
  advanceTimersByTime(milliseconds) {
    mock.timers.tick(milliseconds)
  },
}

/* 같은 테스트를 값만 바꿔 돌리는 it.each */

function formatTitle(title, values) {
  let index = 0
  return title.replace(/%s/g, () => String(values[index++]))
}

export const it = Object.assign((title, run) => nodeIt(title, run), {
  each: (cases) => (title, run) => {
    for (const item of cases) {
      const values = Array.isArray(item) ? item : [item]
      nodeIt(formatTitle(title, values), () => run(...values))
    }
  },
})

export { describe, beforeEach, afterEach }
