export type Deps = readonly unknown[]

/** deps 배열이 없으면 항상 바뀐 것으로 봅니다. 값은 Object.is로 얕게 비교합니다. */
export function depsChanged(previous: Deps | undefined, next: Deps | undefined): boolean {
  if (!previous || !next || previous.length !== next.length) return true
  return next.some((value, index) => !Object.is(value, previous[index]))
}
