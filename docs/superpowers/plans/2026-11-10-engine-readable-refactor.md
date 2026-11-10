# 엔진 코드 읽기 좋게 정리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `src/component.js` · `src/hooks.js` 를 동작은 그대로 두고, 위에서 아래로 읽으면 엔진 흐름이 보이게 구조만 정리한다.

**Architecture:** 긴 함수를 이름 붙은 단계 함수로 쪼개고, 파일 안을 구역(펼치기 · 정상 흐름 · 실패 처리 · 측정)으로 나눈다. 새 파일은 만들지 않는다. 기존 테스트 176개가 동작 보존의 증거다.

**Tech Stack:** 바닐라 JS (UMD 패턴), `node --test` + jsdom

**Spec:** `docs/superpowers/specs/2026-11-10-engine-readable-refactor-design.md`

## Global Constraints

- 테스트 파일(`test/*.js`)은 한 글자도 고치지 않는다
- 새 파일을 만들지 않는다 (`test/phase2-page.test.js:9` 가 스크립트 목록을 직접 적는다)
- 공개 API 그대로 : `hooks.js` 는 `getCurrent, setCurrent, setInChild, nextSlot, depsChanged, useState, useMemo, useEffect`, `component.js` 는 `FunctionComponent, expand`
- 테스트가 직접 만지는 이름 그대로 : 메서드 `run · mount · update · destroy · onCommit · inspect`, 필드 `hooks · hookIndex · hookCount · vdom · pendingUpdate`, report 칸 `kind · ms · compared · eventOnly · patches · hookCount · recovered`
- 예외 문구는 글자 그대로 옮긴다 (테스트가 `/Hook/` · `/종류/` · `update loop` 등으로 잡는다)
- 검사 · 실행 순서를 바꾸지 않는다 (예 : `nextSlot` 의 자식 → 컴포넌트 밖 → 개수 → 종류 순서)
- 주석은 지금처럼 함수마다 한 줄 한국어. 파일 맨 위에 흐름 지도 주석
- 커밋은 로컬 `refactor/engine-readable` 에만, push 없음, 커밋 메시지에 Claude 표시 없음

## Review Focus

- 커밋 중(effect 안) setState → 커밋 뒤 이어서 갱신 : `phase` 를 `commit` 으로 두는 범위가 원래와 같아야 한다 (`test/effect.test.js`, `test/update.test.js` 가 잡음)
- 렌더 예외 → 값 되돌리기, patch 예외 → 통째로 다시 그리기 → 그것도 실패하면 이전 화면 + 값 되돌리기 : 세 갈래 순서 보존 (`test/update.test.js`)
- effect 안에서 `destroy` : 남은 effect 를 멈추고 새 cleanup 을 바로 실행 (`test/effect.test.js`)
- 같은 값 setState → 렌더 없이 입력칸만 맞춤 (`test/update.test.js`)
- 브라우저 실제 페이지 : jsdom 이 아닌 실제 브라우저에서 시나리오 다섯 개 (Task 3)

모두 기존 테스트가 이미 잡는다. 새 테스트는 추가하지 않는다 (리팩토링이므로).

---

### Task 1: `component.js` 를 네 구역으로 정리

**Files:**
- Modify: `src/component.js` (전체)
- Test: 기존 `test/*.test.js` 전부 (무수정)

**Interfaces:**
- Consumes: `hooks.js` 의 `setCurrent · setInChild` (그대로)
- Produces: 공개 API 그대로. 새 내부 메서드 이름 (아래)

- [ ] **Step 1: 기준선 확인** — Run: `npm test` / Expected: `# pass 177`, `# fail 0`

- [ ] **Step 2: 구역 나누기** — 파일 안 순서를 다음으로
	1. 맨 위 흐름 지도 주석 (mount · update 한 바퀴를 5줄 안팎)
	2. 펼치기 구역 : `countPatches` 를 제외한 `normalize · callChild · expandAll · expand`
	3. 클래스 안 정상 흐름 : `constructor · mount · update · updateOnce · renderTree · run · runEffects · destroy`
	4. 클래스 안 실패 처리 : `renderOrUndo · applyOrRecover · swapChildren · settle · flushPending · restoreQueued · finishCommit · resyncForms`
	5. 클래스 안 측정 : `report · onCommit · inspect`, 그리고 파일 수준 `countPatches`

- [ ] **Step 3: 단계 함수로 쪼개기** — 새 내부 메서드
	- `wrapInContainer(tree) → vdom` : `{ type: container.localName, props: {}, children: tree ? [tree] : [] }` (mount · updateOnce 의 중복 제거)
	- `inCommitPhase(fn) → fn 의 결과` : `phase = 'commit'` → `fn()` → `finally phase = 'idle'`
	- `renderOrUndo(undo) → tree` : `renderTree()` 예외 시 `undo` 부르고 다시 던짐
	- `applyOrRecover(patches, vdom, undo) → recovered(boolean)` : 지금 `updateOnce` 의 이중 try 를 그대로 옮김
	- `runOneEffect({ slot, fn, deps })` : `runEffects` 반복문 몸통 (예외는 부른 쪽에서 모음)
	- 결과적으로 `updateOnce` 는 "시작 시각 → 렌더 → diff → 커밋(patch · effect · 보고)" 네 줄 흐름이 보여야 한다

- [ ] **Step 4: 테스트** — Run: `npm test` / Expected: `# pass 177`, `# fail 0`

- [ ] **Step 5: 커밋** — `git add src/component.js` → 커밋 본문 3단 (필요한 것 → 걸리는 것 → 그래서 한 것)

### Task 2: `hooks.js` 정리

**Files:**
- Modify: `src/hooks.js` (전체)

**Interfaces:**
- Consumes: 컴포넌트 필드 `hooks · hookIndex · hookCount · phase · destroyed · queued · pendingUpdate`, 메서드 `update · resyncForms`
- Produces: 공개 API 그대로

- [ ] **Step 1: `nextSlot` 쪼개기**
	- `assertHookAllowed()` : 자식 안 · 컴포넌트 밖 검사 (이 순서)
	- `takeIndex(comp) → number` : 개수 검사 후 `hookIndex` 를 1 올리고 이전 번호를 돌려줌
	- `slotAt(comp, i, kind, make) → slot` : 없으면 만들어 넣고, 있으면 종류 검사
	- `nextSlot(kind, make)` 는 세 줄로 위 셋을 부른다

- [ ] **Step 2: `makeSetter` 갈래에 이름 붙이기**
	- `resolveNext(next, prev)` : 함수면 `next(prev)`, 아니면 `next`
	- `queueAfterCommit(comp, hook, prev)` : 같은 hook 이 없을 때만 `queued` 에 넣고 `pendingUpdate = true`
	- setter 몸통 순서 그대로 : 렌더 중 예외 → 없어짐이면 끝 → 같은 값이면 `resyncForms` → 값 바꾸기 → 커밋 중이면 줄 세우기 → 아니면 `update(undo)`

- [ ] **Step 3: 파일 맨 위 흐름 지도 주석** — "번호표 사물함" 흐름 4줄 안팎

- [ ] **Step 4: 테스트** — Run: `npm test` / Expected: `# pass 177`, `# fail 0`

- [ ] **Step 5: 커밋** — `git add src/hooks.js`

### Task 3: 실제 브라우저 확인 · 검증 요청 준비

- [ ] **Step 1:** 로컬 서버(`.claude/launch.json` 의 `mini-react`)로 `phase2.html` 을 열고 추가 · 체크 · 삭제 · 시나리오 다섯 개를 누른다 / Expected: 콘솔 오류 0, 기록 표 5줄
- [ ] **Step 2:** Codex 검증 요청문 준비 — 넣는 것 : 설계 문서 경로, 브랜치 · 커밋 범위, `npm test` 실행법. 넣지 않는 것 : 우리 테스트 결과 · 결론
