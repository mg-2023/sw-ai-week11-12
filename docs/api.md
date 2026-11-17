# Mini Redis API 문서

README 는 설계 판단을 다룹니다. 이 문서는 코드를 쓰거나 읽을 때 필요한 세부를 모읍니다.

- [연결과 실행](#연결과-실행)
- [명령](#명령)
- [요청 처리 흐름](#요청-처리-흐름)
- [저장소 함수](#저장소-함수)
- [영속성 함수](#영속성-함수)
- [테스트](#테스트)
- [테스트 페이지 실행](#테스트-페이지-실행)

## 연결과 실행

```powershell
mingw32-make                      # mini-redis.exe, report-api.exe
.\mini-redis.exe                  # 127.0.0.1:6379
.\mini-redis.exe --port 7000 --aof data.aof
```

POSIX 에서는 `make` 로 빌드하고 `./mini-redis` 로 실행합니다.
`Mini Redis listening on 127.0.0.1:6379` 가 출력되면 연결을 받을 준비가 된 것입니다.

| 서버 옵션 | 뜻 |
|---|---|
| `--bind IPv4`, `--port PORT` | 수신 주소. 기본 `127.0.0.1:6379`, `0`이면 임의 포트 |
| `--aof FILE`, `--appendfsync always\|everysec\|no` | 쓰기 명령을 파일에 기록하고 시작할 때 재생합니다 |
| `--snapshot FILE` | `SAVE` 명령으로 전체를 저장하고 시작할 때 복원합니다. `--aof`와 함께 쓸 수 없습니다 |
| `--expire-cycle-ms MS` | 만료된 키를 정리하는 주기. 기본 100, `0`이면 끔 |
| `--log FILE` 또는 `--log -` | 받은 명령과 응답을 파일 또는 표준 오류로 기록. 기본은 꺼짐 |
| `--debug-aof-fail-at N`, `--debug-snapshot-crash-after N` | 시험용 장애 주입 |

### 연결 예시

Redis 클라이언트 라이브러리 없이 파이썬 표준 라이브러리만 씁니다. 주석은 실제로 받은 응답입니다.

```python
import socket

def command(sock, *args):
    """명령 하나를 RESP2 배열로 만들어 보내고 응답을 그대로 돌려줍니다."""
    request = f"*{len(args)}\r\n".encode()
    for arg in args:
        data = str(arg).encode()
        request += f"${len(data)}\r\n".encode() + data + b"\r\n"
    sock.sendall(request)
    return sock.recv(4096)

with socket.create_connection(("127.0.0.1", 6379)) as sock:
    print(command(sock, "SET", "session:42", "kim", "EX", 30))  # b'+OK\r\n'        캐시 저장, 30초 뒤 만료
    print(command(sock, "GET", "session:42"))                   # b'$3\r\nkim\r\n'  길이 3인 값 kim
    print(command(sock, "INCR", "visits"))                      # b':1\r\n'         정수 1
    print(command(sock, "DEL", "session:42"))                   # b':1\r\n'         지운 키 수
    print(command(sock, "GET", "session:42"))                   # b'$-1\r\n'        값 없음 (nil)
```

| 보내는 것과 받는 것 | 형식 |
|---|---|
| 명령 | 인자 개수 `*N`, 그 뒤에 인자마다 길이 `$길이`와 내용. 줄 끝은 `\r\n` |
| 성공 응답 | `+OK` |
| 정수 응답 | `:1` |
| 값 응답 | `$길이`와 내용. 값이 없으면 `$-1` |
| 오류 응답 | `-ERR 메시지` |

Node.js 예시는 오목 백엔드의 [`backend/resp-client.js`](https://github.com/Jongeume/mini-react/blob/main/backend/resp-client.js)입니다.

## 명령

| 명령 | 응답 |
|---|---|
| `SET key value [EX 초 \| PX 밀리초]` | `OK`. 같은 키에 다시 쓰면 값과 TTL을 모두 바꿉니다 |
| `GET key` | 값. 키가 없거나 만료됐으면 `(nil)` |
| `DEL key [key ...]` | 실제로 지운 키 수 |
| `INCR key` | 1 증가한 값. 키가 없으면 `1`, 정수가 아니면 오류. TTL은 유지합니다 |
| `EXPIRE key 초`, `PEXPIRE key 밀리초` | TTL을 바꾸면 `1`, 키가 없으면 `0`. 0 이하는 즉시 삭제 |
| `PTTL key` | 남은 밀리초. TTL이 없으면 `-1`, 키가 없으면 `-2` |
| `PING [message]`, `SAVE` | `PONG` 또는 받은 메시지, 스냅샷 저장 뒤 `OK` |

| 오류 응답 | 언제 |
|---|---|
| `-ERR unknown command` | 모르는 명령 |
| `-ERR wrong number of arguments for '…' command` | 인자 수가 틀림. 저장소는 바뀌지 않습니다 |
| `-ERR syntax error` | `SET` 의 옵션이 `EX` · `PX` 가 아님 |
| `-ERR invalid expire time in 'set' command` | `SET` 의 TTL 이 0 이하, 정수 아님, 넘침 |
| `-ERR value is not an integer or out of range` | `INCR` 대상이 정수 아님, `EXPIRE` 의 값이 정수 아님 |
| `-ERR increment or decrement would overflow` | `INCR` 결과가 64비트 정수 최댓값을 넘음 |
| `-ERR invalid RESP2 frame` | 형식이 틀린 요청. 응답 뒤 연결을 닫습니다 |

명령 이름은 대소문자를 가리지 않습니다. 요청 하나는 인자 16개, 인자 하나 1MiB 까지입니다.

## 요청 처리 흐름

```text
요청 수신        RESP 파싱          명령 실행             해시 테이블              응답
read_client  →  resp_parse   →  execute_command  →  store_set / store_get  →  queue_reply → write_client
(server.c)      (resp.c)        (commands.c)         (store.c)                (server.c)
```

| 계층 | 파일 | 역할 |
|---|---|---|
| 네트워크 | [`server.c`](../src/server.c), [`net.c`](../src/net.c) | `poll` 루프, 연결별 입출력 버퍼 |
| 프로토콜 | [`resp.c`](../src/resp.c) | 바이트 버퍼를 인자 배열로 파싱 |
| 명령 | [`commands.c`](../src/commands.c) | 명령 이름으로 분기해 저장소 함수를 호출 |
| 저장소 | [`store.c`](../src/store.c), [`siphash.c`](../src/siphash.c) | 해시 테이블, 만료 리스트 |
| 디스크 | [`persist.c`](../src/persist.c) | 스냅샷 저장 · 복원, AOF 기록 · 재생 |

## 저장소 함수

```text
Entry = { hash, 키 길이, 값 길이, 만료 시각, 체인의 다음 항목, 만료 리스트의 앞뒤 항목, 키와 값 바이트 }
```

| 함수 | 하는 일 | 순서 |
|---|---|---|
| `store_set` | 저장 | 항목을 만들어 키와 값을 복사 → 같은 키가 있으면 그 자리의 항목을 교체 → 없으면 버킷 체인 맨 앞에 삽입 → 부하율 75%에 닿으면 두 배 크기 테이블 생성 |
| `store_get` | 조회 | `find_live`로 항목을 찾음 → 값의 위치와 길이를 반환 (복사하지 않음) |
| `store_delete` | 삭제 | `find_live`로 항목을 찾음 → 앞 항목의 링크를 다음 항목으로 바꿔 체인에서 제거 → 만료 리스트에서도 제거 |
| `find_live` | 살아 있는 항목 찾기 | rehash 두 단계 진행 → 버킷 체인에서 키 비교 → 만료 시각이 지났으면 지우고 없음으로 처리 |
| `find_in_table` | 키 비교 | 해시 → 길이 → 바이트 순서로 비교. 비용이 작은 비교에서 다르면 뒤는 보지 않습니다 |
| `rehash_step` | 테이블 확장 | 옛 테이블의 항목을 정해진 수만큼만 새 테이블로 이동. 다 옮기면 새 테이블이 현재 테이블이 됩니다 |

| 함수 | 하는 일 |
|---|---|
| `store_expire_at` | 만료 시각을 바꿉니다. 이미 지난 시각이면 바로 지웁니다 |
| `store_pttl` | 남은 ms. TTL 없음 `-1`, 키 없음 `-2` |
| `store_maintain` | 주기 정리. 확장 중이면 조금 옮기고, 만료 리스트를 커서부터 최대 32개 검사합니다 |
| `store_foreach` | 살아 있는 항목을 모두 방문합니다. 스냅샷 저장이 씁니다 |
| `store_init` | 운영체제 난수로 SipHash 키를 뽑아 테이블을 만듭니다. 난수를 못 얻으면 실패합니다 |

## 영속성 함수

| 함수 | 하는 일 |
|---|---|
| `snapshot_save` | 살아 있는 항목을 `파일.tmp` 에 쓰고 fsync 한 뒤 원래 이름으로 바꿉니다 |
| `snapshot_load` | 스냅샷을 읽어 되살립니다. 꺼져 있던 동안 만료된 키는 건너뜁니다 |
| `aof_append` | 변경 한 건(`SET` · `DEL` · `PEXPIREAT`)을 파일 끝에 씁니다. `always` 면 fsync 까지 합니다 |
| `aof_open` | 기록을 순서대로 모두 재생한 뒤, 만료 시각이 지난 키를 지웁니다. 끝의 쓰다 만 레코드는 잘라 냅니다 |
| `aof_sync_if_due` | `everysec` 에서 마지막 fsync 뒤 1초가 지났고 쓴 것이 있으면 fsync 합니다 |

동기화 정책별 동작과 재시작 전후 로그는 [persistence.md](persistence.md)에 있습니다.

## 테스트

```powershell
mingw32-make test                 # 저장소 · 명령 · RESP · 영속성 · SipHash 단위 테스트
python tests/test_integration.py -v
python tests/test_scenarios.py -v
python examples/demo.py all       # README 설계 결정 절의 로그 장면 재현. 로그는 demo-output/ 에 저장됩니다
python examples/benchmark.py      # 성능 측정
```

장애 복구 테스트는 서버의 시험용 옵션 `--debug-aof-fail-at N`, `--debug-snapshot-crash-after N`으로 장애를 주입합니다.

| 상황 | 동작 | 테스트 |
|---|---|---|
| 없는 키 조회 | `(nil)` | `test_binary_and_collision`, `test_binary_crud_and_multiple_delete` |
| 같은 키 다시 저장 | 값과 TTL을 모두 새 값으로 교체 | `test_binary_and_collision`, `test_expiration` |
| 만료된 키 조회 | 그 자리에서 지우고 `(nil)` | `test_expiration`, `test_expired_key_is_removed_on_access` |
| 이미 지운 키를 다시 삭제 | 지운 수 `0` | `test_binary_and_collision` |
| 빈 키, 빈 값, NUL이 든 값 | 그대로 저장하고 조회 | `test_binary_and_collision` |
| 연결 12개가 같은 키를 동시에 `DEL` | `1` 한 건, `0` 열한 건 | `test_concurrent_clients_and_same_key_deletion` |
| 연결 12개가 같은 키를 동시에 `INCR` | 1부터 12까지 하나씩 | `test_concurrent_incr_gives_each_client_a_distinct_number` |
| 정수가 아닌 값에 `INCR` | 오류, 값은 그대로 | `test_incr_rejects_non_integer_and_overflow_without_changing_value` |
| 명령이 조각나서 도착 | 다른 연결을 막지 않고 이어서 파싱 | `test_partial_frames_do_not_block_other_clients_and_pipeline_is_ordered` |
| AOF 마지막 레코드가 쓰다 만 상태 | 그 부분만 잘라 내고 시작 | `test_aof_incomplete_last_record_is_truncated` |
| 키 · 값에 NUL, 대소문자만 다른 키 | 서로 다른 키 | `test_distinct_binary_keys` |
| 같은 버킷 체인의 맨 앞 · 중간 · 끝 삭제 | 나머지는 그대로 조회 | `test_chain_delete_head_middle_tail` |
| 테이블 확장 중 두 테이블에 걸친 조회 | 모두 찾음 | `test_rehash_lookup_across_tables` |
| 만료 리스트 커서가 가리키는 항목 삭제 | 주기 정리가 계속 동작 | `test_cursor_entry_deleted` |
| 만료 시각과 현재 시각이 같음 | 만료 | `test_deadline_boundary` |
| 인자 수가 틀린 명령 | 오류, 저장소와 변경 기록 그대로 | `test_wrong_argument_counts_change_nothing` |
| 정수가 아닌 값, 최댓값에 `INCR` | 오류, 값 그대로 | `test_incr_rejects_non_integers`, `test_incr_overflow` |
| TTL 있는 키에 실패한 `INCR` | TTL 그대로 | `test_failed_incr_keeps_ttl` |
| `EXPIRE` 에 0 이하 | 즉시 삭제, `DEL` 로 기록 | `test_expire_non_positive_deletes` |
| 인자 16개 · 17개 | 16개 실행, 17개는 오류 뒤 연결 종료 | `test_argument_count_limit`, `test_sixteen_arguments_run_and_seventeen_close_the_connection` |
| 요청 전체 크기 상한 경계 | 상한까지 허용, 넘으면 오류 | `test_frame_size_limit` |
| 요청 도중 연결 끊김 | 다른 연결은 정상 | `test_client_disconnect_mid_frame_does_not_affect_others` |
| 빈 키와 빈 값 (TCP) | 저장 · 조회 · 삭제 | `test_empty_key_and_empty_value` |
| 저장 시점에 이미 만료된 키 | 스냅샷 복원 뒤 없음 | `test_snapshot_drops_key_expired_at_save` |
| 1MiB 값, 쓰기 버퍼 경계 크기 | 스냅샷 · AOF 왕복 | `test_aof_large_values` |
| 문법은 맞지만 뜻이 틀린 AOF 레코드 | 시작 거부 | `test_aof_semantically_invalid_records` |
| TTL 연장 뒤 첫 만료 시각이 지난 상태로 재시작 | 연장한 TTL 로 복원 | `test_aof_extended_ttl_survives_replay` |
| 주기 정리 간격을 길게 준 `everysec` | 쓰기 뒤 약 1초 안에 fsync | `test_everysec_fsync_is_not_delayed_by_a_long_expire_cycle` |

## 테스트 페이지 실행

테스트 페이지는 [Jongeume/mini-react](https://github.com/Jongeume/mini-react) 저장소에서 실행합니다.

```powershell
.\mini-redis.exe                                   # 이 저장소
node backend/gomoku-api.js --redis-port 6379       # mini-react 저장소, http://127.0.0.1:8090/
node docs/demo/join-race.mjs                       # mini-react 저장소, 두 명을 동시에 입장시킵니다
node docs/demo/shots.mjs                           # mini-react 저장소, 시연 스크린샷을 다시 찍습니다
```

