# Phase 1 수정 기록 (구현자 보고, 독립 검증 아님) — 2026-11-18

이번 사용자 요청과 `docs/plans/2026-11-17-mini-dbms.md`, `docs/design/2026-11-17-design.md`를 직접 읽고 대조했다. 공통 `AI_ROLES.md`도 읽었다. 판정에 Claude Code의 자체 테스트나 보고는 사용하지 않았다.

## 직접 실행

테스트를 먼저 추가하고 기존 실행 파일에 `python tests/run_cli_tests.py`를 실행했다. 기대는 길이 손상 시 파일 보존·시작 거부, stdin/파일 바이트 동등성, 지정된 오류·경고 출력이었다. 실제 출력은 `CLI: 12 passed, 10 failed`였다. 길이 한 비트 손상에서 실제로 종료 0·0행이 나왔으며 stdin의 0x1A 뒤 입력도 잘렸다. 신규 콜백·오류 종류·읽기 계측을 사용하는 C 테스트는 구현 전 미정의 함수와 `DbError.kind` 부재로 컴파일 실패했다.

구현 후 최종 명령을 다음 순서로 직접 실행했고 모두 종료 코드 0이었다.

```text
mingw32-make clean
mingw32-make test
python tests/run_cli_tests.py
```

`mingw32-make test`의 실제 집계 출력은 다음과 같다. 순서대로 catalog, db, lexer, os, parser, table이다.

```text
13 passed, 0 failed
22 passed, 0 failed
18 passed, 0 failed
7 passed, 0 failed
22 passed, 0 failed
22 passed, 0 failed
CLI: 23 passed, 0 failed
```

C 테스트 합계는 104 통과·0 실패다. 별도 `python tests/run_cli_tests.py`도 `CLI: 23 passed, 0 failed`였다. 복구 테스트의 stderr에는 실제로 `28 bytes of incomplete tail truncated at offset 66`과 헤더 꼬리 1~11바이트에 대한 같은 형식의 메시지가 출력됐다. PowerShell은 합친 로그에서 이 정상 stderr를 `NativeCommandError`로 표시하지만 make의 종료 코드는 0이다.

회귀 테스트는 첫·중간 레코드 길이 손상과 파일 바이트 보존, 명시적 복구 후 앞 행 유지, 검사값 손상, 검사값이 맞는 길이 0·상한 초과, 헤더/본문 잘림, 40바이트 및 1 MiB 초과의 0 꼬리, 0 헤더 뒤 비영 바이트, CRC 손상, stdin의 0x1A 오류 위치·CRLF 저장 바이트, 카탈로그 중복·문자 제한, 없는 폴더와 실제 쓰기 행 수 경고를 확인한다. C 테스트는 헤더/본문의 블록 경계, 최대 크기 레코드, 시작 콜백, 콜백 실패 시 파일 보존, 4개 동시 스캔, 8개 동시 위치 지정 읽기와 CRT 파일 커서 보존, I/O 실패 종류와 repair 시 파일 보존을 확인한다.

## 직접 실행 — 성능 출력 원문

명령은 수정 전·후 모두 `python tests/measure_scan.py`다. Windows / MinGW-w64 GCC 13.2.0, 동일한 CFLAGS로 실행했다. `build/` 아래 임시 폴더에 `--sync none`으로 20만 행을 넣고 새 `db_open`과 같은 SELECT를 세 번 실행했다. 시작은 `db_open` 시간이며 프로세스 실행·SQL 파일 읽기를 제외한다. 데이터 작성 직후라 OS 캐시가 따뜻한 상태이며 콜드 캐시 측정은 아니다. 데이터·측정 실행 파일은 스크립트가 제거한다.

수정 전:

```text
warning: --sync none: acknowledged writes may be lost on crash
200000 rows, warm OS cache; three fresh db_open calls:
startup: 1868.142 ms
id     | name        | age
-------+-------------+----
200000 | user_199999 | 99
(1 row, plan=scan, examined=200000, 1897.070 ms)
startup: 1879.114 ms
id     | name        | age
-------+-------------+----
200000 | user_199999 | 99
(1 row, plan=scan, examined=200000, 1870.344 ms)
startup: 1867.092 ms
id     | name        | age
-------+-------------+----
200000 | user_199999 | 99
(1 row, plan=scan, examined=200000, 1889.656 ms)
```

최종 clean 빌드 후:

```text
warning: --sync none: rows written since the last synchronization may be lost on OS failure; rows written this run: 200000
200000 rows, warm OS cache; three fresh db_open calls:
startup: 65.256 ms
id     | name        | age
-------+-------------+----
200000 | user_199999 | 99
(1 row, plan=scan, examined=200000, 67.269 ms)
startup: 65.797 ms
id     | name        | age
-------+-------------+----
200000 | user_199999 | 99
(1 row, plan=scan, examined=200000, 70.682 ms)
startup: 64.590 ms
id     | name        | age
-------+-------------+----
200000 | user_199999 | 99
(1 row, plan=scan, examined=200000, 64.756 ms)
```

## 직접 읽음

- `src/table.c:10`, `:173`, `:224`, `:264`, `:312`: 12바이트 헤더, 검사값·길이·CRC 분류 순서, 시작 거부/repair 분기, 자동 복구 stderr, 새 형식 쓰기.
- `src/table.c:86`, `:138`, `:362`: 요청마다 별도 1 MiB 입력 버퍼와 재사용 행 작업 공간, 경계의 남은 바이트 보존, 시작 검사와 스캔이 공유하는 위치 지정 읽기. 시작 콜백은 검증된 id/오프셋을 순서대로 전달한다.
- `src/os.c:31`, `:48`, `:65`: 스레드별 읽기 이벤트 재사용·해제와 stdin 이진 모드. `_WIN32` 분기는 이 파일에만 있다.
- `src/catalog.c:30`, `:104`: ASCII 대소문자를 무시한 중복 거부. 기존 identifier 파서가 이름 문자 범위를 제한한다.
- `src/lexer.h:7`, `src/executor.c:18`, `src/db.c:117`, `src/result.c:88`: SQL/내부 오류 종류, 내부 오류 위치 0:0 유지, 내부 오류 출력 형식.
- `src/db.c:37`, `src/cli.c:93`: 폴더 존재 진단과 마지막 동기화 이후 손실 범위·이번 실행의 실제 추가 행 수 경고.

## 바꾼 파일

- 소스: `src/catalog.c`, `src/cli.c`, `src/db.c`, `src/db.h`, `src/executor.c`, `src/lexer.c`, `src/lexer.h`, `src/os.c`, `src/os.h`, `src/parser.c`, `src/result.c`, `src/table.c`, `src/table.h`.
- 테스트: `tests/run_cli_tests.py`, `tests/test_catalog.c`, `tests/test_db.c`, `tests/test_os.c`, `tests/test_table.c`, 신규 `tests/measure_scan.py`.
- 문서: `docs/architecture.md`, 신규 `docs/phase1-fix-record.md`.

기존 작업 트리에 있던 `docs/design/2026-11-17-design.md` 변경은 수정하지 않았다. git 커밋은 하지 않았다.

## 결정과의 차이·확인 못 함

요청한 결정과 다르게 구현한 항목은 없다. 콜백은 기존 `table_open`을 유지하고 `table_open_with_visitor`를 추가하여 제공한다. 경고는 기존 CLI처럼 영어로 손실 범위와 행 수를 표시한다. 인덱스·bench 제품 명령·서버 등 Phase 2·3 기능은 시작하지 않았다. 새 형식 결정에 따라 기존 8바이트 헤더 파일 자동 변환은 제공하지 않는다.

POSIX 분기는 직접 읽었지만 실행하지 않았다. 실제 OS 장애·전원 차단 및 메모리 고갈 상황은 실행하지 않았다. 파일 I/O 실패는 테스트 훅으로 주입하여 확인했으며 malloc 실패의 오류 종류는 코드를 직접 읽어 확인했다. Claude Code 주장만으로 통과 처리한 항목은 없다.

## 2차 수정

길이 검사값을 리틀 엔디언 길이 4바이트의 `CRC32/IEEE XOR 0x4D444231`로 바꿨다. 정상 헤더의 선언된 본문이 EOF를 넘을 때, 꼬리의 각 바이트 위치에서 헤더 검사값·본문 CRC가 맞는 완전한 레코드를 찾으면 손상으로 거부한다. 카탈로그 테이블·컬럼 이름은 lexer의 `lex_identifier_kind`로 검사하여 모든 키워드를 대소문자와 무관하게 거부한다. 제품 코드의 키워드 목록은 lexer 한 곳에만 있다.

**직접 실행 — 실패 먼저:** 구현 전 `python tests/run_cli_tests.py`는 23통과·4실패였다. 새 검사값, paired 손상, 꼬리 안 완전한 레코드, 예약어 이름 테스트가 실패했다. 별도 C 실행은 catalog 14통과·1실패, table 19통과·3실패였다. 원본 재현 명령에서도 paired 손상의 99→33바이트 절단과 예약어 카탈로그 허용을 직접 확인했다.

**직접 실행 — 최종:** `mingw32-make clean` 성공 후 `mingw32-make test`는 C 106통과·0실패(catalog 15, db 22, lexer 18, os 7, parser 22, table 22), CLI 27통과·0실패였다. 별도 `python tests/run_cli_tests.py`도 27통과·0실패였다. 단일 비트 손상·진짜 끝 잘림·0 꼬리 회귀 테스트를 유지했으며 paired 비트 32개를 첫·중간 레코드에 각각 적용해 거부와 바이트 보존을 확인했다.

`python .verify/independent_verify.py --case paired_length_risk`와 `--case reserved_identifier_risk`는 각각 1그룹·1실패, 종료 코드 1이었다. 스크립트가 기존 취약 동작을 기대하는 assertion을 유지하기 때문이다. 실제 paired 실행은 `invalid record length at offset 33`으로 거부했고 파일은 99→99바이트로 내용까지 같았다. 예약어는 `error at 1:1: reserved keyword cannot be a table name`으로 로드 단계에서 거부했으며 테이블 파일이 생성되지 않았다. 스크립트는 수정하지 않았고 실행 전후 SHA256은 `22A9DAAB485AC13517C571F489876E5D84DF903136096A1FE72DF7A0984CB697`로 같았다.

**직접 읽음:** `src/table.c:71`, `:179`, `:205`, `:339`, `:376`의 검사값·복구·쓰기·위치 지정 읽기와 `src/lexer.c:40`, `src/catalog.c:103`, `:118`의 공용 키워드 판정을 확인했다. 바꾼 파일은 `src/table.c/.h`, `src/lexer.c/.h`, `src/catalog.c/.h`, `tests/test_table.c`, `tests/test_catalog.c`, `tests/run_cli_tests.py`, `docs/architecture.md`, 이 기록이다. 결정과 다르게 구현한 항목은 없다. Global Constraints를 유지했고 Phase 2·3 작업과 git 커밋은 하지 않았다. **확인 못 함:** POSIX 실행과 실제 전원 차단. Claude Code 주장만으로 판정한 항목은 없다.
