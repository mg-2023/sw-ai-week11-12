# Mini Redis

C11로 만든 인메모리 키-값 서버입니다. 해시 테이블을 직접 구현했고, Redis의 RESP2 명령 형식으로 외부에서 값을 저장·조회·삭제할 수 있습니다. 서버와 예제 API는 C 표준 라이브러리와 운영체제 소켓 API로 실행합니다.

## 빌드와 실행

Windows PowerShell에서 MinGW-w64의 `gcc`와 `mingw32-make`를 사용합니다. 저장소 루트에서 다음을 실행합니다.

```powershell
mingw32-make
.\mini-redis.exe
```

POSIX 환경에서는 `make`로 빌드한 뒤 `./mini-redis`를 실행합니다. 기본 주소는 `127.0.0.1:6379`입니다. 실행 시 `--bind IPv4`와 `--port PORT`를 지정할 수 있습니다. 같은 컴퓨터에서 별도로 실행한 API나 클라이언트는 기본 주소로 접속합니다.

`redis-cli`가 있는 환경에서는 아래처럼 명령을 보냅니다.

```text
redis-cli PING
redis-cli SET demo hello EX 30
redis-cli GET demo
redis-cli PTTL demo
redis-cli DEL demo
```

| 명령 | 동작과 응답 |
| --- | --- |
| `SET key value [EX seconds\|PX milliseconds]` | 값을 저장하고 `OK`를 반환합니다. TTL 없이 덮어쓰면 기존 TTL이 제거됩니다. |
| `GET key` | 값을 반환합니다. 키가 없거나 만료되었으면 RESP2 null bulk string을 반환합니다. |
| `DEL key [key ...]` | 키를 즉시 제거하고 실제 삭제한 수를 반환합니다. |
| `EXPIRE key seconds`, `PEXPIRE key milliseconds` | 기존 키의 TTL을 변경합니다. 0 이하는 즉시 삭제하며 처리 결과를 `1` 또는 `0`으로 반환합니다. |
| `PTTL key` | 남은 밀리초를 반환합니다. TTL이 없으면 `-1`, 키가 없거나 만료되었으면 `-2`입니다. |
| `PING [message]` | 연결을 확인하고 `PONG` 또는 전달된 메시지를 반환합니다. |

키와 값은 바이트와 길이로 다룹니다. 빈 값, 빈 키, NUL이 포함된 값도 저장할 수 있습니다. RESP2 배열에서 각 인자는 최대 1 MiB, 명령당 인자는 최대 16개이며, 프레임은 최대 2 MiB + 4 KiB입니다.

## 예제 API와 성능 비교

Mini Redis를 실행한 상태에서 두 번째 터미널에서 예제 API를 시작합니다. 기본 HTTP 주소는 `127.0.0.1:8001`입니다. Mini Redis 포트를 변경했다면 `--redis-port`로 맞춥니다. POSIX에서는 `./report-api`를 실행합니다.

```powershell
.\report-api.exe
```

세 번째 터미널에서 요청을 보냅니다. 첫 호출은 50ms 지연을 둔 원본 조회를 수행하고, `sample-report`에 HTTP 응답 본문을 30초간 저장합니다. 후속 호출은 캐시에서 응답을 읽습니다. `X-Cache` 헤더에 `miss`, `hit`, `bypass`가 표시됩니다. TTL 만료나 `DEL sample-report` 뒤에는 다음 요청이 원본을 다시 읽습니다.

```powershell
curl.exe -i http://127.0.0.1:8001/v1/report
curl.exe -i http://127.0.0.1:8001/v1/report
curl.exe -i 'http://127.0.0.1:8001/v1/report?cache=off'
.\examples\benchmark.ps1 -Requests 30
```

벤치마크는 캐시를 채운 뒤 미사용과 적중 요청을 번갈아 보내고 응답 본문이 같은지 확인합니다. 출력은 HTTP 왕복과 예제의 50ms 원본 지연을 포함한 중앙값입니다.

## 코드 흐름

1. [`server.c`](src/server.c)의 `main`이 TCP 포트를 엽니다. `run_loop`는 Windows의 `WSAPoll` 또는 POSIX의 `poll`로 읽고 쓸 수 있는 소켓을 고릅니다. 여러 연결을 번갈아 처리하면서 한 스레드에서 한 명령씩 실행합니다.
2. `read_client`가 받은 바이트를 입력 버퍼에 추가합니다. [`resp.c`](src/resp.c)의 `resp_parse`는 배열 개수와 각 인자 길이를 읽습니다. 프레임이 끊겨 들어오면 파싱 위치를 기억하고 다음 수신을 기다립니다.
3. 완성된 명령은 [`commands.c`](src/commands.c)의 `execute_command`로 전달됩니다. 인자와 TTL을 검사한 뒤 `store_set`, `store_get`, `store_delete` 등을 호출합니다. [`server.c`](src/server.c)의 `queue_reply`는 결과를 RESP2로 인코딩하고, `write_client`가 소켓에 전송합니다. 읽기가 느린 연결은 응답 버퍼를 비울 수 있을 때까지 기다리며, 이벤트 루프는 그동안 다른 연결을 처리합니다.
4. [`store.c`](src/store.c)의 `hash_key`는 키의 각 바이트를 FNV-1a 해시에 반영합니다. `hash % capacity`로 버킷을 선택하고, 충돌한 항목은 연결 리스트에 넣습니다. `find_in_table`은 해시·길이·실제 바이트를 비교합니다. 해시가 고르게 분포하면 탐색은 평균 O(1)이며 키 해시 계산 비용은 키 길이에 비례합니다.
5. `store_set`은 키와 값을 새 항목에 복사한 뒤 테이블에 연결합니다. 부하율이 75%를 넘으면 두 배 크기의 배열을 준비합니다. `rehash_step`이 기존 항목을 조금씩 옮기는 동안 조회와 삭제는 두 배열을 검색하고, 새 키는 새 배열에 넣습니다. 확장 중에는 두 버킷 배열이 메모리에 함께 있습니다.
6. `find_live`는 조회·삭제 시점에 만료된 값을 발견하면 바로 제거합니다. `store_maintain`은 이벤트 루프에서 약 100ms마다 실행되어 TTL이 설정된 항목을 최대 32개씩 순회하고 만료된 항목을 제거합니다. TTL은 밀리초 단조 시계로 계산합니다.

실제 Redis의 핵심 명령을 순서대로 실행하는 모델, RESP2, 점진적 리해시, 접근 시 만료와 주기적 정리 구조를 참고했습니다. [Redis 실행 모델](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/), [RESP 사양](https://redis.io/docs/latest/develop/reference/protocol-spec/), [Redis 해시 테이블](https://github.com/redis/redis/blob/unstable/src/dict.c), [Redis 만료 처리](https://redis.io/docs/latest/commands/expire/)

## 검증 범위와 한계

```powershell
mingw32-make test
python tests/test_integration.py -v
```

단위 테스트는 C로 저장·조회·삭제, 충돌, 확장 중 접근, 만료 경계, 주기적 정리, RESP 파싱을 검증합니다. 통합 테스트는 Python 표준 라이브러리로 두 C 실행 파일을 띄우고, 실제 TCP/HTTP 요청으로 동시 연결, 부분 프레임, 파이프라인, 대용량 응답, 캐시 무효화를 검증합니다. Python은 통합 테스트를 실행할 때 사용합니다.

- 원자성의 범위는 명령 한 건입니다. 별도 `GET`과 `SET` 사이에 다른 명령이 실행될 수 있습니다. 현재 구현은 위 명령 표의 RESP2 기능을 제공합니다.
- 조회 시 만료는 즉시 적용됩니다. 접근하지 않은 만료 항목이 메모리에서 정리되는 시점은 TTL 키 수에 따라 달라집니다.
- 선택 항목인 영속성은 구현하지 않았습니다. 서버 종료 시 데이터는 사라집니다. 장애 후 복구가 필요하다면 절대 만료 시각을 포함한 변경 로그를 디스크에 기록하고 재시작 시 재생하는 AOF 방식이 적합합니다. 디스크 동기화 주기가 장애 시 손실 범위와 쓰기 지연에 영향을 줍니다. [Redis 영속성 문서](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- 과제용 서버로, 전체 데이터 메모리 상한, 인증, TLS는 제공하지 않습니다. 외부 접속이 필요한 경우 접근이 통제된 실습 환경에서 실행합니다.
