# Phase 2 v0 기본 — 설계

- 날짜 : 2026-11-10
- 요구사항 : 볼트 `미니리액트/02 명세/요구사항 명세 — Phase 2.md` (R2-01 ~ R2-26, 원문 33 ~ 121 줄)
- 상태 : 사용자 확정 (11-10, "첫 번째 버전은 이대로 확정, 리팩토링 때 개선")

## 1. 의도

- 과제 Phase 2 (함수형 컴포넌트 · `useState` · `useEffect` · `useMemo`) 를 Phase 1 의 `diff` · `applyPatches` 위에 얹는다.
- **v0 = 기준선.** 요구사항만, 단순하고 읽기 쉬운 구조. 성능 최적화는 일부러 뺀다.
- 이후 실험 버전(v1 속도 · v2 초경량 · v3 DX)이 **같은 기능 · 같은 측정**으로 v0 와 비교된다. 그래서 v0 도 측정 숫자를 내놓아야 한다.

## 2. 목표 · 비목표

| 목표 | 비목표 (v0 에서 안 함) |
| --- | --- |
| R2-01 ~ R2-26 충족 | `key` 기반 자식 비교 |
| 상태 변경 → 루트 전체 다시 실행 → diff → 바뀐 곳만 patch | 바뀐 컴포넌트만 다시 실행 |
| 렌더마다 측정값 보고 (시간 · 비교 횟수 · patch 종류별 수) | Batching (원문 선택 과제) |
| 측정 페이지 : 데모 앱 + 측정 패널 + 시나리오 + 기록 표 | 이벤트 위임, Fiber, 동시성 |
| 엣지 케이스 8 묶음 단위 테스트 | 버전 전환 실제 동작 (v0 만 있음, 자리만) |

- 안티 목표 : v0 가 "빠르게 만들려는" 코드로 복잡해지는 것. 읽고 설명하기 쉬운 것이 우선.

## 3. 접근 (고려한 것)

| 안 | 내용 | 얻는 것 | 내주는 것 | 선택 |
| --- | --- | --- | --- | --- |
| A. 펼친 뒤 비교 | 컴포넌트 함수를 먼저 실행해 **태그만 있는 트리**로 펼치고, 그 트리를 Phase 1 `diff` 에 넘김 | Phase 1 코드가 거의 그대로. 흐름이 한 줄로 보임 | 상태가 바뀌면 루트부터 전부 다시 실행 | **✅ v0** |
| B. 컴포넌트 트리 유지 | VDOM 에 컴포넌트 노드를 남기고 diff 가 컴포넌트 단위로 내려감 | 바뀐 컴포넌트만 다시 실행 가능 | diff · patch 를 크게 고쳐야 함 | v1 후보 |
| C. 컴포넌트마다 컨테이너 | 컴포넌트마다 자기 DOM 영역을 따로 patch | 구현은 단순 | 자식 무상태 원문 제약과 맞지 않음, path 가 쪼개짐 | 버림 |

## 4. 구조

### 4.1 파일

| 파일 | 책임 | 새로 / 고침 |
| --- | --- | --- |
| `src/hooks.js` | "지금 렌더 중인 컴포넌트" 자리, `useState` · `useEffect` · `useMemo` | 새로 |
| `src/component.js` | `FunctionComponent` (mount · update · destroy · 측정 보고), 컴포넌트 펼치기 `expand` | 새로 |
| `src/diff.js` | `diff(old, new, stats?)` — 선택 인자 `stats.compared` 에 비교 횟수를 센다 | 고침 (하위 호환) |
| `src/vdom.js` | `h()` 가 `true` 도 버림 (React 와 같게) | 고침 |
| `src/patch.js` | `syncFormState` 가 값이 **다를 때만** 대입 (입력 중 커서 · 한글 조합 보호) | 고침 |
| `src/vdom.js` `setProp` | `value` 프로퍼티도 다를 때만 대입 | 고침 |
| `phase2.html` · `phase2/app.js` · `phase2/style.css` | 측정 페이지 | 새로 |
| `test/hooks.test.js` · `test/component.test.js` · `test/phase2-page.test.js` | 단위 · 기능 테스트 | 새로 |

- 의존 방향 : `component` → `hooks` · `diff` · `patch` · `vdom`. `hooks` 는 아무것도 안 부름 (자리만 가짐).
- 모듈 방식은 Phase 1 과 같다 : 즉시 실행 함수 + `module.exports` (Node) / `window.MiniReact` (브라우저).
- Phase 1 페이지 (`index.html` · `app.js` · `history.js`) 는 그대로 둔다. Phase 2 는 쓰지 않는다.

### 4.2 `FunctionComponent`

```
new FunctionComponent(fn, props, container)
  hooks      : []        // 상태 저장 (R2-04)
  hookIndex  : 0         // 렌더마다 0 으로
  vdom       : null      // 지난번 그린 트리 (컨테이너로 감싼 것)
  pendingEffects : []    // 이번 렌더에서 실행할 effect
  queued · pendingUpdate : 커밋 중 setState 로 밀린 갱신
  phase      : 'idle' | 'render' | 'commit'
  destroyed  : false
  hookCount  : null      // 첫 렌더에서 정해지는 Hook 개수
  mount()                // 처음 렌더링 (R2-05)
  update()               // 상태 변경 뒤 다시 렌더링 (R2-06)
  destroy()              // cleanup 전부 실행, 화면 비움
  onCommit(cb)           // 렌더가 끝날 때마다 측정값 보고
  inspect()              // hooks 값 · 지금 vdom 을 복사해 돌려줌 (디버깅 · 패널)
```

**한 바퀴 (update)**

1. `hookIndex = 0`, 현재 컴포넌트 = 나
2. `fn(props)` 실행 → 결과를 `expand` 로 펼침 → 컨테이너 태그로 감쌈 (`{ type: 컨테이너 태그, props: {}, children: [트리] }`)
	- 감싸는 이유 : path `[]` 가 항상 컨테이너라 루트 통째 교체(REPLACE)가 생기지 않는다
3. Hook 개수가 지난번과 다르면 에러 (조건문 안 Hook)
4. `diff(이전 vdom, 새 vdom, stats)` → `applyPatches(container, patches)` → `syncFormState(container, 새 vdom)`
5. `vdom = 새 vdom`
6. effect 실행 (아래 4.4)
7. `onCommit` 에 보고 : `{ ms, compared, patches: {CREATE, REMOVE, REPLACE, TEXT, PROPS}, hookCount }`

- `mount()` 는 1 · 2 · 3 뒤 Phase 1 `mount(container, vdom)` 로 그리고 5 ~ 7.
- 렌더 중 예외 : `vdom` · `hooks` 를 렌더 전 값으로 되돌리고 예외를 다시 던진다 (화면은 그대로).

### 4.3 펼치기 `expand`

- 태그 노드 : 자식을 차례로 펼친다
- 함수 노드 (`h(Child, props, ...children)`) : `Child({ ...props, children })` 를 실행해 그 결과를 펼친다
	- 자식 렌더 중에는 "자식 렌더 중" 표시 → 그 안에서 Hook 을 부르면 에러 (R2-08 · R2-09)
	- 자식이 배열을 돌려주면 부모 자식 목록에 펼쳐 넣는다
- `null` · `false` · `true` · `undefined` → 아무것도 안 그림
- 루트 컴포넌트는 **요소 하나** 또는 `null` 을 돌려줘야 한다. 글자 · 숫자는 글자 노드 하나로 허용, **배열은 에러**

### 4.4 Hooks

| Hook | 저장 모양 (`hooks[i]`) | 규칙 |
| --- | --- | --- |
| `useState(init)` | `{ value, setter }` | 처음만 init (함수면 실행). setter 는 렌더마다 같은 함수 |
| `setState(next)` | — | `next` 가 함수면 `next(지금 값)`. `Object.is` 로 같으면 아무것도 안 함. 아니면 값 저장 → **바로 `update()`** (Batching 없음) |
| `useMemo(fn, deps)` | `{ value, deps }` | deps 가 없으면 매번, `[]` 면 한 번, 원소별 `Object.is` 로 하나라도 다르거나 길이가 다르면 다시 계산 |
| `useEffect(fn, deps)` | `{ deps, cleanup }` | 렌더 중에는 "실행할 것" 표시만. Patch 뒤 순서대로 : 이전 cleanup → `fn()` → 반환값이 함수면 cleanup 으로 저장 |

- Hook 공통 : 현재 컴포넌트가 없으면 에러 (컴포넌트 밖 호출), 자식 렌더 중이면 에러
- 렌더 중 `setState` → 에러 (무한 루프 방지)
- effect 안 `setState` → 그 자리에서 바로 다시 그리지 않고 "다시 그려야 함" 표시 → effect 를 다 돌린 뒤 `update()` 한 번 (연쇄는 최대 50 번, 넘으면 에러)
- `destroy()` 뒤 `setState` → 무시
- effect 하나가 예외 → 나머지 effect 는 계속 실행, 예외는 모아서 마지막에 던짐 (v0 의 결정, 실제 React 와 다름)

## 5. 측정 페이지 (`phase2.html`)

```
┌ 미니리액트 측정 페이지 ───────────── 버전 [v0 기본 ▾] ┐
│ ① 데모 앱 (할 일 목록)            ② 측정 패널            │
│ ③ 시나리오 버튼                                        │
│ ④ 기록 표 [마크다운으로 복사]                           │
└────────────────────────────────────────────────────────┘
```

- ① 데모 앱 : 엔진으로 만든 컴포넌트
	- `App` (루트, 상태 전부) : `useState` 목록 · 입력값, `useMemo` 남은 개수, `useEffect` 문서 제목 · 측정 액션 등록
	- `TodoInput` · `TodoList` · `TodoItem` · `Summary` : props 만 받는 자식
- ② 측정 패널 : **엔진을 쓰지 않는 일반 DOM 코드** (패널이 자기 렌더로 측정을 오염시키지 않게)
	- `onCommit` 값 + MutationObserver 로 센 DOM 변경 수 + `inspect()` 의 hooks
- ③ 시나리오 : 100 개 추가 · 순서 뒤집기 · 맨 앞에 끼우기 · 하나만 고치기 · `setState` 10 번 연속
	- `App` 이 `useEffect` 로 등록한 액션을 부른다
- ④ 기록 표 : 시나리오마다 한 줄 (버전 · 시나리오 · 렌더 수 · 시간 합 · 비교 합 · patch 합 · DOM 변경 합), 마크다운 표로 복사
- 버전 선택 : v0 만 있음. 다른 버전 연결 방식은 리팩토링 때 정한다 (자리만)

## 6. 테스트

- 순서 : 모듈마다 (M1 mount → M2 useState → M3 setState·update → M4 자식 props → M5 useMemo → M6 useEffect), 매번 `npm test` 전체로 Phase 1 회귀 확인
- 각 모듈의 엣지 케이스 : 볼트 `Phase 2 구현 워크플로` 「엣지 케이스」 1 ~ 8 (7 절 10 번)
- 다 모인 뒤 : 기능 테스트 (jsdom 으로 `phase2.html` 열어 클릭 · 입력) → 측정 패널 → 페이지 테스트
- 한글 조합(IME) 은 jsdom 이 흉내 내지 못한다 → 단위 테스트는 "값이 같으면 대입 안 함" 까지, 실제 조합은 브라우저에서 손으로 확인

## 7. 검토 반영 (11-10, opus-critic 원문 대조 · 빌더 점검)

검토가 Phase 1 코드를 직접 돌려 확인한 것과 빌더 질문에 대한 결정. **아래가 4 절과 다르면 아래가 우선.**

| # | 발견 · 질문 | 결정 | 이유 |
| --- | --- | --- | --- |
| 1 | 이벤트 함수는 렌더마다 새 함수 → 내용이 같아도 `PROPS` patch · 리스너 교체 (`diff.js` 가 `!==` 비교) | **v0 는 그대로 둔다.** 대신 측정에서 **"이벤트만 바뀐 PROPS"를 따로 센다** (`stats.eventOnly`) | 정직한 기준선. 이벤트 위임 · 안정된 핸들러는 v1 의 대표 개선점이라 숫자로 보여야 한다 |
| 2 | 렌더 중 예외 때 무엇을 되돌리나 | `setState` 가 새 값을 넣고 `update()` 를 부르다 **렌더(함수 실행 · 펼치기)에서** 예외가 나면, 그 Hook 값을 옛 값으로 되돌리고 예외를 다시 던진다 | 원인이 된 값만 되돌리면 같은 예외가 반복되지 않는다 |
| 3 | patch 중 실패 | 컨테이너를 새 vdom 으로 **통째로 다시 mount** 해 DOM 과 vdom 을 맞춘다. 새 상태는 유지 | 복구가 단순하고 확실하다. 드문 경우라 성능은 상관없다 |
| 4 | "렌더 중" 범위 | 렌더 = 함수 실행 + 펼치기 → 이때 `setState` 는 **에러**. 커밋 = patch · 폼 맞추기 · effect · `onCommit` → 이때 `setState` 는 **모았다가 커밋이 끝난 뒤 `update()` 한 번** (연쇄 최대 50) | 규칙이 두 줄로 끝난다. effect 안 `setState` 규칙과 같다 |
| 5 | `onChange` 가 네이티브 `change` (blur 때) | v0 는 `setProp` 을 고치지 않는다. 데모는 **`onInput`** 을 쓴다. React 와의 차이로 README 에 적는다 | Phase 1 동작을 바꾸지 않음. 차이 자체가 학습 재료 (Q2-05) |
| 6 | `syncFormState` 가 `value` 없는 input 을 비우고, textarea 를 `textContent` 로 덮음 | `syncFormState(el, vnode, { controlledOnly: true })` 선택 인자를 더한다 : **props 에 `value` · `checked` 가 있을 때만**, 그리고 **값이 다를 때만** 대입. textarea 도 `value` prop 이 있으면 그 값. Phase 1 은 인자 없이 불러 동작 그대로 | Phase 1 테스트 · 페이지를 깨지 않고 Phase 2 입력을 보호 |
| 7 | Hook 개수는 같고 순서만 바뀜 (useState ↔ useMemo) | `hooks[i]` 에 종류(`state` · `memo` · `effect`)를 저장하고, 다르면 에러 | 조건문 안 Hook 을 더 확실히 잡는다 |
| 8 | 자식의 부수효과 · props 고치기 | 막지 않는다. 문서 약속으로 둔다 (자식에게 넘기는 props 는 얕은 복사) | v0 범위 밖. 원문은 Hook · state 만 막으라 한다 |
| 9 | `mount()` 두 번 · 컨테이너 없음 | 둘 다 에러 | 조용히 넘어가면 원인 찾기 어렵다 |
| 10 | 엣지 케이스 묶음 수 어긋남 | 6 절은 워크플로 「엣지 케이스」 **1 ~ 8** 전부 (8 = 테스트 페이지) | 문서 일치 |
| 11 | `setProp` 의 `setAttribute('value')` 가 MutationObserver 기록을 남김 | 그대로 둔다. "DOM 변경 수" 에 속성 쓰기도 포함된다고 측정 기준에 적는다 | 측정 정의를 분명히 |

(측정 참고 : 보고의 `ms` 는 effect 실행 시간까지 포함한다.)

## 8. 빌더에게 맡기는 것

- 함수 · 변수 이름, 측정 패널의 모양 · 색
- 시나리오 버튼의 정확한 데이터 크기 (100 개 기준)
- 테스트 파일 안 구성
