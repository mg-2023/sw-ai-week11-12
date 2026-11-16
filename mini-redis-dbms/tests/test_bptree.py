import math
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from bptree import BPlusTree, DuplicateKeyError, _Internal, _Leaf  # noqa: E402


def check_invariants(test: unittest.TestCase, tree: BPlusTree) -> None:
    """B+ 트리가 지켜야 하는 구조 조건을 전부 검사한다"""
    leaves: list[_Leaf] = []
    leaf_depths: set[int] = set()
    min_leaf_keys = (tree.max_keys + 1) // 2  # 리프 분할 후 왼쪽 리프가 갖는 키 수
    min_children = (tree.order + 1) // 2  # ceil(order / 2)

    def visit(node, depth, lo, hi, is_root):
        test.assertLessEqual(len(node.keys), tree.max_keys, "노드의 키가 최대 개수를 넘음")
        test.assertEqual(node.keys, sorted(node.keys), "노드 안의 키가 정렬되어 있지 않음")
        for k in node.keys:  # 이 서브트리의 키는 모두 lo <= k < hi
            if lo is not None:
                test.assertGreaterEqual(k, lo)
            if hi is not None:
                test.assertLess(k, hi)

        if isinstance(node, _Leaf):
            test.assertEqual(len(node.keys), len(node.values))
            if not is_root:
                test.assertGreaterEqual(len(node.keys), min_leaf_keys, "리프가 절반 미만으로 차 있음")
            leaves.append(node)
            leaf_depths.add(depth)
            return

        test.assertIsInstance(node, _Internal)
        test.assertEqual(len(node.children), len(node.keys) + 1)
        test.assertGreaterEqual(len(node.children), 2 if is_root else min_children, "내부 노드의 자식 수가 너무 적음")
        bounds = [lo, *node.keys, hi]
        for i, child in enumerate(node.children):
            visit(child, depth + 1, bounds[i], bounds[i + 1], False)

    visit(tree._root, 1, None, None, True)

    test.assertEqual(len(leaf_depths), 1, "리프의 깊이가 서로 다름")
    test.assertEqual(leaf_depths.pop(), tree.height)

    # next 연결이 왼쪽 리프부터 오른쪽 리프까지 빠짐없이 순서대로 이어져 있어야 한다
    for left, right in zip(leaves, leaves[1:]):
        test.assertIs(left.next, right)
    test.assertIsNone(leaves[-1].next)
    test.assertEqual(sum(len(leaf.keys) for leaf in leaves), len(tree))


class EmptyTreeTest(unittest.TestCase):
    def test_empty_tree(self):
        tree = BPlusTree(order=4)
        self.assertEqual(len(tree), 0)
        self.assertEqual(tree.height, 1)
        self.assertIsNone(tree.get(1))
        self.assertNotIn(1, tree)
        self.assertEqual(list(tree.items()), [])
        self.assertEqual(list(tree.range(1, 10)), [])
        self.assertIsNone(tree.min_key())
        self.assertIsNone(tree.max_key())
        check_invariants(self, tree)

    def test_order_must_be_at_least_3(self):
        with self.assertRaises(ValueError):
            BPlusTree(order=2)


class SplitShapeTest(unittest.TestCase):
    """order=4 (노드당 키 최대 3개)에서 1, 2, 3, ... 을 차례로 넣을 때의 모양"""

    def build(self, n):
        tree = BPlusTree(order=4)
        for k in range(1, n + 1):
            tree.insert(k, [str(k)])
        return tree

    def test_no_split_until_full(self):
        tree = self.build(3)
        self.assertEqual(tree.levels(), [[[1, 2, 3]]])
        self.assertEqual(tree.height, 1)

    def test_first_leaf_split_creates_root(self):
        # [1,2,3,4] -> [1,2] | [3,4], 오른쪽 첫 키 3이 새 루트로 복사됨
        tree = self.build(4)
        self.assertEqual(tree.levels(), [[[3]], [[1, 2], [3, 4]]])
        self.assertEqual(tree.height, 2)

    def test_leaf_splits_add_separators_to_root(self):
        self.assertEqual(self.build(6).levels(), [[[3, 5]], [[1, 2], [3, 4], [5, 6]]])
        self.assertEqual(self.build(8).levels(), [[[3, 5, 7]], [[1, 2], [3, 4], [5, 6], [7, 8]]])

    def test_internal_split_moves_middle_key_up(self):
        # 루트 [3,5,7,9] 가 넘쳐서 가운데 키 7이 새 루트로 이동 (아래 노드에는 남지 않음)
        tree = self.build(10)
        self.assertEqual(
            tree.levels(),
            [[[7]], [[3, 5], [9]], [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]]],
        )
        self.assertEqual(tree.height, 3)
        check_invariants(self, tree)


class LookupTest(unittest.TestCase):
    def setUp(self):
        self.tree = BPlusTree(order=4)
        self.rows = {i: [str(i), f"user{i}", str(20 + i)] for i in range(1, 21)}
        for key, row in self.rows.items():
            self.tree.insert(key, row)

    def test_get_returns_stored_row(self):
        for key, row in self.rows.items():
            self.assertIs(self.tree.get(key), row)
            self.assertIs(self.tree[key], row)
            self.assertIn(key, self.tree)

    def test_missing_key(self):
        self.assertIsNone(self.tree.get(0))
        self.assertEqual(self.tree.get(99, "없음"), "없음")
        self.assertNotIn(21, self.tree)
        with self.assertRaises(KeyError):
            self.tree[21]

    def test_separator_keys_are_found(self):
        # 내부 노드에 구분 키로 복사된 키도 리프에서 찾아야 한다
        separators = [k for level in self.tree.levels()[:-1] for node in level for k in node]
        self.assertTrue(separators)
        for key in separators:
            self.assertEqual(self.tree.get(key), self.rows[key])

    def test_falsy_value_is_found(self):
        tree = BPlusTree(order=4)
        tree.insert(1, None)
        tree.insert(2, 0)
        self.assertIn(1, tree)
        self.assertIsNone(tree[1])
        self.assertEqual(tree[2], 0)

    def test_duplicate_key_is_rejected(self):
        with self.assertRaises(DuplicateKeyError):
            self.tree.insert(5, ["다른 행"])
        self.assertEqual(self.tree.get(5), self.rows[5])  # 기존 값 유지
        self.assertEqual(len(self.tree), 20)
        check_invariants(self, self.tree)

    def test_min_max_key(self):
        self.assertEqual(self.tree.min_key(), 1)
        self.assertEqual(self.tree.max_key(), 20)


class RangeTest(unittest.TestCase):
    def setUp(self):
        self.tree = BPlusTree(order=4)
        for k in range(2, 41, 2):  # 짝수 2 ~ 40
            self.tree.insert(k, f"row{k}")

    def keys(self, *args, **kwargs):
        return [k for k, _ in self.tree.range(*args, **kwargs)]

    def test_inclusive_range_across_leaves(self):
        self.assertEqual(self.keys(10, 20), [10, 12, 14, 16, 18, 20])

    def test_exclusive_bounds(self):
        self.assertEqual(self.keys(10, 20, include_lo=False, include_hi=False), [12, 14, 16, 18])

    def test_bounds_not_in_tree(self):
        self.assertEqual(self.keys(9, 15), [10, 12, 14])
        self.assertEqual(self.keys(11, 11), [])

    def test_open_ends(self):
        self.assertEqual(self.keys(hi=6), [2, 4, 6])
        self.assertEqual(self.keys(lo=36), [36, 38, 40])
        self.assertEqual(self.keys(), list(range(2, 41, 2)))

    def test_out_of_range(self):
        self.assertEqual(self.keys(41, 100), [])
        self.assertEqual(self.keys(-5, 1), [])
        self.assertEqual(self.keys(30, 10), [])

    def test_range_returns_values(self):
        self.assertEqual(list(self.tree.range(4, 6)), [(4, "row4"), (6, "row6")])


class BulkInsertTest(unittest.TestCase):
    def test_random_order_insert(self):
        rng = random.Random(42)
        for order in (3, 4, 5, 8, 32):
            with self.subTest(order=order):
                keys = list(range(1, 501))
                rng.shuffle(keys)
                tree = BPlusTree(order=order)
                for i, k in enumerate(keys, start=1):
                    tree.insert(k, k * 10)
                    if i % 50 == 0:  # 중간 상태도 검사
                        check_invariants(self, tree)

                check_invariants(self, tree)
                self.assertEqual(len(tree), 500)
                self.assertEqual(list(tree), list(range(1, 501)))
                self.assertEqual(list(tree.values()), [k * 10 for k in range(1, 501)])
                for k in keys:
                    self.assertEqual(tree.get(k), k * 10)

    def test_sequential_insert_like_auto_increment(self):
        # 자동 증가 id 처럼 항상 맨 오른쪽 리프에 들어가는 경우
        n, order = 10_000, 4
        tree = BPlusTree(order=order)
        for k in range(1, n + 1):
            tree.insert(k, [str(k)])
        check_invariants(self, tree)
        self.assertEqual(tree.max_key(), n)
        self.assertEqual(tree.get(1), ["1"])
        self.assertEqual(tree.get(n), [str(n)])
        self.assertEqual(tree.get(n // 2), [str(n // 2)])

        # 높이는 log 로만 늘어난다: 노드마다 자식이 최소 ceil(order/2) 개
        max_height = math.ceil(math.log(n, math.ceil(order / 2))) + 1
        self.assertLessEqual(tree.height, max_height)

    def test_reverse_order_insert(self):
        tree = BPlusTree(order=4)
        for k in range(200, 0, -1):
            tree.insert(k, str(k))
        check_invariants(self, tree)
        self.assertEqual(list(tree), list(range(1, 201)))
        self.assertEqual(tree.min_key(), 1)

    def test_string_keys(self):
        tree = BPlusTree(order=3)
        words = ["delta", "alpha", "echo", "charlie", "bravo", "golf", "foxtrot"]
        for w in words:
            tree.insert(w, w.upper())
        check_invariants(self, tree)
        self.assertEqual(list(tree), sorted(words))
        self.assertEqual(tree["echo"], "ECHO")


if __name__ == "__main__":
    unittest.main()
