# Mini Redis
원래 C로 구현된 Redis 시스템을 파이썬으로 구현한 폴더

## Hash Table (app/hashtable.py)
Redis 저장소의 기본이 되는 해시 테이블 자료구조 클래스

### 해시 알고리즘
KAIST 버전 Pintos에서 사용했던 FNV-1 알고리즘에서 곱 연산과 XOR 연산의 순서만 바뀐 **FNV-1a** 알고리즘

그러나 파이썬 언어로 구현되었기 때문에, CPython으로 구현된 SHA-256보다 속도가 다소 느림

## 레디스 저장소 (app/store.py)
해시 테이블 두 개(값 저장용, 만료 시각 저장용)로 Redis의 문자열 명령을 구현한 저장소 클래스 `RedisStore`

### 지원 명령
- 기본: `SET`(EX / NX / XX 옵션), `GET`, `DEL`, `EXISTS`
- TTL: `EXPIRE`, `TTL`, `PERSIST`
- 증감: `INCR`, `DECR` (64비트 정수 범위 검사, 오류 메시지는 Redis와 동일)
- 관리: `KEYS`, `DBSIZE`, `FLUSHALL`

### 만료(TTL) 처리
- **지연 삭제**: 키를 조회하는 순간 만료됐으면 지우고 없는 키로 취급
- **능동 삭제**: 백그라운드 스레드가 TTL 키 20개를 무작위로 검사해, 25% 이상 만료돼 있으면 한 라운드 더 반복 (Redis의 active expire 방식)

### 동시성
모든 명령을 `threading.Lock` 하나로 보호하기 때문에, `INCR`처럼 읽고 쓰는 명령도 동시 요청에서 값이 유실되지 않음

`app/store2.py`는 같은 API를 **asyncio 큐 + 워커 하나**로 처리하는 버전으로, 요청이 들어온 순서대로 처리되고 큐가 가득 차면 `QueueFullError`로 거부함

## 실제 API 구동기 (app/main.py)
`RedisStore`를 HTTP API로 노출하는 FastAPI 서버로, Redis 규칙 판단은 저장소에 맡기고 요청 → 저장소 호출 → JSON 응답 변환만 담당

### 실행
```bash
python app/main.py
```
- 웹 페이지: http://127.0.0.1:8000
- API 문서: http://127.0.0.1:8000/docs

### 엔드포인트
| 명령 | 메서드 / 경로 |
|---|---|
| SET / GET / DEL | `PUT` / `GET` / `DELETE` `/keys/{key}` |
| EXISTS | `GET /keys/{key}/exists` |
| EXPIRE / TTL / PERSIST | `POST /keys/{key}/expire`, `GET /keys/{key}/ttl`, `POST /keys/{key}/persist` |
| INCR / DECR | `POST /keys/{key}/incr`, `POST /keys/{key}/decr` |
| KEYS / DBSIZE / FLUSHALL | `GET /keys`, `GET /dbsize`, `POST /flushall` |

### 오류 응답
- 없는 키 조회: 404
- 잘못된 값 (예: 정수가 아닌 값에 `INCR`): 400
- 대기열 초과 (`store2` 사용 시): 503 + `Retry-After` 헤더

# Mini DBMS

Redis를 캐시로 앞에 두기 위한, CSV 파일 기반의 간단한 DBMS

## SQL 처리기 (app/sqlparser.py)
텍스트 파일(.txt)에 적힌 SQL을 읽어 `data/<테이블명>.csv` 테이블에 실행한다.

- 지원 명령어: `CREATE TABLE`, `INSERT`, `SELECT`
- CSV 첫 줄은 컬럼 이름(헤더)으로, `CREATE TABLE`에서 지정한 이름이 들어감
- 처리 순서: Tokenizer(토큰 분리) → Parser(구문 트리 생성) → Executor(CSV 읽기/쓰기)

```bash
# sql/ 디렉토리에 sample.txt를 만들었다고 가정
python app/sqlparser.py sql/sample.txt
python app/sqlparser.py my.txt --data-dir 다른/디렉토리
```

지원 문법
```sql
CREATE TABLE users (id, name, age, email);                -- data/users.csv 생성
CREATE TABLE IF NOT EXISTS users (id, name, age, email);  -- 이미 있으면 건너뜀
INSERT INTO users VALUES (1, '김철수', 25, 'a@b.com');
INSERT INTO users (id, name) VALUES (2, '이영희'), (3, 'O''Brien');  -- 빠진 컬럼은 빈 값
SELECT * FROM users;
SELECT name, age FROM users WHERE age >= 25 AND NOT (name = '김철수' OR age > 35);
```
- 문장은 `;`로 구분, 주석 `--`, `/* */` 지원, 키워드 대소문자 구분 없음
- CSV는 모든 값을 문자열로 저장하므로 `CREATE TABLE`에 컬럼 타입(`INT` 등)은 적지 않음
- WHERE: `= != <> < <= > >=`, `AND`, `OR`, `NOT`, 괄호
- 양쪽 값이 모두 숫자면 숫자로, 아니면 문자열로 비교
- 한 문장에서 오류가 나도 다음 문장은 계속 실행하고, 오류가 있었으면 종료 코드 1

## B+ 트리 인덱스 (app/bptree.py)
`id` 컬럼(대소문자 무시)이 있는 테이블은 메모리에 **id → 행** B+ 트리 인덱스를 가진다.

- 내부 노드는 길 안내용 구분 키만, 리프는 실제 (id, 행)을 가지며 리프끼리 `next`로 연결
- 삽입: 리프까지 내려가 정렬 위치에 넣고, 넘치면 리프 분할(오른쪽 첫 키를 부모로 **복사**) → 부모가 넘치면 내부 노드 분할(가운데 키를 부모로 **이동**) → 루트까지 넘치면 새 루트(높이 +1)
- 인덱스는 디스크에 저장하지 않는다. 테이블에 처음 접근할 때 CSV를 읽어 만들고, INSERT 때마다 CSV와 함께 갱신 (CSV가 밖에서 바뀌면 다시 만듦)

### id 자동 부여
```sql
INSERT INTO users (name, age) VALUES ('홍길동', 30);   -- id 를 빼면 최대 id + 1 부여
INSERT INTO users VALUES ('', '홍길동', 30, '');       -- 빈 값('')도 자동 부여
INSERT INTO users VALUES (100, '홍길동', 30, '');      -- 직접 지정 가능 (다음 자동 id 는 101)
```
- 이미 있는 id, 정수가 아닌 id는 오류 (파일에 아무것도 쓰지 않음)
- 실행 결과에 부여된 id가 표시됨: `2개 행이 'users' 에 추가되었습니다. (id: 6, 7)`

### 인덱스를 쓰는 SELECT
- `id = 3`, `id > 3`, `3 <= id` 처럼 id와 숫자를 비교하는 조건, 그리고 그런 조건을 `AND`로 묶은 경우 (`id >= 10 AND id < 20 AND age > 30`)
- 트리에서 id 범위의 행만 꺼낸 뒤 나머지 조건을 검사하므로, 결과는 전체 스캔과 같고 **id 오름차순**으로 나옴
- `OR`, `NOT`, `!=`, 문자열 비교(`id = 'abc'`), id가 없는 조건은 지금처럼 CSV 전체 스캔
- 인덱스를 썼으면 `1개 행 조회 (id 인덱스 사용)`으로 표시됨

### 인덱스 끄기
`CSVDatabase(data_dir, use_index=False)` 또는 `python app/sqlparser.py <파일> --no-index`로 실행하면 B+ 트리를 쓰지 않는다 (인덱스 도입 전 동작).
- SELECT는 id 조건이 있어도 항상 CSV 전체 스캔
- INSERT는 id 자동 부여와 중복 검사를 하지 않고 적은 값 그대로 저장

### 성능 비교 (app/benchmark_index.py)
id 1 ~ N 행을 `bench_users.csv`에 만들어 두고, `SELECT * FROM bench_users WHERE id = N`을 인덱스 사용/미사용으로 실행해 시간을 비교한다.
```bash
python app/benchmark_index.py                          # 50만 행, id = 500000 조회, 각 5회
python app/benchmark_index.py -n 100000 --id 1 -r 10   # 행 수, 조회할 id, 반복 횟수 지정
python app/benchmark_index.py --data-dir bench_data    # 만든 CSV 를 남김 (기본은 임시 디렉토리)
```
50만 행 측정 예시 (실행 환경마다 다름)

| 방식 | 평균 |
|---|---|
| 인덱스 없음 (CSV 전체 스캔) | 약 300 ms |
| B+ 트리 인덱스 | 약 0.1 ms |

- 트리 생성은 처음 한 번만 걸리는 비용 (CSV 읽기 + 50만 번 삽입, 약 0.9 s, order 32에서 높이 5)
- 인덱스 조회 시간의 대부분은 헤더 읽기 등 SELECT 처리이고, 트리 탐색 자체(`tree.get`)는 1 µs 미만

# DBMS API + Redis 캐시 (app/sqlcache.py)
`POST /sql`로 DBMS에 SQL을 보내고, SELECT 결과는 같은 서버의 `RedisStore`에 캐시한다. 캐시 방식은 **Cache-aside + 테이블 버전 키**.

```
SELECT ─→ Redis 확인 ─ hit ─→ 바로 응답
              └ miss ─→ Executor(CSV/B+ 트리) ─→ 결과를 Redis에 저장(TTL) ─→ 응답
INSERT ─→ Executor(CSV 쓰기) ─→ 테이블 버전 INCR (이 테이블의 옛 캐시 결과는 더 이상 쓰이지 않음)
```

### 키 구조
| 키 | 값 | TTL |
|---|---|---|
| `dbcache:ver:<테이블>` | 테이블 버전 (INSERT/CREATE 때마다 `INCR`) | 없음 |
| `dbcache:q:<테이블>:v<버전>:<해시>` | SELECT 결과 JSON | 60초 + 0~10초 무작위 |

- **캐시 단위는 행이 아니라 SELECT 결과 전체.** id 조회는 B+ 트리가 이미 메모리에서 끝내므로, 캐시의 효과가 큰 쪽은 CSV 전체 스캔이 필요한 조회
- **해시는 원문이 아니라 구문 트리로 만든다.** 공백, 줄바꿈, 주석, 키워드 대소문자만 다르면 같은 캐시를 씀
- **무효화는 버전 번호 하나로 한다.** INSERT 때 어떤 결과가 낡았는지 따지지 않고 버전만 올리면, 옛 키는 다시 조회되지 않고 TTL이 지나면 사라짐. UPDATE/DELETE가 없어 기존 행이 바뀌지 않으므로 테이블 단위 버전으로 충분함
- **버전 키가 지워지면 새 세대로 시작한다.** `FLUSHALL`이나 `DEL`로 버전 키만 사라졌을 때 1부터 다시 세면, TTL이 남은 옛 결과와 번호가 겹칠 수 있음. 그래서 현재 시각(ns)을 새 시작 번호로 씀

### 동시성과 일관성
- DB 쓰기와 버전 증가를 **같은 락** 안에서 함. miss가 난 SELECT도 그 락 안에서 버전을 다시 읽고 DB를 읽으므로, `v<N>` 키의 결과는 항상 버전 N 시점의 테이블 내용과 같음
- 같은 쿼리가 동시에 miss 나면 락을 먼저 잡은 요청만 DB를 읽음. 나머지는 락을 얻은 뒤 캐시를 다시 확인해 hit로 처리 (single-flight, cache stampede 방지)
- 캐시 hit는 DB 락을 잡지 않음
- TTL에 무작위 지터를 더해, 한꺼번에 들어간 결과가 같은 순간 만료되지 않게 함
- CSV 파일을 서버 밖에서 직접 고치면 버전이 바뀌지 않아, 최대 TTL 동안 옛 결과가 보일 수 있음

### 엔드포인트
| 메서드 / 경로 | 설명 |
|---|---|
| `POST /sql` | body: `{"sql": "...", "use_cache": true}`. 문장마다 결과를 돌려주고, SELECT에는 `cache: hit / miss / bypass`가 붙음 |
| `GET /sql/stats` | hit / miss / bypass 횟수, hit률, 무효화 횟수 |

```bash
curl -X POST http://127.0.0.1:8000/sql -H "Content-Type: application/json" \
     -d '{"sql": "SELECT name, age FROM users WHERE age >= 25;"}'
```
```json
{"results": [{"type": "select", "statement": "SELECT name, age FROM users WHERE age >= 25",
              "columns": ["name", "age"], "rows": [["김철수", "25"], ...], "count": 4,
              "used_index": false, "cache": "miss"}],
 "errors": 0}
```
- 한 문장이 실패해도 다음 문장은 계속 실행하고, 실패한 문장은 `"type": "error"`로 응답 (200)
- 닫히지 않은 문자열처럼 스크립트 전체를 읽을 수 없는 오류는 400
- `use_cache: false`면 캐시를 읽지도 쓰지도 않음 (성능 비교용, `cache: "bypass"`)
- 캐시 키도 일반 Redis 키이므로 `GET /keys`, `GET /keys/{key}/ttl`로 직접 볼 수 있음
