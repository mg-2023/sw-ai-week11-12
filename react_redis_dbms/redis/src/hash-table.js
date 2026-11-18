/* ======================================================================
 * hash-table.js — 직접 구현한 해시 테이블 (분리 연결법, Separate Chaining)
 *
 *   구조
 *     buckets : 길이가 capacity 인 배열. 각 칸(버킷)은 노드 연결 리스트의 머리(head) 또는 null
 *     노드    : { key, value, next }
 *
 *   키로 값을 찾는 과정
 *     ① hashString(key)          문자열 → 32비트 정수 (FNV-1a)
 *     ② 정수 & (capacity - 1)    → 버킷 번호 (capacity 가 2의 거듭제곱이라 나머지 연산과 같다)
 *     ③ 그 버킷의 연결 리스트를 따라가며 key 가 같은 노드를 찾는다
 *
 *   충돌     : 서로 다른 키가 같은 버킷에 들어오는 것. 같은 버킷의 노드를 next 로 이어서 해결한다.
 *   리사이즈 : 노드 수 / capacity (적재율) 가 0.75 를 넘으면 capacity 를 2배로 늘리고 모든 노드를 다시 배치한다.
 *              → 연결 리스트가 길어지지 않으므로 조회·저장·삭제가 평균 O(1) 로 유지된다.
 *              많이 지워져 적재율이 0.125 아래로 내려가면 절반으로 줄인다.
 *
 *   Map / Object 를 저장소로 쓰지 않는다. 이 모듈은 다른 모듈에 의존하지 않는다.
 * ====================================================================== */

const MIN_CAPACITY = 16;
const GROW_AT = 0.75;      // 적재율이 이 값을 넘으면 2배로
const SHRINK_AT = 0.125;   // 적재율이 이 값보다 작아지면 절반으로

/** FNV-1a: 글자마다 XOR 한 뒤 소수(16777619)를 곱한다. 비슷한 키도 서로 먼 숫자가 된다 */
export function hashString(key) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);    // 32비트 정수 곱셈
  }
  return hash >>> 0;                        // 부호 없는 정수로
}

/** n 이상인 가장 작은 2의 거듭제곱 */
const powerOfTwo = (n) => { let c = MIN_CAPACITY; while (c < n) c *= 2; return c; };

export class HashTable {
  constructor(capacity = MIN_CAPACITY) {
    this.capacity = powerOfTwo(capacity);
    this.buckets = new Array(this.capacity).fill(null);
    this.size = 0;                          // 저장된 노드 수
  }

  /** key 가 들어갈 버킷 번호 */
  bucketIndex(key) {
    return hashString(key) & (this.capacity - 1);
  }

  /** 버킷의 연결 리스트에서 key 가 같은 노드를 찾는다. 없으면 null */
  findNode(key) {
    for (let node = this.buckets[this.bucketIndex(key)]; node !== null; node = node.next) {
      if (node.key === key) return node;
    }
    return null;
  }

  /** 저장. 이미 있는 키면 값만 바꾼다. 새 키였으면 true */
  set(key, value) {
    const node = this.findNode(key);
    if (node) { node.value = value; return false; }
    const i = this.bucketIndex(key);
    this.buckets[i] = { key, value, next: this.buckets[i] };   // 리스트 맨 앞에 끼워 넣는다
    this.size++;
    if (this.size > this.capacity * GROW_AT) this.resize(this.capacity * 2);
    return true;
  }

  /** 조회. 없으면 undefined */
  get(key) {
    const node = this.findNode(key);
    return node ? node.value : undefined;
  }

  has(key) {
    return this.findNode(key) !== null;
  }

  /** 삭제. 지웠으면 true */
  delete(key) {
    const i = this.bucketIndex(key);
    let prev = null;
    for (let node = this.buckets[i]; node !== null; prev = node, node = node.next) {
      if (node.key !== key) continue;
      if (prev) prev.next = node.next;      // 중간·끝 노드: 앞 노드가 다음 노드를 가리키게 한다
      else this.buckets[i] = node.next;     // 머리 노드: 버킷이 다음 노드를 가리키게 한다
      this.size--;
      if (this.capacity > MIN_CAPACITY && this.size < this.capacity * SHRINK_AT) this.resize(this.capacity / 2);
      return true;
    }
    return false;
  }

  clear() {
    this.capacity = MIN_CAPACITY;
    this.buckets = new Array(this.capacity).fill(null);
    this.size = 0;
  }

  /** 버킷 수를 바꾸고 모든 노드를 새 버킷 번호로 다시 배치한다 (rehash) */
  resize(newCapacity) {
    const old = this.buckets;
    this.capacity = newCapacity;
    this.buckets = new Array(newCapacity).fill(null);
    for (let head of old) {
      while (head !== null) {
        const next = head.next;
        const i = this.bucketIndex(head.key);
        head.next = this.buckets[i];
        this.buckets[i] = head;
        head = next;
      }
    }
  }

  /** 모든 [key, value] 를 차례로 내보낸다 */
  *entries() {
    for (const head of this.buckets) {
      for (let node = head; node !== null; node = node.next) yield [node.key, node.value];
    }
  }

  keys() {
    const out = [];
    for (const [key] of this.entries()) out.push(key);
    return out;
  }

  /**
   * cursor 번 버킷부터 [key, value] 를 count 개쯤 모아 돌려준다 (버킷 하나는 끝까지 읽는다).
   * 반환: { cursor: 다음에 이어서 읽을 버킷 번호 (0 이면 한 바퀴를 다 돌았다), entries }
   * 전체를 한 번에 훑지 않고 조금씩 나눠 볼 때 쓴다. (만료 키 청소)
   */
  scan(cursor, count) {
    const entries = [];
    let i = cursor < this.capacity ? cursor : 0;
    while (i < this.capacity && entries.length < count) {
      for (let node = this.buckets[i]; node !== null; node = node.next) entries.push([node.key, node.value]);
      i++;
    }
    return { cursor: i >= this.capacity ? 0 : i, entries };
  }

  /** 상태 요약: 버킷 수, 노드 수, 적재율, 가장 긴 연결 리스트 길이 */
  stats() {
    let longest = 0, used = 0;
    for (const head of this.buckets) {
      let len = 0;
      for (let node = head; node !== null; node = node.next) len++;
      if (len > 0) used++;
      if (len > longest) longest = len;
    }
    return { capacity: this.capacity, size: this.size, loadFactor: this.size / this.capacity, usedBuckets: used, longestChain: longest };
  }
}
