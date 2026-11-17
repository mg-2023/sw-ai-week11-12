# Mini Redis

C11로 만든 인메모리 키-값 서버입니다. 외부 앱은 TCP 위의 RESP2 명령으로 값을 저장·조회·삭제하고 TTL을 지정합니다. 해시 테이블, 만료 처리, 이벤트 루프, 영속성(RDB 방식의 스냅샷, AOF)을 직접 구현했습니다.

이 문서는 4분 발표 순서로 구성했습니다. 요청 한 건이 지나가는 계층을 왼쪽부터 따라갑니다.

| 순서 | 시간 | 내용 | 중점 포인트 |
| --- | ---: | --- | --- |
| [0. 전체 구조](#0-전체-구조) | 30초 | 계층 5개와 요청 흐름 | |
| [1. 네트워크 계층](#1-네트워크-계층--요청-한-건의-흐름) | 50초 | `poll` 루프, RESP2 파싱, 명령 실행, 응답 | 동시성 |
| [2. 저장소 계층](#2-저장소-계층--해시-테이블과-만료-리스트) | 60초 | 해시 테이블, 만료 리스트 | 만료, 무효화 |
| [3. 디스크 계층](#3-디스크-계층--스냅샷과-aof) | 45초 | 스냅샷과 AOF, 강제 종료 뒤 재시작 결과 | 장애 복구 |
| [4. 시연](#4-시연--테스트-페이지에서-쓰이는-순간) | 30초 | 오목 테스트 페이지가 각 기능을 쓰는 순간 | 캐시 |
| [5. 검증과 한계](#5-검증과-한계) | 25초 | 테스트 결과, 보장 범위 | |

## 0. 전체 구조

```text
외부 앱 ── TCP / RESP2 ──▶ 네트워크 ──▶ 프로토콜 ──▶ 명령 ──▶ 저장소
                           server.c     resp.c      commands.c  store.c
                           net.c                        │       siphash.c
                                                        ▼
                                                      디스크
                                                      persist.c
```

| 계층 | 파일 | 역할 | 경계 |
| --- | --- | --- | --- |
| 네트워크 | [`server.c`](src/server.c), [`net.c`](src/net.c) | `poll` 루프, 연결별 입출력 버퍼, 소켓 함수 | 명령의 뜻을 해석하지 않습니다. |
| 프로토콜 | [`resp.c`](src/resp.c) | 바이트 버퍼를 RESP2 인자 배열로 파싱 | 소켓을 알지 못합니다. |
| 명령 | [`commands.c`](src/commands.c) | 명령 이름으로 분기해 저장소 함수를 호출 | 소켓과 파일을 알지 못합니다. 변경 내용은 콜백으로 넘깁니다. |
| 저장소 | [`store.c`](src/store.c), [`siphash.c`](src/siphash.c) | 해시 테이블, 만료 리스트 | 시계를 읽지 않습니다. 호출자가 시각을 넘깁니다. |
| 디스크 | [`persist.c`](src/persist.c) | 스냅샷 저장·복원, AOF 기록·재생 | 저장소의 공개 함수만 사용합니다. |

## 1. 네트워크 계층 : 요청 한 건의 흐름

스레드 하나가 `poll` 하나로 모든 연결을 감시하고, 명령을 한 번에 하나씩 실행합니다.

```text
요청 수신        RESP 파싱          명령 실행             해시 테이블              응답
read_client  →  resp_parse   →  execute_command  →  store_set / store_get  →  queue_reply → write_client
(server.c)      (resp.c)        (commands.c)         (store.c)                (server.c)
```

| 명령 | 응답 |
| --- | --- |
| `SET key value [EX 초 \| PX 밀리초]` | `OK`. 같은 키에 다시 쓰면 값과 TTL을 모두 바꿉니다. |
| `GET key` | 값. 키가 없거나 만료됐으면 `(nil)`입니다. |
| `DEL key [key ...]` | 실제로 지운 키 수 |
| `EXPIRE key 초`, `PEXPIRE key 밀리초` | TTL을 바꾸면 `1`, 키가 없으면 `0`. 0 이하는 즉시 삭제합니다. |
| `PTTL key` | 남은 밀리초. TTL이 없으면 `-1`, 키가 없으면 `-2`입니다. |
| `PING [message]`, `SAVE` | `PONG` 또는 받은 메시지, 스냅샷 저장 뒤 `OK` |

`redis-cli`나 Redis 클라이언트 라이브러리를 그대로 사용할 수 있습니다. 키와 값은 바이트열과 길이로 다루므로 빈 값과 NUL이 포함된 값도 저장합니다.

### 동시성 : 실행 단위는 명령 하나입니다

- `execute_command`가 끝나야 다음 명령이 시작됩니다. 따라서 락이 없어도 명령 하나는 원자적입니다.
- 여러 명령에 걸친 작업은 원자적이지 않습니다. 두 연결이 `GET` 뒤 `SET`을 나눠 보내면 갱신 하나가 사라집니다.

```text
[+     15ms] EXEC #2 conn=1 GET "counter" -> "0"
[+     15ms] EXEC #3 conn=2 GET "counter" -> "0"
[+     15ms] EXEC #4 conn=1 SET "counter" "1" -> OK
[+     15ms] EXEC #5 conn=2 SET "counter" "1" -> OK      두 연결이 각각 +1 했지만 최종값은 "1"
```

`--log` 옵션의 실제 출력입니다(`python examples/demo.py lost-update`). `#번호`는 서버가 명령을 실행한 순번이고 `conn`은 연결 ID입니다. 읽고 더하고 쓰는 과정을 명령 하나로 옮기는 `INCR`이 해결 방법이며, 이번 범위에서는 구현하지 않았습니다.

## 2. 저장소 계층 : 해시 테이블과 만료 리스트

항목 하나가 두 연결 리스트에 동시에 들어갑니다. 버킷 체인은 키로 찾는 경로이고, 만료 리스트는 TTL이 있는 항목만 도는 경로입니다.

### 2-1. 해시 테이블

```text
키 → SipHash-2-4(시작 시 뽑은 비밀 키 128비트) → 64비트 해시 → hash % capacity → 버킷 번호

buckets[0] → NULL
buckets[1] → Entry → Entry → NULL        같은 버킷의 항목은 체인으로 연결합니다.
buckets[2] → Entry → NULL
```

- 평균 O(1) 조회를 얻기 위해 해시 테이블을 사용합니다.
- 부하율 75%에서 두 배 크기 테이블을 만들고 `rehash_step`으로 조금씩 옮깁니다. 한 번에 옮기지 않으므로 확장 중에도 명령 하나가 오래 걸리지 않습니다.
- v1.0.0은 고정 상수 FNV-1a를 사용했습니다. 같은 버킷으로 몰리는 키를 미리 계산할 수 있어 v1.1.0에서 키 있는 SipHash-2-4로 바꿨습니다.
- 옛 해시에서 한 버킷에 몰리던 키 1000개를 넣었을 때 가장 긴 체인은 1000에서 4로 줄었습니다. 결정 과정은 [ADR 0001](docs/adr/0001-siphash.md)에 있습니다.

### 2-2. 데이터 만료 : 조회 시 회수와 주기 회수

```text
만료 시각이 있는 항목만 잇는 원형 이중 연결 리스트

  → Entry ⇄ Entry ⇄ Entry ⇄ … ⇄ Entry →  (끝은 처음으로 이어집니다)
              ↑
        expire_cursor : 다음 주기 정리가 검사를 시작할 항목
```

| 경로 | 언제 | 코드 |
| --- | --- | --- |
| 조회 시 만료 | 명령이 키에 접근할 때 만료 시각이 지났으면 지우고 `(nil)`을 반환합니다. | `find_live` |
| 주기 정리 | 100ms마다 커서부터 **최대 32개**를 검사해 지난 항목을 지웁니다. 다음 호출은 커서에서 이어 갑니다. | `store_maintain` |

검사 수를 32개로 제한하는 이유는 주기 정리도 같은 스레드에서 실행되기 때문입니다. 전부 검사하면 그동안 모든 명령이 멈춥니다.

```text
[+     16ms] EXEC #1 conn=1 SET "cache:ghost" "v" "PX" "100" -> OK
[+    125ms] EXPIRE by-cycle  key="cache:ghost" (nobody read it, removed by active expiry)
[+    125ms] CYCLE checked 2 of 2 TTL keys from cursor (limit 32), removed 1
```

### 2-3. 데이터 무효화 : TTL이 남은 키의 `DEL`

```text
[+     16ms] EXEC #2 conn=1 PTTL "cache:report" -> (integer) 30000
[+     16ms] EXEC #3 conn=1 DEL "cache:report" -> (integer) 1
[+     16ms] EXEC #4 conn=1 GET "cache:report" -> (nil)
```

`DEL`은 TTL이 30초 남은 항목을 버킷 체인과 만료 리스트에서 즉시 제거합니다.

## 3. 디스크 계층 : 스냅샷과 AOF

메모리의 내용은 프로세스가 끝나면 사라집니다. 두 방식 중 하나를 골라 디스크에 남깁니다.

| 방식 | 기록하는 것 | 재시작 시 | 강제 종료 시 잃는 범위 |
| --- | --- | --- | --- |
| RDB 방식의 스냅샷 (`--snapshot FILE`) | `SAVE` 시점의 키·값·만료 시각 전체 | 파일을 읽어 채웁니다. | 마지막 `SAVE` 이후의 모든 변경 |
| AOF (`--aof FILE`) | 상태를 바꾼 연산을 실행 순서대로 | 처음부터 재생합니다. | 동기화 정책에 따라 다릅니다. |

- 스냅샷은 `파일.tmp`에 끝까지 쓰고 fsync한 뒤에만 원래 이름으로 교체합니다. 쓰는 도중 종료되면 마지막 완성본이 남습니다.
- AOF는 명령을 실행한 직후, 응답을 출력 버퍼에 넣기 전에 기록합니다.
- 만료 시각은 두 방식 모두 Unix ms 절대 시각으로 저장합니다. 서버가 꺼져 있던 시간도 TTL에서 빠집니다.

`v1 저장 → 기준 시점(스냅샷은 여기서 SAVE) → v2 갱신 → 강제 종료 → 2초 뒤 재시작` 결과입니다(`python examples/demo.py recovery-snapshot`, `recovery-aof`).

| 확인 | 스냅샷 | AOF (`appendfsync always`) |
| --- | --- | --- |
| `GET user:1` | `"v1"` (`SAVE` 이후의 v2는 잃음) | `"v2"` |
| `SET` 뒤 `DEL` 한 키 | `(nil)` | `(nil)` |
| 꺼져 있던 2초 동안 만료된 키 | `(nil)` | `(nil)` |
| `PX 10000`으로 저장한 키의 `PTTL` | `7972` | `7937` |

동기화 정책별 동작, 재시작 전후 로그, AOF 파일 내용은 [docs/persistence.md](docs/persistence.md)에 있습니다.

## 4. 시연 : 테스트 페이지에서 쓰이는 순간

테스트 페이지는 오목 앱([Jongeume/mini-react](https://github.com/Jongeume/mini-react))입니다. 대국 결과 저장과 최근 대국 요약 조회에 Mini Redis를 캐시로 사용합니다.

```text
오목 화면  →  HTTP/JSON  →  오목 백엔드(Node)  →  TCP/RESP2  →  Mini Redis
                            원본 대국 기록(JSON 파일)           요약 캐시 gomoku:recent-summary
```

![요약 조회가 캐시에 적중하고, 대국이 끝나 결과를 저장하면 백엔드가 DEL로 요약 캐시를 지우며, 다시 조회하면 GET이 nil이 되어 새 요약을 SET EX 30으로 저장하는 화면](docs/gomoku-redis-cache.gif)

| 테스트 페이지에서 하는 일 | 백엔드가 보낸 명령 → 실제 응답 | 쓰이는 기능 |
| --- | --- | --- |
| 1. 최근 대국 요약을 조회합니다. | `GET gomoku:recent-summary` → 요약 JSON | 해시 테이블 조회 (캐시 적중) |
| 2. 대국이 끝나 결과를 저장합니다. | 원본 저장 성공 뒤 `DEL gomoku:recent-summary` → `(integer) 1` | 무효화 |
| 3. 요약을 다시 조회합니다. | `GET` → `(nil)`, 새 요약을 `SET … EX 30` → `OK` | TTL 지정 저장 |

- 앱(오목 백엔드)이 판단합니다. 무엇을 캐시하고 언제 지울지는 앱이 정합니다.
- Mini Redis는 받은 명령을 실행합니다. 명령 하나의 원자성과 TTL 만료를 보장합니다.

전체 로그는 [`docs/backend.log`](docs/backend.log), [`docs/mini-redis.log`](docs/mini-redis.log)에 있습니다.

## 5. 검증과 한계

| 테스트 | 명령 | 결과 |
| --- | --- | --- |
| 저장소 단위 | `mingw32-make test` | 10개 시나리오 통과 |
| SipHash 단위 | `mingw32-make test` | 공식 테스트 벡터 64개 일치 |
| RESP 파싱 단위 | `mingw32-make test` | 3개 시나리오 통과 |
| 영속성 단위 | `mingw32-make test` | 6개 시나리오 통과 |
| 통합 | `python tests/test_integration.py -v` | 7건 통과 |
| 발표 장면 통합 | `python tests/test_scenarios.py -v` | 13건 통과 |
| 오목 백엔드·화면 (mini-react) | `npm test` | 663건 통과 |

- 원자성은 명령 한 건까지입니다. 여러 명령에 걸친 작업은 앱이 책임집니다.
- 조회하지 않은 만료 키가 메모리에서 회수되는 시점은 TTL 키 수에 따라 늦어질 수 있습니다.
- 스냅샷은 마지막 `SAVE` 이후의 변경을 잃습니다.
- 복구 실험은 프로세스 강제 종료만 확인했습니다. 운영체제나 전원 장애는 측정하지 않았습니다.
- 인증, TLS, 전체 메모리 상한, `INCR`은 제공하지 않습니다.

테스트가 확인하는 항목 전체, 한계 전체, 예제 성능 측정값은 [docs/verification.md](docs/verification.md)에 있습니다.

## 부록 : 빌드와 재현 명령

Windows PowerShell에서 MinGW-w64의 `gcc`, `mingw32-make`와 Python 3을 사용합니다. POSIX에서는 `make`와 `./mini-redis`를 사용합니다.

```powershell
mingw32-make                      # mini-redis.exe, report-api.exe
mingw32-make test                 # 저장소 · SipHash · RESP · 영속성 단위 테스트
python tests/test_integration.py -v
python tests/test_scenarios.py -v
python examples/demo.py all       # 발표 장면 재현. 로그는 demo-output/ 에 저장됩니다.
```

| 서버 옵션 | 뜻 |
| --- | --- |
| `--bind IPv4`, `--port PORT` | 수신 주소. 기본 `127.0.0.1:6379`, `0`이면 임의 포트입니다. |
| `--log FILE` 또는 `--log -` | 시연 로그를 파일 또는 표준 오류로 기록합니다. 기본은 꺼짐입니다. |
| `--expire-cycle-ms MS` | 주기 정리 간격. 기본 100, `0`이면 주기 정리를 끕니다. |
| `--snapshot FILE` | RDB 방식의 스냅샷 모드. `SAVE`로 저장하고 시작할 때 복원합니다. |
| `--aof FILE`, `--appendfsync always\|everysec\|no` | AOF 모드. `--snapshot`과 함께 쓸 수 없습니다. |
| `--debug-aof-fail-at N`, `--debug-snapshot-crash-after N` | 시험용 장애 주입. N번째 AOF 기록을 실패시키거나, 스냅샷 항목 N개를 쓴 직후 종료합니다. |

오목 시연은 [Jongeume/mini-react](https://github.com/Jongeume/mini-react)의 `feat/gomoku-redis-backend` 브랜치에서 실행합니다.

```powershell
.\mini-redis.exe                                   # 이 저장소
node backend/gomoku-api.js --redis-port 6379       # mini-react 저장소, http://127.0.0.1:8090/
npm test                                           # mini-react 저장소, 백엔드 테스트는 ../mini-redis/mini-redis.exe 사용
node docs/demo/record-redis.mjs; python docs/demo/make_redis_gif.py   # GIF 다시 만들기
```

참고 자료 : [Redis 실행 모델](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/), [RESP 사양](https://redis.io/docs/latest/develop/reference/protocol-spec/), [Redis 만료 처리](https://redis.io/docs/latest/commands/expire/), [Redis 영속성](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
