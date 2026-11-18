# Mini DBMS 실행 방법

MinGW-w64 GCC 13 이상(posix 스레드 모델, winpthreads), `mingw32-make`, Python 3.9 이상이 필요하다. 저장소 루트에서 실행한다.

```powershell
mingw32-make
.\build\mini-dbms.exe run .\tests\sql\basic_insert_select.sql
Get-Content .\tests\sql\basic_insert_select.sql -Raw | .\build\mini-dbms.exe run -
```

```text
mini-dbms run <file.sql|-> [--data DIR] [--sync always|none] [--repair]
```

`-`는 표준 입력을 끝까지 읽는다. SQL 파일은 UTF-8이며, 시작의 UTF-8 BOM도 허용한다. `INSERT`와 `SELECT`를 지원하며 여러 문장을 `;`로 구분한다.

기본 데이터 폴더는 현재 작업 디렉터리의 `data`다. 다른 폴더를 쓰려면 먼저 폴더를 만들고 `data/catalog.txt`를 복사한다.

```powershell
New-Item -ItemType Directory -Path .\local-data
Copy-Item .\data\catalog.txt .\local-data\catalog.txt
.\build\mini-dbms.exe run .\tests\sql\basic_insert_select.sql --data .\local-data --sync always
```

`--sync always`가 기본이며 INSERT마다 디스크 동기화를 마친 뒤 성공을 출력한다. `--sync none`은 동기화를 생략한다. 이 경우 장애 때 성공 응답을 받은 쓰기도 유실될 수 있으며, 실행 시 표준 에러에 경고한다.

쓰다 중단된 끝 레코드는 시작할 때 자동으로 잘라 복구한다. 완전한 레코드의 CRC 오류 등 손상은 시작을 거부한다. `--repair`는 첫 손상 지점부터 이후 데이터를 모두 잘라내되, 자르기 전에 잘라 낼 바이트를 `<table>.tbl.repair-<날짜-시각>` 으로 복사하고 표준 오류에 자른 위치 · 바이트 수 · 백업 이름 · 그 구간에서 찾은 정상 레코드 수를 알린다. 지워진 id 는 다시 쓰지 않는다.

```powershell
.\build\mini-dbms.exe run - --data .\local-data --repair
```

결과와 `error at L:C: ...` 오류는 표준 출력으로 보낸다. 성공 종료 코드는 0, 오류는 1이다. SQL은 첫 오류에서 멈추며 앞서 성공한 문장과 저장 내용은 유지된다. 오류 뒤에 이미 완료된 문장 수를 출력한다(SELECT도 포함). 옵션 사용법과 동기화 생략 경고는 표준 에러로 보낸다. `--data`가 가리키는 폴더는 한 프로세스만 열 수 있다.

```powershell
mingw32-make test
python tests/run_cli_tests.py
```

첫 명령은 C 단위 테스트와 CLI 기능 테스트를 모두 실행한다. 두 번째는 CLI 테스트만 실행하며, 빌드된 `build/mini-dbms.exe`가 필요하다. CLI 테스트는 매번 `build` 아래 임시 데이터 폴더에 카탈로그를 복사하고 정리한다.
