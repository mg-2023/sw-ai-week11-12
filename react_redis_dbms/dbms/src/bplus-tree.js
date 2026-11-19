/* ======================================================================
 * bplus-tree.js — 메모리 기반 B+ 트리 (key: 숫자, value: 아무 값)
 *
 *   실제 DBMS 는 노드 하나를 디스크 블록 하나에 저장한다. 여기서는 노드를 메모리의 객체로 둔 단순화 버전이다.
 *
 *   노드
 *     내부 노드 : { leaf: false, keys: [k0, k1 …], children: [c0, c1, c2 …] }      길 안내만 한다 (값이 없다)
 *                   children[i] 에는 keys[i-1] 이상 keys[i] 미만인 키가 들어 있다
 *     리프 노드 : { leaf: true,  keys: [k0, k1 …], values: [v0, v1 …], next }        실제 값은 전부 여기에 있다
 *                   next 로 오른쪽 리프와 이어져 있다 → 범위 검색은 리프만 따라가면 된다
 *
 *   규칙
 *     - 노드 안의 키는 항상 정렬돼 있다
 *     - 노드 하나에 키는 최대 order - 1 개. 넘치면 반으로 쪼개고(split) 가운데 키를 부모로 올린다
 *     - 쪼개기가 루트까지 올라가면 새 루트가 생겨 높이가 1 늘어난다 → 모든 리프의 깊이가 항상 같다
 *
 *   검색: 루트에서 리프까지 한 층씩 내려간다. 100만 건이어도 order 64 면 4층이다. → O(log n)
 *
 *   삭제는 구현하지 않았다 (DELETE 문이 없다). 이 모듈은 다른 모듈에 의존하지 않는다.
 * ====================================================================== */

/** 정렬된 keys 에서 key 이상인 첫 위치 (이진 탐색) */
function lowerBound(keys, key) {
  let lo = 0, hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] < key) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** 내부 노드에서 key 가 들어 있을 자식의 번호: key 보다 큰 첫 키의 위치 */
function childIndex(keys, key) {
  let lo = 0, hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] <= key) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export class BPlusTree {
  /** order: 내부 노드 하나가 가질 수 있는 자식의 최대 수 (= 키는 최대 order - 1 개) */
  constructor(order = 64) {
    if (!Number.isInteger(order) || order < 3) throw new Error('order 는 3 이상의 정수여야 합니다');
    this.order = order;
    this.root = { leaf: true, keys: [], values: [], next: null };
    this.size = 0;       // 저장된 키 수
    this.height = 1;     // 루트에서 리프까지의 층 수
  }

  /** key 가 들어 있을(또는 들어갈) 리프를 찾는다 */
  findLeaf(key) {
    let node = this.root;
    while (!node.leaf) node = node.children[childIndex(node.keys, key)];
    return node;
  }

  /** key 의 값. 없으면 undefined */
  search(key) {
    const leaf = this.findLeaf(key);
    const i = lowerBound(leaf.keys, key);
    return leaf.keys[i] === key ? leaf.values[i] : undefined;
  }

  has(key) {
    return this.search(key) !== undefined;
  }

  /** key 를 넣는다. 이미 있는 key 면 값만 바꾼다 */
  insert(key, value) {
    const split = this.insertInto(this.root, key, value);
    if (split) {                                             // 루트가 쪼개졌다 → 새 루트를 만든다 (높이 +1)
      this.root = { leaf: false, keys: [split.key], children: [this.root, split.right] };
      this.height++;
    }
  }

  /** node 아래에 key 를 넣는다. node 가 쪼개졌으면 { key: 부모로 올릴 키, right: 새 오른쪽 노드 } 를 돌려준다 */
  insertInto(node, key, value) {
    if (node.leaf) {
      const i = lowerBound(node.keys, key);
      if (node.keys[i] === key) { node.values[i] = value; return null; }
      node.keys.splice(i, 0, key);
      node.values.splice(i, 0, value);
      this.size++;
      return node.keys.length >= this.order ? this.splitLeaf(node) : null;
    }
    const i = childIndex(node.keys, key);
    const split = this.insertInto(node.children[i], key, value);
    if (!split) return null;
    node.keys.splice(i, 0, split.key);                       // 자식이 쪼개졌다 → 올라온 키와 새 자식을 끼워 넣는다
    node.children.splice(i + 1, 0, split.right);
    return node.keys.length >= this.order ? this.splitInternal(node) : null;
  }

  /** 리프를 반으로 쪼갠다. 오른쪽 리프의 첫 키를 부모로 "복사"해 올린다 (리프에도 그대로 남는다) */
  splitLeaf(leaf) {
    const mid = leaf.keys.length >> 1;
    const right = { leaf: true, keys: leaf.keys.splice(mid), values: leaf.values.splice(mid), next: leaf.next };
    leaf.next = right;
    return { key: right.keys[0], right };
  }

  /** 내부 노드를 반으로 쪼갠다. 가운데 키는 부모로 "이동"한다 (이 노드에는 남지 않는다) */
  splitInternal(node) {
    const mid = node.keys.length >> 1;
    const upKey = node.keys[mid];
    const right = { leaf: false, keys: node.keys.splice(mid + 1), children: node.children.splice(mid + 1) };
    node.keys.pop();                                         // 올려 보낸 가운데 키를 지운다
    return { key: upKey, right };
  }

  /** from 이상 to 이하인 [key, value] 를 키 순서대로 내보낸다. 시작 리프를 찾은 뒤 next 를 따라 옆으로 이동한다 */
  *range(from = -Infinity, to = Infinity) {
    let leaf = this.findLeaf(from);
    let i = lowerBound(leaf.keys, from);
    while (leaf) {
      for (; i < leaf.keys.length; i++) {
        if (leaf.keys[i] > to) return;
        yield [leaf.keys[i], leaf.values[i]];
      }
      leaf = leaf.next;
      i = 0;
    }
  }

  /** 가장 큰 키. 비어 있으면 undefined (다음 자동 ID 를 정할 때 쓴다) */
  maxKey() {
    let node = this.root;
    while (!node.leaf) node = node.children[node.children.length - 1];
    return node.keys[node.keys.length - 1];
  }

  /**
   * 트리가 B+ 트리의 규칙을 지키는지 검사한다 (테스트용). 어기면 예외를 던진다.
   *   키 정렬 · 노드당 키 수 · 자식 수 = 키 수 + 1 · 모든 리프의 깊이가 같음 · 자식의 키 범위 · 리프 연결 순서
   */
  validate() {
    const leaves = [];
    const check = (node, depth, min, max) => {
      for (let i = 1; i < node.keys.length; i++) if (node.keys[i - 1] >= node.keys[i]) throw new Error('키가 정렬돼 있지 않습니다');
      if (node.keys.length >= this.order) throw new Error('노드에 키가 너무 많습니다');
      for (const key of node.keys) if (key < min || key >= max) throw new Error('키가 부모가 정한 범위를 벗어났습니다');
      if (node.leaf) {
        if (depth !== this.height) throw new Error('리프의 깊이가 다릅니다');
        if (node.values.length !== node.keys.length) throw new Error('키와 값의 개수가 다릅니다');
        leaves.push(node);
        return;
      }
      if (node.keys.length === 0) throw new Error('내부 노드에 키가 없습니다');
      if (node.children.length !== node.keys.length + 1) throw new Error('자식 수가 키 수 + 1 이 아닙니다');
      node.children.forEach((child, i) => check(child, depth + 1, i === 0 ? min : node.keys[i - 1], i === node.keys.length ? max : node.keys[i]));
    };
    check(this.root, 1, -Infinity, Infinity);
    for (let i = 0; i < leaves.length; i++) {
      if (leaves[i].next !== (leaves[i + 1] ?? null)) throw new Error('리프의 next 연결이 순서와 다릅니다');
    }
    const total = leaves.reduce((sum, leaf) => sum + leaf.keys.length, 0);
    if (total !== this.size) throw new Error('size 가 실제 키 수와 다릅니다');
    return true;
  }
}
