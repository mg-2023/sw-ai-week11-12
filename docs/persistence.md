# 장애 복구 상세

README 3절의 근거 자료입니다. 동기화 정책별 동작, 재시작 전후 로그, AOF 파일 내용을 담았습니다.

| 방식 | 기록하는 것 | 재시작 시 | 강제 종료 시 잃는 범위 |
| --- | --- | --- | --- |
| RDB 방식의 스냅샷 (`--snapshot FILE`) | `SAVE` 시점의 키·값·만료 시각 전체 | 파일을 읽어 채웁니다. | 마지막 `SAVE` 이후의 모든 변경 |
| AOF (`--aof FILE`) | 상태를 바꾼 연산(`SET`, `DEL`, `PEXPIREAT`)을 실행 순서대로 | 처음부터 재생합니다. | 동기화 정책에 따라 다릅니다. |

- 만료 시각은 두 방식 모두 Unix ms 절대 시각으로 저장합니다. 서버가 꺼져 있던 시간도 TTL에서 빠지므로 TTL이 처음부터 다시 시작되지 않습니다.
- 스냅샷은 자체 형식입니다. `파일.tmp`에 끝까지 쓰고 fsync한 뒤에만 원래 이름으로 교체합니다. 쓰는 도중 종료되면 마지막 완성본이 그대로 남습니다. 체크섬이 맞지 않는 파일로는 시작하지 않습니다.
- AOF는 명령을 실행한 직후, 응답을 출력 버퍼에 넣기 전에 기록합니다. 마지막 레코드가 쓰다 만 상태이면 그 부분만 잘라 내고, 중간이 깨졌으면 시작하지 않습니다.

| `--appendfsync` | 동작 | 쓰기·동기화 실패 시 |
| --- | --- | --- |
| `always` | 레코드마다 write와 fsync가 끝난 뒤 응답합니다. | 응답하지 않고 서버를 종료합니다. 클라이언트는 연결 끊김으로 결과를 알 수 없음을 확인하고, 재시작 후 상태는 디스크 기준입니다. |
| `everysec` (기본) | write 뒤 바로 응답하고 fsync는 약 1초마다 합니다. | write 실패는 `always`와 같습니다. 주기 fsync가 실패하면 서버를 종료합니다. |
| `no` | fsync를 운영체제에 맡깁니다. | write 실패는 `always`와 같습니다. |

`v1 저장 → 기준 시점 → v2 갱신 → 강제 종료 → 2초 뒤 재시작 → GET` 결과입니다(`python examples/demo.py recovery-snapshot`, `recovery-aof`).

- 강제 종료 조건 : `process.kill()`(Windows `TerminateProcess`)로 정상 종료 처리 없이 끝냈습니다.
- 동기화 정책 : AOF는 `--appendfsync always`로 실행했습니다.

| 확인 | 스냅샷 | AOF (always) |
| --- | --- | --- |
| `GET user:1` | `"v1"` (`SAVE` 이후의 v2는 잃음) | `"v2"` |
| `SET temp` 뒤 `DEL temp` 한 키 | `(nil)` | `(nil)` |
| `PX 1500`으로 저장한 `short` (꺼져 있던 2초 동안 만료) | `(nil)` | `(nil)` |
| `PX 10000`으로 저장한 `long`의 `PTTL` | `7972` | `7937` |

```text
재시작 전 (AOF)
[+      0ms] AOF  #1 append SET "user:1" (33 bytes, appendfsync=always, fsync done before reply)
[+      0ms] EXEC #1 conn=1 SET "user:1" "v1" -> OK | reply queued in output buffer (5 bytes)
[+     16ms] AOF  #3 append DEL "temp" (23 bytes, appendfsync=always, fsync done before reply)
[+     16ms] AOF  #6 append SET "user:1" (33 bytes, appendfsync=always, fsync done before reply)

재시작 후 (AOF)
[+      0ms] LOAD aof demo-output\appendonly.aof: 6 records applied, 1 skipped as expired during downtime, 0 bytes of incomplete tail truncated, appendfsync=always
[+     31ms] EXEC #1 conn=1 GET "user:1" -> "v2" | reply queued in output buffer (8 bytes)

AOF 파일 내용 (레코드 하나를 한 줄로, CRLF 생략)
*3 $3 SET $6 user:1 $2 v1
*2 $3 DEL $4 temp
*5 $3 SET $5 short $1 s $4 PXAT $13 1794829972985
*3 $3 SET $6 user:1 $2 v2
```
