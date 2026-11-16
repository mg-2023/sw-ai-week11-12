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

- 지원 명령어: `INSERT`, `SELECT` (DDL은 미지원, 테이블 CSV 파일은 미리 만들어져 있다고 가정)
- CSV 첫 줄은 컬럼 이름(헤더)
- 처리 순서: Tokenizer(토큰 분리) → Parser(구문 트리 생성) → Executor(CSV 읽기/쓰기)

```bash
python app/sqlparser.py sql/sample.txt
python app/sqlparser.py my.txt --data-dir 다른/디렉토리
```

지원 문법
```sql
INSERT INTO users VALUES (1, '김철수', 25, 'a@b.com');
INSERT INTO users (id, name) VALUES (2, '이영희'), (3, 'O''Brien');  -- 빠진 컬럼은 빈 값
SELECT * FROM users;
SELECT name, age FROM users WHERE age >= 25 AND NOT (name = '김철수' OR age > 35);
```
- 문장은 `;`로 구분, 주석 `--`, `/* */` 지원, 키워드 대소문자 구분 없음
- WHERE: `= != <> < <= > >=`, `AND`, `OR`, `NOT`, 괄호
- 양쪽 값이 모두 숫자면 숫자로, 아니면 문자열로 비교
- 한 문장에서 오류가 나도 다음 문장은 계속 실행하고, 오류가 있었으면 종료 코드 1
