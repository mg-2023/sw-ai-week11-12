const DEFAULT_LIMIT = 100

/**
 * 뒤로가기·앞으로가기를 위한 기록입니다.
 * 배열 하나와 현재 위치를 가리키는 cursor로 만듭니다. 트리는 고치지 않고 교체만 하므로
 * 복사 없이 참조만 저장해도 과거 기록이 변하지 않습니다.
 */
export class VdomHistory<T> {
  private entries: T[]
  private cursor = 0
  private readonly limit: number

  constructor(initial: T, limit: number = DEFAULT_LIMIT) {
    this.entries = [initial]
    this.limit = Math.max(1, limit)
  }

  get current(): T {
    return this.entries[this.cursor]
  }

  get position(): number {
    return this.cursor
  }

  get size(): number {
    return this.entries.length
  }

  get canBack(): boolean {
    return this.cursor > 0
  }

  get canForward(): boolean {
    return this.cursor < this.entries.length - 1
  }

  /** 과거로 돌아간 뒤 새로 저장하면, 앞쪽 미래 기록은 버립니다. 브라우저 방문 기록과 같습니다. */
  push(entry: T): void {
    this.entries = this.entries.slice(0, this.cursor + 1)
    this.entries.push(entry)
    if (this.entries.length > this.limit) this.entries.shift()
    this.cursor = this.entries.length - 1
  }

  back(): T | null {
    return this.go(this.cursor - 1)
  }

  forward(): T | null {
    return this.go(this.cursor + 1)
  }

  /** 범위 밖이면 움직이지 않고 null을 돌려줍니다. */
  go(index: number): T | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.entries.length) return null
    this.cursor = index
    return this.entries[index]
  }
}
