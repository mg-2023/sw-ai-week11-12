# 이벤트 배칭 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 엔진 이벤트 핸들러 안에서 불린 setter 들을 모아, 핸들러가 끝날 때 갱신을 한 번만 하게 한다 ('추가' 클릭 갱신 2 → 1).

**Architecture:** `hooks.js` 에 배칭 깊이 · 갱신할 컴포넌트 목록과 `batch(fn)` 을 둔다. 배칭 중 setter 는 값을 바로 저장하고 기존 `queued` 줄 세우기를 재사용한다. 바깥 `batch` 가 끝나면 컴포넌트마다 기존 `settle([])` 로 한 번 갱신한다. `component.js` `expand` 가 `on*` 핸들러를 `batch` 로 감싼다. 갱신은 계속 동기다.

**Tech Stack:** 바닐라 JS (UMD 패턴), `node --test` + jsdom

**Spec:** `docs/superpowers/specs/2026-11-11-event-batching-design.md`

## Global Constraints

- 기존 테스트 177개의 기대값을 바꾸지 않는다 (새 테스트 추가는 된다)
- 새 **스크립트** 파일을 만들지 않는다 (`test/phase2-page.test.js:9` 가 스크립트 목록을 직접 적는다). 새 테스트 파일 `test/batch.test.js` 는 된다
- Phase 1 파일(`src/vdom.js` · `src/diff.js` · `src/patch.js` · `src/history.js`)은 고치지 않는다
- 과제 제약 유지 : Hook · 상태는 루트에서만, 자식은 props 만 받는 순수 함수
- 갱신은 동기다 : setter · 클릭이 돌아온 직후 DOM 이 이미 바뀌어 있어야 한다 (배칭 중이면 바깥 `batch` 가 돌아온 직후)
- 기존 예외 문구 글자 그대로 (`/Hook/` · `/종류/` · `update loop` · `렌더 중 setState`)
- 주석은 함수마다 한 줄 한국어, 파일 맨 위 흐름 지도 주석에 배칭 한 줄 추가
- 커밋은 `feat-Jongeume` 로컬에만, push 없음. 커밋 메시지에 Claude 표시(Co-Authored-By · Generated with) 넣지 않음. 본문 3단 (필요한 것 → 걸리는 것 → 그래서 한 것)
- 테마 파일(`phase2.html` 의 기존 미커밋 변경 · `phase2/style.css`)은 이 작업 커밋에 섞지 않는다. `phase2.html` 은 버튼 한 줄만 staging 한다 (`git add -p`)

## Review Focus

1. 핸들러가 setter 를 부른 뒤 예외를 던짐 → 깊이가 0 으로 돌아오고, 그 전 상태는 반영되고, 다음 클릭은 평소처럼 (Task 2 테스트)
2. 배칭된 커밋의 effect 가 setter → 기존 후속 갱신 · `update loop` · `heldErrors` 계약 유지 (Task 2)
3. effect 안에서 엔진 버튼을 `click()` (커밋 중 컴포넌트에 배칭이 겹침) → 다시 들어가 그리지 않고 바깥 `settle` 이 처리 (Task 2)
4. 같은 함수를 다시 넘긴 렌더 → 감싼 함수도 같아 PROPS 패치가 생기지 않음 (`eventOnly` 수가 지금과 같음) (Task 3)
5. 이벤트 밖 setter (`set10` · 직접 호출 · 타이머) → 지금처럼 즉시 갱신, `set10` 10회 그대로 (기존 테스트)

참고 : jsdom · 브라우저 모두 이벤트 리스너 안의 예외는 `dispatchEvent` 를 부른 쪽으로 던지지 않고 window `error` 로 보고한다. 예외 테스트는 `H.batch` 를 직접 불러 확인한다.

---

### Task 1: 측정 시나리오 `addClick` 과 기준선

**Files:**
- Modify: `phase2/app.js` (시나리오 액션 · 준비 함수, `runScenario`)
- Modify: `phase2.html` (시나리오 버튼 한 줄, `set10` 버튼 다음)
- Test: `test/phase2-page.test.js` (끝에 테스트 추가)

**Interfaces:**
- Produces: `Phase2.prepares` 객체 (`id → 준비 함수`). `runScenario(id)` 는 준비 함수가 있으면 **`before` 를 찍기 전에** 부른다
- Produces: 시나리오 `addClick` — 준비 : 입력칸에 `'측정 항목'` 을 넣고 `input` 이벤트를 보낸다 / 액션 : 데모의 `button[type="submit"]` 을 `click()`

- [ ] **Step 1: 실패하는 테스트**

```js
test('addClick 은 준비(타이핑)를 빼고 추가 클릭만 잰다 — 배칭 전 기준선 2', () => {
  const win = loadPage();
  win.document.querySelector('[data-scenario="addClick"]').click();
  const r = win.Phase2.records[0];
  assert.strictEqual(r.scenario, 'addClick');
  assert.strictEqual(items(win).length, 3);
  assert.strictEqual(win.document.querySelector('#demo input[type="text"]').value, '');
  assert.strictEqual(r.renders, 2);
});
```

- [ ] **Step 2:** Run `npm test` / Expected : 새 테스트 1개 FAIL (버튼 없음), 나머지 177 PASS
- [ ] **Step 3:** `app.js` 에 `prepares` · `addClick` 액션, `runScenario` 의 준비 호출, `phase2.html` 에 `<button type="button" data-scenario="addClick">추가 클릭</button>`
- [ ] **Step 4:** Run `npm test` / Expected : `# pass 178`, `# fail 0`
- [ ] **Step 5: 커밋** — `git add phase2/app.js test/phase2-page.test.js` + `git add -p phase2.html` (버튼 줄만)

### Task 2: `hooks.js` 배칭과 `settle` 재사용

**Files:**
- Modify: `src/hooks.js` (`batch`, `makeSetter` 갈래, 흐름 지도 주석, api)
- Modify: `src/component.js` (`flushBatched` 메서드 — 3구역 "커밋 뒤 마무리")
- Create: `test/batch.test.js`

**Interfaces:**
- Produces: `H.batch(fn) → fn()` 의 반환값. api 와 `MiniReact` 에 공개
- Produces: `FunctionComponent#flushBatched()` — 없어졌거나 `phase !== 'idle'` 이거나 `pendingUpdate` 가 아니면 아무것도 안 함, 아니면 `this.settle([])`
- `makeSetter` 갈래 순서 : 렌더 중 예외 → 없어짐이면 끝 → 같은 값이면 `resyncForms` → 값 저장 → 커밋 중이면 줄 세움 → **배칭 중이면 줄 세움 + 갱신할 목록에 컴포넌트 추가** → 아니면 `update(undo)`
- 줄 세우는 함수 `queueAfterCommit` 은 이름을 `queueDeferred` 로 바꾸고 커밋 중 · 배칭 중 둘 다 쓴다 (주석 갱신)
- `batch` 의 끝 처리 (`finally`, 깊이 −1 뒤 깊이가 0 일 때만)
	1. 목록을 배열로 꺼내고 **먼저 비운다**
	2. 컴포넌트마다 `flushBatched()`, 예외는 모은다
	3. 핸들러가 던졌으면 : 모은 예외를 그 예외의 `heldErrors` 에 덧붙이고, 핸들러 예외를 그대로 던진다
	4. 핸들러가 정상이면 : 모은 예외가 1개면 그것, 여러 개면 `AggregateError` 를 던진다

- [ ] **Step 1: 실패하는 테스트** (`test/batch.test.js`, `update.test.js` 의 `start` 도우미 모양을 따라 `setup` · `FunctionComponent` · `onCommit` 보고 목록 사용)
	- `batch 안 setter 두 개 → 커밋 1회, 두 값 모두 반영`
	- `batch 안 n => n + 1 세 번 → 최종 +3, 커밋 1회`
	- `batch 밖 setter 는 지금처럼 바로 갱신 (setter 하나당 커밋 1회)`
	- `중첩 batch → 바깥이 끝날 때 커밋 1회`
	- `batch 안 setter 뒤 예외 → assert.throws 로 같은 예외, 값 반영 · 커밋 1회, 그 뒤 batch 가 다시 정상 동작`
	- `batch 커밋의 effect 가 setter → 커밋 2회, 최종값 반영` (`[n]` 의존성 effect 에서 `n === 1` 이면 `set(10)`)
	- `batch 커밋의 effect 가 끝없이 setter → update loop 예외, 값은 되돌림` (기존 `effect.test.js` 의 update loop 테스트 기대와 같은 모양)
	- `batch 안 렌더 예외 → 예외가 나오고 batch 안에서 바꾼 값이 모두 되돌려짐`
- [ ] **Step 2:** Run `node --test test/batch.test.js` / Expected : 새 테스트 FAIL (`H.batch` 없음)
- [ ] **Step 3:** 위 Interfaces 대로 구현
- [ ] **Step 4:** Run `npm test` / Expected : 기존 178 + 새 테스트 모두 PASS
- [ ] **Step 5: 커밋** — `git add src/hooks.js src/component.js test/batch.test.js`

### Task 3: `expand` 에서 핸들러 감싸기 · 기준선 갱신

**Files:**
- Modify: `src/component.js` (1구역 펼치기 : `expandAll` 이 만드는 노드의 props)
- Modify: `test/phase2-page.test.js` (Task 1 의 기준선 `2` → `1`, 테스트 이름도 "배칭 뒤 1")
- Test: `test/batch.test.js` (추가)

**Interfaces:**
- Consumes: `H.batch`
- Produces: 파일 수준 `wrapHandler(fn)` — WeakMap 캐시로 같은 `fn` 에는 같은 감싼 함수. 감싼 함수는 `this` 와 인자를 그대로 넘겨 `H.batch(() => fn.apply(this, args))`
- `expandAll` 이 돌려주는 호스트 노드의 props 는, `on` 으로 시작하고 값이 함수인 칸만 감싼 **새 props 객체**로 만든다 (원래 props 객체는 고치지 않는다)

- [ ] **Step 1: 실패하는 테스트**
	- `batch.test.js` : `클릭 핸들러에서 setter 두 개 → 커밋 1회` (버튼 `dispatchEvent(new window.MouseEvent('click', { bubbles: true }))`)
	- `batch.test.js` : `같은 핸들러 함수를 다시 넘긴 렌더는 PROPS 패치가 없다` (컴포넌트 밖에 만든 함수를 핸들러로 쓰고, 다른 상태만 바꿔 다시 렌더 → 마지막 보고의 `patches.PROPS === 0`)
	- `batch.test.js` : `effect 가 엔진 버튼을 click() 해도 다시 들어가 그리지 않는다` (그 클릭 핸들러의 setter 는 바깥 `settle` 이 처리 → 최종값 반영, 예외 없음)
	- `phase2-page.test.js` : Task 1 테스트의 `renders` 기대를 `1` 로
- [ ] **Step 2:** Run `npm test` / Expected : 위 새 테스트와 기준선 테스트 FAIL
- [ ] **Step 3:** `wrapHandler` · `expandAll` 수정, `component.js` 흐름 지도 주석에 "펼칠 때 on* 핸들러를 batch 로 감싼다" 한 줄
- [ ] **Step 4:** Run `npm test` / Expected : 전부 PASS, 기존 177개 기대값 무수정 (`git diff da345d9 -- test/` 에서 기존 줄 변경이 Task 1 테스트의 `2 → 1` 하나뿐)
- [ ] **Step 5: 커밋** — `git add src/component.js test/batch.test.js test/phase2-page.test.js`

### Task 4: 실제 브라우저 측정 · 검증 요청 준비

- [ ] **Step 1:** 로컬 서버(`.claude/launch.json` 의 `mini-react`)로 `phase2.html?v=batch` 를 열고, 버전 칸에 `v1 배칭` 을 넣고 시나리오 여섯 개를 누른다 / Expected : 콘솔 오류 0, `addClick` 렌더 1, `set10` 렌더 10
- [ ] **Step 2:** 배칭 전 기준(`da345d9` 를 임시 worktree 로 열거나 Task 1 커밋 시점)과 표를 나란히 둔다. 렌더 · 비교는 계산 비용, patch · DOM 변경은 DOM 비용으로 따로 적는다. `reverse` · `prepend` 숫자는 key 판단용으로만 남긴다
- [ ] **Step 3:** 데모 손 확인 : 추가 · 체크 · 삭제 · 타이핑, 탭 제목
- [ ] **Step 4:** Codex 검증 요청문 준비 — 넣는 것 : 설계 문서 경로, 과제 원문 경로, 브랜치 · 커밋 범위(`da345d9..HEAD`), `npm test` 실행법. 넣지 않는 것 : 우리 테스트 결과 · 결론
