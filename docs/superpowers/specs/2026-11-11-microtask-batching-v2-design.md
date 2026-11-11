# v2 마이크로태스크 배칭 — 짧은 설계

- 날짜 : 2026-11-11
- 브랜치 : `feat-Jongeume` (로컬, push 는 "올려" 뒤)
- 대상 : `engines/v2-microtask/` (새 고정본), `test/v2-microtask.test.js`, `omok/loader.js` · `omok/panel.js`

## 왜

- v1 (이벤트 경계)은 엔진이 감싼 핸들러 안의 setter 만 묶는다
- 타이머 · `await` 뒤 · 앱이 직접 붙인 리스너의 setter 는 setter 마다 렌더한다 (오목 : 타이머 1초 커밋 2, 저장 `await` 뒤 커밋 2)
- React 18 처럼 "지금 실행 중인 코드가 끝나면 한 번" 으로 넓혀 v1 과 비교한다

## 접근 (고른 것 : 가)

| 안 | 내용 | 결과 |
| --- | --- | --- |
| 가. 별도 엔진 | `engines/v2-microtask` 에 만들고 전용 비동기 테스트. `src` 는 v1 그대로 | **사용자 선택** — 기존 테스트 194개 무수정, 오목에서 바로 비교 |
| 나. `src` 를 v2 로 | 작업본 자체를 비동기로 | 테스트 100개 안팎을 `await` 로 옮겨야 해서 발표 전엔 무거움 |

## 동작

1. setter : 값을 바로 저장하고 `queueDeferred` 로 줄 세운 뒤 컴포넌트를 예약 목록에 넣는다
	- 예약 목록이 처음 생길 때만 `queueMicrotask(flushScheduled)` 를 한 번 건다
	- 이벤트 안 · 밖을 가리지 않는다. 핸들러 감싸기(`wrapHandler`)와 `batch` 는 v2 에서 뺀다
2. 같은 값 setter : 렌더 없이 예약만 한다. 예약을 비울 때 밀린 갱신이 없으면 `resyncForms` 로 입력칸만 맞춘다
3. 커밋 중 setter : v1 과 같다 (`settle` 이 커밋 뒤 이어서 갱신)
4. `flushSync(fn)` : `fn` 안의 setter 를 그 자리에서 바로 반영하고 돌아온다. 예외는 부른 쪽으로 던진다
5. 마이크로태스크에서 반영하다 생긴 예외 : 값은 기존 `restoreQueued` 로 되돌리고, 예외는 `reportError` (없으면 `console.error`) 로 보고한다
	- 부른 쪽이 이미 끝난 뒤라 던질 곳이 없다 — v1 과 다른 계약
6. `mount` 와 공개 `update()` 는 지금처럼 동기

## 완료 조건

- `test/v2-microtask.test.js` 통과
	- setter 두 개 → 직후 커밋 0, 마이크로태스크 뒤 커밋 1 · 두 값 반영
	- 함수형 `+1` 세 번 → `+3`, 커밋 1
	- 클릭 핸들러 안 setter 두 개 → 클릭 직후 0, 뒤에 1
	- `flushSync` → 직후 반영 · 커밋 1, 뒤에 추가 커밋 없음
	- 커밋의 effect 가 setter → 후속 커밋 1 더
	- 예약된 렌더 예외 → 값 되돌림 · 오류 보고
	- 예약 뒤 `destroy` → 렌더 없음
- 기존 테스트 기대값 무수정
- 오목에서 엔진 v2 를 고르면 타이머 1초 · 저장 `await` 뒤가 각각 커밋 1
