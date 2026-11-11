# README 사실 확인 — 코드와 대조한 결과

> 작성 : Claude Code (11-11). **자체 확인이며 최종 검증이 아니다.** 독립 검증은 Codex 몫이다.
> 대상 커밋 : `c41ba51` (작업 트리의 소스 · 테스트는 수정하지 않음)

## 확인 방법

| 방법 | 무엇을 | 언제 |
| --- | --- | --- |
| 코드 읽기 | `engines/v2-microtask/*.js` 전체, `omok/game.js` · `loader.js` · `panel.js`, v1 과 v2 `hooks.js` 차이 | 11-11 |
| 파일 비교 | `diff engines/{v0,v1-batch}/X.js engines/v2-microtask/X.js` (X = vdom · diff · patch) | 11-11 |
| 테스트 실행 | `npm test` → `tests 202 · pass 202 · fail 0`. 그중 1개는 `test/helpers.js` 파일 자체 → 실제 테스트 케이스는 **201개** (`test(` 선언 수로 확인) | 11-11 |
| 브라우저 측정 | 로컬 서버로 `index.html?engine=v0 / v1-batch / v2-microtask` 를 새로 열고, `Omok.app.onCommit` 으로 커밋을 세며 **두 수 착수 → 전체 초기화 → `Omok.tick()` → 저장 버튼(첫 저장)** 순서로 실행. 커밋은 그때의 `Omok.cause` 로 걸러 셈 (타이머 커밋 섞임 방지) | 11-11 |
| 독립 검증 | Codex 에 원본 요구사항 · 코드 위치만 넘겨 읽기 전용 검증 · 자문 요청 → 결과는 맨 아래 | 11-11 |

---

## 1. 소개 · 아키텍처

| README 주장 | 근거 | 판정 |
| --- | --- | :---: |
| 외부 라이브러리 없음, 개발 의존성은 `jsdom` 만 | `package.json` | 일치 |
| Phase 1 : State History 뒤로 · 앞으로 | `phase1/history.js`, `phase1/app.js` `travel` | 일치 |
| 데모 기본 엔진은 v2 | `omok/loader.js` `DEFAULT = 'v2-microtask'` | 일치 |
| `App` 의 자식 컴포넌트 6종 | `omok/game.js` : PlayerCard · GameInfo · Cell · Board · MoveList · SaveBox | 일치 |
| `game.js` → `vdom` (`h`), → `hooks` (Hook 호출) | `game.js:5` 구조 분해 | 일치 |
| `panel.js` → `component` (생성 · mount · onCommit) | `panel.js` 끝 `new FunctionComponent` · `onCommit` · `mount` | 일치 |
| `hooks` -.-> `component` (예약을 비울 때 갱신 요청) | `hooks.js` `flushAll` 이 `comp.flushBatched()` 를 부름 — 모듈 import 가 아니라 객체 메서드 호출 | 일치 (점선으로 구분) |
| `component` → `hooks` (지금 그리는 컴포넌트 표시) | `component.js` `run` 의 `H.setCurrent`, `callChild` 의 `H.setInChild` | 일치 |
| `component` → `diff` · `patch` | `updateOnce` 의 `D.diff`, `applyOrRecover` 의 `P.applyPatches`, `mount` 의 `P.mount` | 일치 |
| `component` -.-> `vdom` (글자 노드 · 복구용 render) | `normalize` 의 `V.text`, `swapChildren` 의 `V.render`, `inspect` 의 `V.clone` | 일치 |
| `patch` → `vdom` (render · setProp) | `patch.js` 의 `V.render` · `V.setProp` | 일치 |
| `diff` 는 DOM 을 모름 | `diff.js` 는 다른 모듈을 `require` 하지 않음 | 일치 |
| 변경 목록 5종 | `diff.js` `walk` · `component.js` `countPatches` | 일치 |
| v0 · v1 · v2 의 vdom · diff · patch 가 같은 파일 | 파일 비교 결과 차이 없음 | 일치 |

## 2. 실행 흐름 · 설계 결정

| README 주장 | 근거 | 판정 |
| --- | --- | :---: |
| 착수(`place`)가 setter 2개를 부름 | `game.js` `place` : `setHistory` · `setMoveIndex` | 일치 |
| setter 는 값만 저장하고 줄 세움 | `hooks.js` `makeSetter` → `hook.value = value` · `queueDeferred` | 일치 |
| `queueMicrotask` 는 한 번만 | `schedule` 의 `microtaskQueued` 검사 | 일치 |
| 예약 비우기 → `flushBatched` → `settle` → `flushPending` → `updateOnce` | `flushFromMicrotask` → `flushScheduled` → `flushAll` → `comp.flushBatched` → `settle` → `flushPending` → `updateOnce` | 일치 |
| `App()` 다시 실행, Hook 번호 0부터 | `run` 의 `this.hookIndex = 0` | 일치 |
| 자식은 `App` 이 아니라 엔진(`expand`)이 불러 펼침 | `renderTree` 의 `expand(this.run())` → `expandAll` → `callChild` | 일치 (첫 판은 "App 이 펼친다" 처럼 그려 Codex 지적 후 고침) |
| diff → applyPatches → runEffects 순서 | `updateOnce` | 일치 |
| setter 직후 DOM 은 옛 모습, 바로 읽으려면 `flushSync` | `schedule` 은 예약만, `flushSync` 는 `syncDepth` 0 에서 `flushScheduled` | 일치 |
| 예약된 렌더의 예외 → 값 되돌림 + `reportError` | `flushFromMicrotask` 의 `reportError`, `flushPending` 의 undo(`restoreQueued`) | 일치. 단 테스트(`v2-microtask.test.js:110`)는 `reportError` 가 없는 jsdom 에서 **`console.error` 대체 경로**만 확인 |
| v1 은 엔진이 붙인 핸들러만 **자동으로** 묶음 | `engines/v1-batch/component.js` `wrapHandler` → `H.batch`. 공개 `batch(fn)` 로 직접 감싸면 타이머도 묶임 (`v1-batch/hooks.js` api) | 일치 (첫 판의 "못 묶었다" 를 "자동으로 묶지 못했다" 로 고침) |
| 배칭 범위 | 예약된 마이크로태스크가 돌기 **전에** 모인 변경만 한 번에. 다른 마이크로태스크 안의 setter 는 커밋이 따로 생긴다 (Codex 직접 실행) | README 표현을 "같은 작업 안" · "예약이 실행되기 전에 모인 변경" 으로 좁힘 |
| v0 에서 중간 상태를 한 번 그림 | v0 은 setter 마다 렌더하므로 `setHistory` 뒤 `moveIndex` 가 옛 값인 화면을 한 번 그린다 — **코드 추론**, 화면을 따로 캡처하지는 않음 | 추론 |
| 같은 값 setter 는 렌더하지 않음 (`Object.is`) | `makeSetter` 의 `Object.is(prev, value)` | 일치 |

**측정 표 (브라우저 직접 측정, 11-11)**

| 동작 | v0 | v1 | v2 | README |
| --- | :---: | :---: | :---: | :---: |
| 착수 | 2 | 1 | 1 | 일치 |
| 전체 초기화 (두 수 둔 뒤, 저장한 적 없음) | 4 | 1 | 1 | 일치 |
| 타이머 `Omok.tick()` | 2 | 2 | 1 | 일치 |
| 첫 저장 (800ms 기다림) | 3 | 3 | 2 | 일치 |
| 콘솔 · `error` 이벤트 | 0 | 0 | 0 | 일치 |

- **고친 것** : 첫 판 README 는 "전체 초기화 v0 = 4 인 이유 : `moveIndex` 가 이미 0" 이라고 적었다. 측정 때 `moveIndex` 는 2 였고, 그대로였던 값은 **`savedAt`(저장한 적 없음 = `null`)** 이다. Codex 가 판 상태에 따라 v0 가 2 ~ 5 로 달라짐을 재현해 지적했고, 측정 순서를 다시 보고 확인했다
- 같은 수를 다시 저장하면 `savedAt` 이 그대로라 v0 · v1 도 2 (Codex jsdom 측정) — README 에 조건으로 적음

## 3. 시연 · 검증

| README 주장 | 근거 | 판정 |
| --- | --- | :---: |
| 201개 통과 · 실패 0 (러너 집계 202) | `npm test` 출력 + `test(` 선언 수 | 일치 (첫 판의 "202개" 를 고침) |
| v2 전용 10개 | `test/v2-microtask.test.js` 의 `test(` 10개 | 일치 |
| 나머지 191개는 v1 기준 | 다른 테스트 파일 11개 모두 `engines/v1-batch` 를 `require` | 일치 |
| 무작위 트리 500쌍 | `test/patch.test.js:160` | 일치 |
| 패널에 hooks 10칸 | 측정 때 `Omok.app.hooks.length === 10` | 일치 |
| 엣지 : Hook 개수 · 종류 바뀜 → 예외 | `test/hooks.test.js:69` · `:89` | 일치 (v1) |
| 엣지 : 자식 안 `useState` → 예외 | `test/children.test.js:42` | 일치 (v1) |
| 엣지 : 렌더 중 `setState` → 예외 | `test/update.test.js:64` | 일치 (v1) |
| 엣지 : 렌더 예외 → 값 되돌림 · 화면 유지 | `test/update.test.js:83`, `test/v2-microtask.test.js:86` · `:110` | 일치 (v1 · v2) |
| 엣지 : 같은 값 setter → 렌더 0 | `test/update.test.js:35`, `test/v2-microtask.test.js:136` | 일치 (v1 · v2) |
| 엣지 : `n => n + 1` 세 번 → +3, 렌더 1 | `test/batch.test.js:34`, `test/v2-microtask.test.js:38` | 일치 (v1 · v2) |
| 엣지 : effect 무한 setter → 이어진 갱신 50번 뒤 예외, 마지막 묶음만 되돌림 | `test/effect.test.js:130`, `component.js` `flushPending` 의 `chain > 50` · `restoreQueued(deferred)` | 일치 (v1). 처음 값까지 되돌리는 것은 아님 |
| 엣지 : Hook 종류 변경 | `test/hooks.test.js:89` 는 칸의 `kind` 를 직접 바꿔 검사 — 실제 조건 분기로 바꾸는 사례는 아님 | 일치 (검증 강도는 약함) |
| 엣지 : 예약 뒤 destroy → 렌더 안 함 | `test/v2-microtask.test.js:127` | 일치 (v2) |
| 엣지 : 태그 글자를 HTML 로 해석 안 함 | `test/vdom.test.js:124` | 일치 (v1) |

## 4. 한계

| README 주장 | 근거 | 판정 |
| --- | --- | :---: |
| 착수 1번에 비교 노드 291 | 처음 판 첫 착수, v1 · v2 모두 `report.compared = 291` | 일치 |
| PROPS 233 중 이벤트만 바뀐 것 227 | 같은 측정의 `patches.PROPS = 233`, `eventOnly = 227` | 일치 |
| `key` 없음 | `diff.js` 가 자식을 번호로만 비교 | 일치 (수치는 README 에 쓰지 않음) |
| `useRef` 없음 · `live` 로 흉내 | `hooks.js` api 에 없음, `game.js` `live` | 일치 |
| 같은 종류 Hook 순서 바뀜은 못 잡음 | `slotAt` 은 종류만 검사 | 일치 (코드 근거, 테스트 없음) |
| 개선 4개는 미구현 | 코드에 없음, 볼트 노트 "v3 엔진 설계 — 개선 후보" 에 "아직 구현하지 않음" | 일치 |

---

## 일부러 README 에 넣지 않은 수치

| 수치 | 이유 |
| --- | --- |
| 팀 공통 테스트 v2 "55개 중 50 통과" | 이 저장소에 그 테스트가 없어 지금 다시 돌릴 수 없음 |
| 할 일 데모 '추가' 비교 56 → 25, patch 17 → 9 | 측정 페이지가 `c41ba51` 에서 지워져 재현 불가 |
| 목록 뒤집기 · 앞 삽입 patch 310 · 314 | 같은 이유 |
| Codex 교차 검증 21건 | Phase 1 때 기록이며 지금 엔진에 대한 검증이 아님 |

---

## Codex 독립 검증 (11-11, 읽기 전용)

> 넘긴 것 : 사용자 요청 원문 · 과제 원문 위치, 저장소 위치와 실행 방법. 이 문서의 결론은 "확인할 주장" 으로만 쓰라고 했다.
> 아래는 Codex 보고를 Claude Code 가 요약한 것이며, 지적마다 코드를 다시 열어 확인했다.

| Codex 지적 | Claude Code 확인 | 반영 |
| --- | --- | --- |
| 테스트는 201개 + 도우미 파일 1개 | `test(` 선언 201개 | README · 이 문서 고침 |
| 순서도에서 자식을 펼치는 주체가 `App` 처럼 보임 | `renderTree` 의 `expand(this.run())` | 순서도에 `C->>C: expand` 추가 |
| "바뀐 칸만 고침" 은 너무 좁음 (이벤트만 바뀐 PROPS 227개) | 첫 착수 측정과 같음 | "목록의 노드만 고침" |
| "어디서든 한 번" 은 과장 — 예약 전 모인 변경만 묶임 | `schedule` · `flushFromMicrotask` | NOTE · 설계 결정 표현 좁힘 |
| 전체 초기화 · 저장의 v0 수치는 판 상태에 따라 달라짐, 이유도 틀림 | 측정 순서 재확인 — `savedAt` 이 그대로였음 | 측정 조건 · 이유 고침 |
| v1 은 "못 묶는다" 가 아니라 "자동으로 안 묶는다" | `v1-batch/hooks.js` 에 `batch` 공개 | 고침 |
| 가이드 : "상태 10칸" → Hook 10칸 (state 6) | `game.js` `App` | 고침 |
| 가이드 : "Hook 순서가 바뀌면" 은 과장 (개수 · 종류만) | `slotAt` 은 종류만 검사 | 고침 |
| 가이드 : 타이머를 `flushSync` 하나로 감싸면 1번 | `flushSync` 는 끝에서 한 번만 `flushScheduled` | 예상 질문 답 고침 |
| 가이드 : 240초 꽉 참 · v0 전환 시 판 초기화 · 타이머가 마지막 커밋 칸을 덮음 | `panel.js` 엔진 고르기가 페이지 이동 | 220초 연습 · 탭 미리 열기 · 원인 줄 짚기 |
| 가이드가 오목 탭으로 전환 — "README 하나만" 요청과 충돌 | 요청 원문 | 시연은 선택으로 돌리고 기본은 README 만 |
| 설계 결정으로 마이크로태스크 배칭은 적절 | — | 유지 |
| Mermaid : 문법 오류는 못 찾음, GitHub 실제 렌더는 미확인 | — | 아래 "미검증" 에 남김 |

Codex 가 **재현하지 못한 것** : 실제 브라우저 측정(jsdom 으로만 재현), `file://` 로 열기, `npm test` 그대로 실행(샌드박스의 `spawn EPERM` — `--experimental-test-isolation=none` 로 202 통과 재현), GitHub Mermaid 렌더

## 아직 검증되지 않은 것

- Mermaid 그림이 GitHub 에서 실제로 렌더되는지 — push 전이라 GitHub 화면으로는 보지 못함 (Claude Code 의 브라우저 렌더 시도는 외부 스크립트 권한으로 막힘)
- 고친 뒤의 README 를 Codex 가 다시 본 것은 아니다
