# Phase 2 벤치 실측

2026-11-18에 아래 명령을 한 번 실행했다. 종료 코드는 0이었다. 아래 수치는 실행 파일의 실제 표준 출력이며 추정값이나 속도 배율을 덧붙이지 않았다.

```powershell
.\build\mini-dbms.exe bench --rows 1000000 --data build/bench-1000000-task10 --queries 100 --seed 42
```

실행 환경: Microsoft Windows NT 10.0.19045.0, Intel(R) Core(TM) i5-8265U CPU @ 1.60GHz, x86_64 MinGW-w64 GCC 13.2.0 (posix-seh). 빌드 옵션은 `-std=c11 -O2 -Wall -Wextra -Wpedantic -Werror`, 링크는 `-pthread -lws2_32`다. CPU와 OS는 로컬 시스템 정보를 직접 읽었으며, 시스템 RAM 용량은 CIM 접근 거부로 확인하지 못했다.

새 데이터 폴더에 users를 1000행씩 SQL INSERT로 넣은 뒤 DB를 닫고 다시 열었다. `startup_ms`는 이 재열기 전체 시간이다. 조회는 같은 무작위 id에 대한 id 조건과 유일한 name 조건을 번갈아 실행하고, 두 경로 모두 같은 전체 행과 실제 plan·조사 수를 검사한다. 표의 시간은 `StmtResult.elapsed_us`에서 집계하며 SQL 파싱·결과 검증·출력 시간은 제외한다. 중앙값은 가운데 값(짝수면 두 값의 평균), p99는 nearest rank다.

`first`는 재열기 뒤 첫 조회 묶음, `repeat`는 같은 seed의 조회 순서를 반복한 묶음이다. 둘 다 파일 작성과 시작 검사 직후의 따뜻한 OS 캐시 상태다. 설계 2.9에서 요청한 **OS 캐시에 파일이 없는 첫 실행은 확인하지 못했다**. 캐시 제거를 수행하지 않았으므로 콜드 캐시 결과를 제시하지 않는다. 각 묶음에서 index와 scan을 각각 100번 측정했으며, 100만 건을 새로 삽입하는 벤치 명령 자체는 한 번만 실행했다.

`peak_memory_bytes`는 Windows `PeakWorkingSetSize`로 직접 읽은 프로세스 수명 전체의 최대 작업 집합 바이트다. 삽입·재구축·조회 메모리를 포함하며 인덱스 전용 할당량은 아니다. `sync none`이므로 동기화 이후의 행은 OS 장애 시 손실될 수 있다는 경고와 실제 추가 행 수가 표준 오류에도 출력되었다.

실제 표준 출력:

```text
rows=1000000 queries=100 seed=42 batch_rows=1000 sync=none
cache: first=warm OS cache after INSERT and reopen; repeat=same query sequence
insert_total_ms: 16510.022
startup_ms: 370.365
| pass | plan | queries | rows/result | rows_examined/query | median_ms | p99_ms | max_ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| first | index | 100 | 1 | 1 | 0.037 | 0.089 | 0.109 |
| first | scan | 100 | 1 | 1000000 | 354.507 | 469.273 | 488.369 |
| repeat | index | 100 | 1 | 1 | 0.036 | 0.065 | 0.079 |
| repeat | scan | 100 | 1 | 1000000 | 356.132 | 509.708 | 537.231 |
peak_memory_bytes: 41705472
```

## 재부팅 뒤 `--query-only` 로 콜드 캐시 첫 실행을 재는 방법

위 표의 `first` 는 방금 쓰고 다시 연 파일이라 OS 캐시가 따뜻하다. 캐시에 파일이 없는 첫 실행은 사람이 재부팅해야 만들 수 있다. 아래 절차로 같은 데이터에서 잰다. 이 문서에는 아직 콜드 캐시 숫자가 없다. 재부팅을 하지 않았기 때문이며 숫자를 추정해 적지 않는다.

1. 데이터를 한 번 만든다. 삽입 시간이 목적이 아니므로 실행 결과는 따로 쓰지 않아도 된다.

   ```powershell
   .\build\mini-dbms.exe bench --rows 1000000 --data build/bench-cold --queries 100 --seed 42
   ```

2. 컴퓨터를 재부팅한다. 다른 프로그램을 열기 전에 다음 단계로 간다. 백신 · 인덱싱이 방금 파일을 읽으면 캐시가 데워지므로 `build/bench-cold` 는 열지 않는다.
3. 삽입 없이 열어서 시작 시간과 조회 묶음만 잰다.

   ```powershell
   .\build\mini-dbms.exe bench --query-only --data build/bench-cold --queries 100 --seed 42
   ```

4. 읽는 법
   - `startup_ms` 는 파일 전체를 검사하고 인덱스를 세우는 시간이다. 이 단계에서 파일을 처음 읽으므로 콜드 캐시의 영향이 가장 크다.
   - `first` 묶음은 시작이 끝난 직후라 시작 검사가 읽은 만큼 캐시가 데워져 있다. 파일이 RAM 보다 커서 앞부분이 밀려났다면 `first` 의 scan 에 콜드 읽기가 섞일 수 있다. 이 도구는 어느 쪽인지 구별하지 않는다. 숫자를 보고 `repeat` 와의 차이로 짐작만 하고, 확인된 사실처럼 쓰지 않는다.
   - 조회마다 index 와 scan 의 순서를 번갈아 바꾸므로 한쪽이 늘 먼저 도는 편향은 없다.
5. 같은 재부팅 후 상태를 한 번만 만들 수 있다. 한 번 실행하면 캐시가 데워지므로 다시 재려면 다시 재부팅한다. 결과를 이 문서에 쓸 때는 날짜 · 재부팅 여부 · 실제 표준 출력 전체를 붙인다.
