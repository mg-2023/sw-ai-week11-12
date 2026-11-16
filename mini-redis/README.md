# Mini Redis
원래 C로 구현된 Redis 시스템을 파이썬으로 구현한 폴더

## Hash Table (app/hashtable.py)
Redis 저장소의 기본이 되는 해시 테이블 자료구조 클래스

### 해시 알고리즘
KAIST 버전 Pintos에서 사용했던 FNV-1 알고리즘에서 곱 연산과 XOR 연산의 순서만 바뀐 **FNV-1a** 알고리즘

그러나 파이썬 언어로 구현되었기 때문에, CPython으로 구현된 SHA-256보다 속도가 다소 느림

## 레디스 저장소 (app/store.py)
(여기에 상세정보 입력)

## 실제 API 구동기 (app/main.py)
(여기에 상세정보 입력)
