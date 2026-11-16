"""
메모리 기반 B+ 트리 인덱스

- 내부 노드(_Internal): 길 안내용 구분 키(keys)와 자식 노드(children)만 가진다. len(children) == len(keys) + 1
- 리프 노드(_Leaf): 실제 (키, 값) 쌍을 정렬된 순서로 가지고, next 포인터로 오른쪽 리프와 연결된다
- order = 한 노드가 가질 수 있는 최대 자식 수. 한 노드의 키는 최대 order - 1 개

삽입 순서:
    1. 루트에서 시작해 내부 노드의 키와 비교하며 리프까지 내려간다 (지나온 경로를 기억)
    2. 리프 안의 정렬된 위치에 (키, 값)을 넣는다
    3. 리프가 넘치면 반으로 나누고, 오른쪽 리프의 첫 키를 부모에 "복사"해 올린다
    4. 부모(내부 노드)가 넘치면 반으로 나누고, 가운데 키를 그 위 부모로 "이동"시킨다
    5. 루트까지 넘치면 새 루트를 만든다 (트리 높이가 늘어나는 유일한 경우)

키는 서로 비교 가능해야 한다. CSV 의 id 는 문자열이므로 int 로 바꿔서 넣어야
"10" < "9" 같은 문자열 순서로 정렬되지 않는다.
"""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from typing import Any, Iterator

_MISSING = object()


class DuplicateKeyError(KeyError):
    """이미 트리에 있는 키를 다시 삽입하려 할 때"""


class _Leaf:
    __slots__ = ("keys", "values", "next")

    def __init__(self, keys: list | None = None, values: list | None = None, next: _Leaf | None = None):
        self.keys: list = keys if keys is not None else []
        self.values: list = values if values is not None else []
        self.next = next  # 오른쪽 리프 (범위 조회 시 이 연결을 따라간다)


class _Internal:
    __slots__ = ("keys", "children")

    def __init__(self, keys: list, children: list):
        self.keys = keys
        self.children = children  # children[i] 의 키는 모두 keys[i-1] <= k < keys[i]


class BPlusTree:
    def __init__(self, order: int = 32):
        if order < 3:
            raise ValueError("order 는 3 이상이어야 합니다")
        self.order = order
        self.max_keys = order - 1
        self._root: _Leaf | _Internal = _Leaf()
        self._size = 0
        self._height = 1

    # ---- 기본 정보 ----
    def __len__(self) -> int:
        return self._size

    @property
    def height(self) -> int:
        """루트부터 리프까지의 층 수 (리프 하나뿐이면 1)"""
        return self._height

    # ---- 검색 ----
    def _find_leaf(self, key) -> _Leaf:
        node = self._root
        while isinstance(node, _Internal):
            # 구분 키와 같으면 오른쪽으로 간다: 구분 키 = 오른쪽 서브트리의 가장 작은 키
            node = node.children[bisect_right(node.keys, key)]
        return node

    def get(self, key, default=None):
        leaf = self._find_leaf(key)
        i = bisect_left(leaf.keys, key)
        if i < len(leaf.keys) and leaf.keys[i] == key:
            return leaf.values[i]
        return default

    def __getitem__(self, key):
        value = self.get(key, _MISSING)
        if value is _MISSING:
            raise KeyError(key)
        return value

    def __contains__(self, key) -> bool:
        return self.get(key, _MISSING) is not _MISSING

    # ---- 삽입 ----
    def insert(self, key, value) -> None:
        """(key, value)를 넣는다. 이미 있는 키면 DuplicateKeyError (기존 값은 그대로)"""
        # 1. 리프까지 내려가면서 (부모, 내려간 자식 번호)를 기억해 둔다. 분할이 위로 전파될 때 쓴다
        path: list[tuple[_Internal, int]] = []
        node = self._root
        while isinstance(node, _Internal):
            i = bisect_right(node.keys, key)
            path.append((node, i))
            node = node.children[i]
        leaf = node

        # 2. 리프의 정렬된 위치에 넣는다
        i = bisect_left(leaf.keys, key)
        if i < len(leaf.keys) and leaf.keys[i] == key:
            raise DuplicateKeyError(key)
        leaf.keys.insert(i, key)
        leaf.values.insert(i, value)
        self._size += 1
        if len(leaf.keys) <= self.max_keys:
            return

        # 3. 리프 분할 -> 4. 부모가 넘치면 부모도 분할 (루트 방향으로 반복)
        separator, right = self._split_leaf(leaf)
        while path:
            parent, i = path.pop()
            parent.keys.insert(i, separator)
            parent.children.insert(i + 1, right)
            if len(parent.keys) <= self.max_keys:
                return
            separator, right = self._split_internal(parent)

        # 5. 루트까지 분할됐으면 새 루트를 만든다 (왼쪽 자식 = 방금 분할된 기존 루트)
        self._root = _Internal([separator], [self._root, right])
        self._height += 1

    @staticmethod
    def _split_leaf(leaf: _Leaf) -> tuple[Any, _Leaf]:
        """리프를 반으로 나눈다. 오른쪽 첫 키를 부모로 '복사'하므로 그 키는 리프에도 남는다"""
        mid = len(leaf.keys) // 2
        right = _Leaf(leaf.keys[mid:], leaf.values[mid:], leaf.next)
        del leaf.keys[mid:]
        del leaf.values[mid:]
        leaf.next = right
        return right.keys[0], right

    @staticmethod
    def _split_internal(node: _Internal) -> tuple[Any, _Internal]:
        """내부 노드를 반으로 나눈다. 가운데 키는 부모로 '이동'하므로 양쪽 어디에도 남지 않는다"""
        mid = len(node.keys) // 2
        separator = node.keys[mid]
        right = _Internal(node.keys[mid + 1:], node.children[mid + 1:])
        del node.keys[mid:]
        del node.children[mid + 1:]
        return separator, right

    # ---- 순회 / 범위 조회 ----
    def _leftmost_leaf(self) -> _Leaf:
        node = self._root
        while isinstance(node, _Internal):
            node = node.children[0]
        return node

    def items(self) -> Iterator[tuple[Any, Any]]:
        """모든 (키, 값)을 키 오름차순으로. 맨 왼쪽 리프부터 next 연결을 따라간다"""
        leaf = self._leftmost_leaf()
        while leaf is not None:
            yield from zip(leaf.keys, leaf.values)
            leaf = leaf.next

    def __iter__(self) -> Iterator:
        for key, _ in self.items():
            yield key

    def values(self) -> Iterator:
        for _, value in self.items():
            yield value

    def range(self, lo=None, hi=None, *, include_lo: bool = True, include_hi: bool = True) -> Iterator[tuple[Any, Any]]:
        """lo ~ hi 사이의 (키, 값)을 오름차순으로. lo/hi 가 None 이면 그쪽 끝은 제한 없음.

        lo 가 들어 있는 리프를 트리 탐색으로 한 번 찾고, 그 뒤로는 리프 연결만 따라간다.
        """
        if lo is None:
            leaf, i = self._leftmost_leaf(), 0
        else:
            leaf = self._find_leaf(lo)
            i = bisect_left(leaf.keys, lo) if include_lo else bisect_right(leaf.keys, lo)

        while leaf is not None:
            keys = leaf.keys
            while i < len(keys):
                key = keys[i]
                if hi is not None and (key > hi or (key == hi and not include_hi)):
                    return
                yield key, leaf.values[i]
                i += 1
            leaf, i = leaf.next, 0

    def min_key(self):
        """가장 작은 키 (비어 있으면 None)"""
        leaf = self._leftmost_leaf()
        return leaf.keys[0] if leaf.keys else None

    def max_key(self):
        """가장 큰 키 (비어 있으면 None). 자동 증가 id 의 next_id = max_key() + 1 계산에 쓴다"""
        node = self._root
        while isinstance(node, _Internal):
            node = node.children[-1]
        return node.keys[-1] if node.keys else None

    # ---- 디버깅용 ----
    def levels(self) -> list[list[list]]:
        """층별 노드의 키 목록. 예: [[[7]], [[3, 5], [9]], [[1, 2], [3, 4], ...]]"""
        result = []
        level = [self._root]
        while level:
            result.append([list(node.keys) for node in level])
            if isinstance(level[0], _Leaf):
                break
            level = [child for node in level for child in node.children]
        return result
