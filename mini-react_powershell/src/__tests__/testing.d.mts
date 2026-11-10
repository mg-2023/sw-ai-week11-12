// testing.mjs의 타입입니다. 테스트 코드를 tsc로 검사할 때 씁니다.
type Run = () => void | Promise<void>
type CaseArgs<T> = T extends readonly [...infer Values] ? Values : [T]

export function describe(title: string, run: () => void): void
export function beforeEach(run: Run): void
export function afterEach(run: Run): void

export const it: {
  (title: string, run: Run): void
  each<const T>(cases: readonly T[]): (title: string, run: (...args: CaseArgs<T>) => void | Promise<void>) => void
}

export const expect: {
  (actual: unknown): any
  objectContaining(expected: object): any
}

export const vi: {
  fn(implementation?: (...args: any[]) => any): any
  spyOn(target: object, key: string, accessor?: 'get' | 'set'): any
  restoreAllMocks(): void
  useFakeTimers(): void
  useRealTimers(): void
  advanceTimersByTime(milliseconds: number): void
}
