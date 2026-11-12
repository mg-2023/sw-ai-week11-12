import hashlib

FNV_64_PRIME = 0x00000100000001b3
FNV_64_BASIS = 0xcbf29ce484222325
FNV_64_MASKS = 0xffffffffffffffff

class HashTable:
    def __init__(self, capacity=8):
        self._buckets = [[] for _ in range(capacity)]   # 체이닝 방식
        self._size = 0

    def _index(self, key: str) -> int:
        return self._hash(key) % len(self._buckets)     # 키 → 버킷 번호
                
    def _hash(self, key: str) -> int:
        # FNV-1a 64-bit
        h = FNV_64_BASIS                          # offset basis
        for b in key.encode("utf-8"):
            h ^= b                                # 먼저 XOR
            h = (h * FNV_64_PRIME) & FNV_64_MASKS # 그다음 곱셈 (FNV-1과 순서가 반대)
        return h

    def _resize(self):
        old_buckets = self._buckets
        self._buckets = [[] for _ in range(len(old_buckets) * 2)]
        for bucket in old_buckets:          # 모든 버킷을
            for key, value in bucket:       # 모든 엔트리에 대해
                self._buckets[self._index(key)].append((key, value))
        # _size는 바뀌지 않음 (키 개수는 그대로)
    
    def get(self, key):
        bucket = self._buckets[self._index(key)]
        for (k, v) in bucket:
            if k == key:
                return v
        return None
        
    def put(self, key, value):
        bucket = self._buckets[self._index(key)]
        for i, (k, _) in enumerate(bucket):
            if k == key:                 # 이미 있는 키면 덮어쓰기
                bucket[i] = (key, value)
                return
        bucket.append((key, value))      # 없으면 추가 (충돌이 나도 같은 버킷 리스트에 붙음)
        self._size += 1
        if self._size / len(self._buckets) > 0.75:
            self._resize()               # 부하율이 넘으면 버킷 수를 2배로 늘리고 재배치
    
    def delete(self, key):
        bucket = self._buckets[self._index(key)]
        for i, (k, _) in enumerate(bucket):
            if k == key:
                bucket.pop(i)
                self._size -= 1
                return True
        return False

    def __contains__(self, key) -> bool:
        # get()은 "키 없음"과 "값이 None"을 구분 못 하므로 존재 여부는 따로 확인
        bucket = self._buckets[self._index(key)]
        return any(k == key for k, _ in bucket)

    def __len__(self) -> int:
        return self._size

    def items(self) -> list:
        # 순회 도중 삭제해도 안전하도록 복사본(list)을 반환
        return [(k, v) for bucket in self._buckets for k, v in bucket]

    def keys(self) -> list:
        return [k for k, _ in self.items()]

    def clear(self):
        self._buckets = [[] for _ in range(len(self._buckets))]
        self._size = 0
    