> 이 문서는 발표용 README 로 바꾸기 전의 상세 정리본이다 (11-11). 숫자는 쓴 때 기준이며, 최신 검증 수치는 [README_FACT_CHECK.md](README_FACT_CHECK.md) 를 본다.

# sw-ai-week11-12
Mini React/Redis/RDBMS 구현 팀 레포지토리

## 팀 레포지토리 관리 방식
- 개인별 브랜치에서 작업 + README.md 작성
- 코드별로 대략적인 리뷰 후 브랜치 하나를 선정해서 main에다가 PR + merge
- 이 작업은 React에서 한번, Redis/RDBMS에서 한번으로 총 2번 이루어짐

## 팀 프로젝트 관리 방식
- 맨 왼쪽 탭은 전반적인 Kanban 보드로, 모든 팀원의 진행 상황이 표시됨
- 나머지 탭 3개는 개인별 스케줄 관리, 진행 상황은 Todo/In Progress/Done중 하나로 설정
  - 각자 입맛에 맞는 태그를 더 추가해서 넣어도 됩니다
- 개인별로 이슈를 프로젝트에 등록할 때 **Assignee를 자기 자신으로 꼭 설정**해주세요!

---

## 미니 리액트 Phase 1 — 종휘 (`feat-Jongeume`)

> 11-11 파일 구조 정리로 경로가 바뀌었다 : 검증 페이지 `phase1.html` · `phase1/`, 엔진 `engines/v1-batch/` (옛 `src/`)

> [!NOTE]
> **한 줄 컨셉 : Virtual DOM 은 순수한 데이터, 실제 DOM 은 번호(path)로 찾는다.**
> 구조는 단순하게(객체 · 배열 · O(n) 순회), 대신 **정확성 우선** — 위치가 어긋나면 예외를 내고 되돌린다.

| 하고 싶은 것 | 방법 |
| --- | --- |
| 검증 페이지 열기 | `phase1.html` 더블클릭 (서버 필요 없음) |
| 단위 테스트 | `npm install` 한 번 → `npm test` |
| 설계 결정 · 엣지 케이스 전체 | [docs/phase1-design.md](phase1-design.md) |
| Codex 교차 검증 기록 | [docs/codex-review-log.md](codex-review-log.md) |

---

### 1. 한 바퀴 흐름 — Patch 버튼을 누르면

```mermaid
flowchart LR
  A["테스트 영역<br/>HTML 글"] -->|"① htmlToVdom"| B["새 VDOM"]
  S["shown<br/>(지금 화면의 VDOM)"] --> C
  B --> C{"② diff"}
  C -->|"변경 목록"| D["③ applyPatches"]
  D -->|"바뀐 곳만"| E["실제 영역 DOM"]
  B -->|"④ history.push"| H["State History"]
  H -->|"shown 갱신"| S
```

`phase1/app.js:36` `onPatch` 가 이 네 단계를 순서대로 부른다.

1. **읽기** — 테스트 영역의 HTML 글을 Virtual DOM 으로 만든다
2. **비교** — `shown`(지금 화면의 VDOM)과 새 VDOM 을 비교해 **변경 목록**을 만든다
3. **고치기** — 변경 목록대로 실제 영역에서 **바뀐 곳만** 고친다
4. **기록** — 새 VDOM 을 State History 에 넣고, `shown` 을 새 VDOM 으로 바꾼다

- 뒤로가기 · 앞으로가기(`phase1/app.js:59` `travel`)도 같다 : 기록의 VDOM 과 `shown` 을 비교 → 변경 목록 → 실제 영역 반영 → `shown` 을 그 VDOM 으로
- 페이지를 처음 열면 실제 영역을 VDOM 으로 읽고(`domToVdom`), 그 VDOM 대로 실제 영역을 한 번 다시 그려(`mount`) **둘의 모양을 1:1 로 맞춘다** (이유는 2.3)

---

### 2. 핵심 구조 — 무엇으로 적었나

#### 2.1 Virtual DOM 노드 `{ type, props, children }`

```js
// <p class="a">안녕</p>
{ type: 'p', props: { class: 'a' }, children: [
  { type: '#text', props: { nodeValue: '안녕' }, children: [] }
] }
```

- 실제 DOM 과 **같은 트리 모양** (부모 · 자식 · 순서)
- 글자 노드도 **같은 세 칸**이라, 비교 코드가 글자 · 요소를 한 방식으로 재귀한다
- 실제 DOM 노드를 **가리키지 않는 순수한 데이터**
	- DOM 없이 비교를 테스트할 수 있다
	- 기록에 넣을 때 깊은 복사만 하면 안전하다

#### 2.2 변경 목록 (patch) — 비교와 고치기 사이의 약속

```js
[ { type: 'TEXT',   path: [1, 0], value: '잘 가' },
  { type: 'REMOVE', path: [3] } ]
```

- 한 칸 = **무엇을 할지**(`type`) + **바꿀 위치**(`path`) (+ 필요한 재료)
- `type` 은 5종 : `CREATE` · `REMOVE` · `REPLACE` · `TEXT` · `PROPS`
	- 과제 중점 포인트 "최소 변경을 찾기 위한 5가지 핵심 케이스" 와 1:1
- `diff.js` 는 목록을 **만들기만**, `patch.js` 는 목록을 **쓰기만** 한다
	- 서로의 속을 몰라도 되고, 이 약속만 지키면 한쪽을 고쳐도 다른 쪽은 그대로다

#### 2.3 위치 `path` — 번호로 찾아가기

- `[1, 0]` = 루트의 두 번째 자식 → 그 노드의 첫 번째 자식 (번호는 0 부터)
- VDOM 과 실제 DOM 의 트리 모양이 같아서, **VDOM 에서 계산한 위치가 실제 DOM 에서도 같은 노드**다
- 대가 : 둘이 1:1 이어야 한다
	- 그래서 로드 때 `mount` 로 한 번 맞춘다 (실제 영역의 주석 · 들여쓰기 공백은 VDOM 에 없으므로)
	- 그래도 어긋나면 `findNode` 가 예외를 내고, 페이지가 잡아 이전 화면으로 되돌린다

#### 2.4 State History — 배열 + 현재 번호

- 처음 화면도 0 번에 저장 (11-09 팀 결정)
- 뒤로간 뒤 새로 Patch 하면 앞쪽 기록은 버린다 (브라우저 뒤로가기와 같은 규칙)
- 넣을 때 · 꺼낼 때 깊은 복사 → 밖에서 고쳐도 기록은 안 바뀐다
- 뒤로 · 앞으로 때 **`shown`(다음 비교의 기준)도 그 칸으로 옮긴다** — 공통 테스트 v2 의 P-15 가 검사하는 부분

---

### 3. 핵심 알고리즘 — 어떻게 비교하나

#### 3.1 Diff : 같은 자리끼리 나란히 내려가는 트리 비교 (`engines/v1-batch/diff.js:15` `walk`)

위에서부터 보고, 걸리면 그 자리에서 끝낸다.

1. 이전 노드가 없다 → `CREATE`
2. 새 노드가 없다 → `REMOVE`
3. 태그가 다르다 → `REPLACE` (**그 아래는 더 비교하지 않는다**)
4. 둘 다 글자 → 내용이 다르면 `TEXT`
5. 같은 태그 → 속성 비교(`PROPS`) 후, 자식을 **같은 번호끼리** 재귀

- 자식 수가 다를 때 (`engines/v1-batch/diff.js:45 ~ 53`)
	- 공통 개수까지 재귀
	- 새 쪽이 더 많으면 `CREATE` 를 **앞에서부터**
	- 옛 쪽이 더 많으면 `REMOVE` 를 **뒤에서부터** — 앞에서 지우면 뒤 번호가 당겨져 엉뚱한 노드를 지운다

| | 이 구현 (같은 자리끼리) | 최적 트리 비교 |
| --- | --- | --- |
| 시간 | **O(n)** | O(n³) 수준 |
| 변경 목록 | 최소가 아닐 수 있음 | 최소 |
| 고른 이유 | 실제 React 도 같은 가정(태그가 다르면 통째로, 자식은 순서대로)을 쓴다. 화면은 대부분 조금씩 바뀌어 충분하다 | — |

#### 3.2 Patch : 목록을 앞에서부터 차례로 (`engines/v1-batch/patch.js:26`)

- 칸마다 `path` 를 따라 내려가(`findNode`) 그 노드만 고친다
- 새 노드는 `render` 가 `createElement` 로 만든다 — **`innerHTML` 을 쓰지 않는다**
	- 글자가 HTML 로 해석되지 않는다 (XSS 방지)
	- SVG 같은 이름공간을 지킨다

#### 3.3 왜 VDOM 을 거치나 (이 구조 전체의 이유)

| 얻는 것 | 내주는 것 |
| --- | --- |
| 실제 DOM 은 **바뀐 곳만** 건드린다 (화면 재계산이 줄어든다) | 트리 두 벌을 메모리에 둔다 |
| 입력 중이던 값 · 포커스가 날아가지 않는다 | 매번 O(n) 비교를 한다 |
| 개발자는 "최종 화면 모양" 만 적으면 된다 | 바뀐 곳을 정확히 알고 손으로 고치는 코드보다는 느리다 |

---

### 4. 모듈 구성

| 파일 | 책임 | 크기 |
| --- | --- | --- |
| `engines/v1-batch/vdom.js` | DOM ↔ VDOM 변환, `render`, `setProp`, `toHtml`, `h()` | 280 줄 |
| `engines/v1-batch/diff.js` | 두 VDOM → 변경 목록 | 100 줄 |
| `engines/v1-batch/patch.js` | 변경 목록 → 실제 DOM, `mount` | 124 줄 |
| `phase1/history.js` | State History | 41 줄 |
| `phase1/app.js` · `phase1.html` · `phase1/style.css` | 검증 페이지 (Phase 1 전용) | — |

- 의존 방향은 한쪽 : `patch` · `history` → `vdom`, `diff` 는 아무것도 안 부른다 (VDOM 객체만 받음), `app` → 전부
- 모듈은 `window.MiniReact` 하나에 모인다 (`<script>` 태그, 빌드 · 서버 없음). Node 테스트에서는 `require` 로도 불린다

---

### 5. 검증

| 무엇 | 결과 |
| --- | --- |
| 단위 테스트 (`npm test`, jsdom) | 72 개 통과 (`npm test` 집계는 73 — `test/helpers.js` 가 하나로 세짐) |
| 팀 공통 테스트 v2 | 55 개 중 필수 50 통과 · 실패 0, 선택 5 도 통과 |
| Codex 교차 검증 (읽기 전용 5 회) | 엣지 케이스 21 개 발견 → 18 개 수정, 3 개는 범위 밖 ([기록](codex-review-log.md)) |
| 가장 강한 증거 | 무작위 트리 500 쌍 : patch 결과를 다시 읽으면 새 VDOM 과 같다 |

---

### 6. 병합 기준으로 본 분석

#### 6.1 확장성

| 강점 | 약점 |
| --- | --- |
| Phase 2 에서 **diff · patch · render 를 그대로** 쓸 수 있다 (입력이 VDOM 이기만 하면 된다) | `key` 비교가 없다 → 목록 맨 앞 삽입 · 순서 바꾸기에서 변경 목록이 늘어난다 (결과는 맞음) |
| `h(type, props, ...children)` 로 VDOM 을 코드에서 바로 만들 수 있다 (컴포넌트가 쓸 자리) | 이벤트 함수 속성(`onClick` 등)은 `setProp` 에 준비만 돼 있고, 컴포넌트와 연결은 안 해 봤다 |
| 변경 목록이 약속 역할을 해서, `key` · `MOVE` 를 넣어도 고칠 곳이 `diff.js` 와 `applyPatches` 의 한 갈래로 모인다 | |

#### 6.2 유지보수성

| 강점 | 약점 |
| --- | --- |
| 파일 하나 = 책임 하나, 의존이 한 방향 | 엣지 케이스(이름공간 · 폼 상태 · `<template>`) 처리가 `vdom.js` · `patch.js` 곳곳에 흩어져 있다 |
| 함수마다 한 줄 주석, "왜" 는 `docs/phase1-design.md` 에 모음 | `path` 방식이라 실제 DOM 을 다른 코드가 몰래 바꾸면 위치가 어긋난다 (그때는 예외 → 되돌리기) |
| 단위 테스트 72 개 + 공통 테스트가 고친 뒤 회귀를 잡아 준다 | |

#### 6.3 설계 복잡도

| 낮은 곳 | 높은 곳 |
| --- | --- |
| 핵심 자료구조가 객체 · 배열뿐, 알고리즘은 O(n) 재귀 하나 | `vdom.js` 가 280 줄 — 핵심(변환 · render)보다 엣지 케이스 처리가 더 길다 |
| 비교 분기가 5 갈래로 고정 | 실제 DOM 과 VDOM 을 1:1 로 맞추는 규칙(공백 · 주석 버리기, 로드 때 `mount`)을 알아야 `path` 가 이해된다 |

#### 6.4 팀 이해도

| 쉬운 곳 | 설명이 필요한 곳 |
| --- | --- |
| 큰 흐름이 `onPatch` 네 줄로 보인다 | "왜 노드 참조 대신 번호(`path`)인가" — 2.3 |
| 변경 목록 5 종이 과제 중점 포인트 5 케이스와 같다 | "왜 REMOVE 는 뒤에서부터인가" — 3.1 |
| 엣지 케이스 함수는 처음엔 건너뛰어도 흐름 이해에 지장 없다 | `shown` 이 "지금 화면의 VDOM" 이라는 것 — 1, 2.4 |

---

### 7. Phase 2 와 연결하면

| | Phase 1 | Phase 2 |
| --- | --- | --- |
| 새 VDOM 을 만드는 곳 | 테스트 영역 HTML 읽기 (`htmlToVdom`) | 컴포넌트 함수가 `h()` 로 만든다 |
| 비교 · 반영 | `diff` · `applyPatches` | **그대로** |
| 이전 VDOM | `shown` | 지난번에 그린 VDOM (같은 자리) |
| State History · 테스트 영역 · 버튼 | `history.js` · `app.js` | 쓰지 않는다 |

---

### 8. 알려진 한계

- `key` 비교 없음 (6.1)
- 줄바꿈이 든 공백만 있는 글자는 버린다 → `</label>\n<button>` 사이 공백이 화면에서도 사라진다 (같은 줄에 쓰면 남는다)
- MathML 의 드문 경우 · `<plaintext>` 는 범위 밖
- 실제 영역에서 사용자가 직접 바꾼 입력값 · 체크는 VDOM 에 없다 (Phase 2 에서 state 로 다룰 부분)

---

### 9. 리뷰 때 열어 볼 곳

| 순서 | 파일 : 줄 | 볼 것 |
| --- | --- | --- |
| 1 | `phase1/app.js:36` `onPatch` | 읽기 → 비교 → 고치기 → 기록 |
| 2 | `engines/v1-batch/diff.js:15` `walk` | 분기 5 갈래의 순서 |
| 3 | `engines/v1-batch/diff.js:45 ~ 53` | 자식 비교, REMOVE 를 뒤에서부터 |
| 4 | `engines/v1-batch/patch.js:8` · `:26` | `findNode` 로 찾아가 고치기 |
| 5 | `engines/v1-batch/vdom.js:44` · `:64` | DOM → VDOM (주석 · 들여쓰기 공백 버리기) |
| 6 | `phase1/app.js:59` · `phase1/history.js:8` | 뒤로 · 앞으로와 `shown` |

---

## 미니 리액트 Phase 2 — 종휘 (`feat-Jongeume`)

> [!NOTE]
> **한 줄 컨셉 (초안) : 함수는 매번 새로 실행되고, 상태는 엔진의 `hooks` 배열에 부른 순서대로 남는다.**
> 상태가 바뀌면 루트부터 다시 그려 새 Virtual DOM 을 만들고, Phase 1 의 diff · patch 로 바뀐 곳만 고친다.
> 여러 상태 변경은 모아서 한 번에 — 엔진 버전 v0 → v1 → v2 로 배칭을 넓혔다.

| 하고 싶은 것 | 방법 |
| --- | --- |
| 오목 데모 열기 | `index.html` 더블클릭 (서버 필요 없음) |
| 엔진 내부 상태 보기 | 오목 왼쪽 위 **엔진** 버튼 → 커밋 누계 · 마지막 커밋 · `hooks` 배열 |
| 엔진 버전 바꾸기 | 패널의 엔진 고르기, 또는 주소 뒤 `?engine=v0` · `v1-batch` · `v2-microtask` (기본 v2) |
| Phase 1 검증 페이지 | `phase1.html` |
| 테스트 | `npm install` 한 번 → `npm test` |

### 폴더 구조

```
index.html          오목 (메인 데모)
omok/               game.js 앱 · panel.js 엔진 패널 · loader.js 엔진 고르기 · style.css
phase1.html         Phase 1 검증 페이지
phase1/             app.js · style.css · history.js (State History)
engines/
  v0/               배칭 없음 — setter 마다 렌더
  v1-batch/         이벤트 경계 배칭 — 단위 테스트 기준 엔진
  v2-microtask/     마이크로태스크 배칭 — 최신
test/               v1 단위 테스트 · v2 테스트 · 오목 페이지 테스트
docs/superpowers/   설계 문서 · 구현 계획
```

- 엔진 한 벌 = `vdom.js` · `diff.js` · `patch.js` (Phase 1) + `hooks.js` · `component.js` (Phase 2)
- 버전마다 폴더를 따로 둔 이유 : 브라우저는 git 기록을 못 읽는다. 같은 오목을 엔진만 바꿔 열어 비교하려고

---

### 1. 한 바퀴 흐름 — 돌을 하나 두면 (v2 기준)

```mermaid
flowchart LR
  subgraph APP["omok/game.js — 앱"]
    A["칸 클릭<br/>place()"] --> B["setHistory · setMoveIndex"]
  end
  subgraph ENG["engines/v2-microtask — 엔진"]
    C["makeSetter<br/>값 저장 · 줄 세움"] --> D["schedule<br/>queueMicrotask 한 번"]
    D --> E["지금 코드 끝<br/>flushScheduled"]
    E --> F["settle → updateOnce"]
    F --> G["run · expand<br/>App() 다시 실행 → 새 VDOM"]
    G --> H["diff → applyPatches<br/>바뀐 칸만"]
    H --> I["runEffects<br/>탭 제목"]
  end
  B --> C
```

1. 앱의 `place` 가 setter 두 개를 부른다 (판 기록 · 현재 수)
2. setter 는 **값만 저장**하고 렌더를 마이크로태스크로 **한 번만 예약**한다
3. 지금 실행 중인 코드가 끝나면 예약을 비운다 → 렌더 1번
4. 렌더 = 루트 `App` 을 다시 실행해 새 VDOM 을 만들고(자식 컴포넌트는 펼치며 부름), 이전 VDOM 과 diff → patch
5. 화면 반영 뒤 의존성이 바뀐 effect 만 실행한다

| 단계 | 파일 : 줄 (v2) |
| --- | --- |
| setter | `engines/v2-microtask/hooks.js:140` `makeSetter` |
| 예약 · 비우기 | `hooks.js:119` `schedule` · `:108` `flushFromMicrotask` · `:101` `flushScheduled` |
| 갱신 한 바퀴 | `component.js:247` `settle` → `:99` `updateOnce` |
| 함수 실행 · 펼치기 | `component.js:141` `run` · `:39` `expandAll` |
| effect | `component.js:156` `runEffects` |

---

### 2. 핵심 구조 — 상태를 어디에 두나

#### 2.1 `FunctionComponent` — 함수 하나를 감싼 객체

- 과제 요구대로 `hooks` 배열 · `mount()` · `update()` 를 가진다
- 함수(`App`)는 렌더마다 처음부터 다시 실행된다. **남는 것은 이 객체의 필드뿐**
	- `hooks` : Hook 칸들 · `vdom` : 지난번에 그린 VDOM · `phase` : `render` / `commit` / `idle` · `queued` : 밀린 값

#### 2.2 `hooks` 배열 — 부른 순서가 곧 칸 번호

오목 `App` 의 실제 칸 (`omok/game.js:145`)

| 칸 | Hook | 든 것 |
| --- | --- | --- |
| 0 | `useState` | `history` — 판 기록 (수마다 판 한 장) |
| 1 | `useState` | `moveIndex` — 지금 보는 수 |
| 2 | `useState` | `times` — 흑 · 백 시간 |
| 3 | `useState` | `total` — 전체 시간 |
| 4 | `useState` | `saving` |
| 5 | `useState` | `savedAt` |
| 6 | `useMemo` | 승리 줄 (의존성 `[current]`) |
| 7 | `useMemo` | 승리 칸 Set (의존성 `[winLine]`) |
| 8 | `useEffect` | 탭 제목 (의존성 `[turn, winner]`) |
| 9 | `useEffect` | 1초 타이머 (의존성 `[]`, cleanup 으로 끔) |

- 렌더마다 `run()` 이 번호를 0 으로 되돌리고, Hook 을 부를 때마다 1 씩 올린다 (`hooks.js:68` `nextSlot`)
- 조건문으로 Hook 을 건너뛰면 칸이 어긋난다
	- 개수 · 종류가 달라지면 예외로 잡는다
	- 같은 종류끼리 순서만 바뀌면 **못 잡는다** (값이 뒤섞임)

#### 2.3 상태는 루트에만, 자식은 props 만 (과제 제약)

```mermaid
%%{init: {"flowchart": {"curve": "stepBefore"}}}%%
flowchart TB
  App["<b>App</b><br/>상태 · Hook 전부 (hooks 0~9)"]
  App --> P1["<b>PlayerCard</b> 흑<br/>color · seconds · active · winner"]
  App --> P2["<b>PlayerCard</b> 백<br/>color · seconds · active · winner"]
  App --> GI["<b>GameInfo</b><br/>turn · status · total · canUndo<br/>onUndo · onNewGame · onResetAll"]
  App --> B["<b>Board</b><br/>board · last · winSet · locked<br/>onPlace"]
  App --> ML["<b>MoveList</b><br/>history · moveIndex<br/>onJump"]
  App --> SB["<b>SaveBox</b><br/>saving · savedAt<br/>onSave"]
  B --> C["<b>Cell</b> × 225<br/>i · stone · last · win · locked<br/>onPlace"]
  classDef root fill:#3182f6,stroke:#1b64da,color:#fff
  classDef child fill:#e8f3ff,stroke:#3182f6,color:#191f28
  class App root
  class P1,P2,GI,B,ML,SB,C child
```

- 상자 둘째 줄부터가 받는 props. `on…` 은 `App` 안의 함수 — 자식이 부르면 `App` 의 setter 가 불린다
- `Cell` 225개는 `App` 이 아니라 `Board` 가 만든다 (`onPlace` 를 그대로 넘김)

- 자식 안에서 Hook 을 부르면 예외 (`component.js:29` `callChild` 가 표시)
- 자식은 함수라 매 렌더 다시 실행된다 → 225 칸 모두 다시 펼치고 diff 한다 (한계 6절)

---

### 3. 세 Hook

| Hook | 언제 실행 | 하는 일 | 오목에서 |
| --- | --- | --- | --- |
| `useState` | 렌더 중 | 칸이 없으면 만들고, 있으면 그 값 · setter 를 돌려준다 | 판 기록 · 현재 수 · 시간 |
| `useMemo` | 렌더 중 | 의존성이 자리마다 `Object.is` 로 같으면 지난 결과를 재사용 | 승리 줄 계산 |
| `useEffect` | **커밋 뒤** | 렌더 중엔 등록만, DOM 반영 뒤 이전 cleanup → 실행 → 새 cleanup 저장 | 탭 제목 · 타이머 켜고 끄기 |

- effect 의존성 실수의 실제 사례 : 타이머 의존성을 `[turn]` 으로 두었더니 착수마다 타이머를 껐다 켜서 1초 안에 계속 두면 시간이 멈췄다 → `[]` 로 고침 (`1c33a8e`)

---

### 4. 배칭 — v0 → v1 → v2

| 버전 | 작업의 끝을 무엇으로 보나 | 바뀐 곳 |
| --- | --- | --- |
| v0 | 없음 — setter 마다 렌더 | — |
| v1 이벤트 경계 | **엔진이 붙인 핸들러가 돌아올 때** (`batchDepth` 가 0 이 될 때) | `component.js` `wrapHandler` · `hooks.js` `batch` |
| v2 마이크로태스크 | **지금 실행 중인 코드가 모두 끝날 때** (호출 스택이 빌 때) | `hooks.js` `schedule` · `flushSync` |

**측정 — 오목, 실제 브라우저, 커밋(렌더) 수**

| 동작 | setter | v0 | v1 | v2 |
| --- | --- | --- | --- | --- |
| 착수 | 2 | 2 | **1** | 1 |
| 전체 초기화 | 5 (하나는 같은 값) | 4 | **1** | 1 |
| 타이머 1초 (엔진 이벤트 밖) | 2 | 2 | 2 | **1** |
| 저장 : 시작 + `await` 뒤 | 1 + 2 | 3 | 3 | **2** |

- 렌더가 줄면 함수 실행 · diff 비교 · patch 명령이 함께 준다 (할 일 데모 '추가' : 비교 56 → 25, patch 17 → 9)
- **중간 상태도 사라진다** : v0 에서 '전체 초기화' 가 `history` 를 먼저 비우면 "기록은 1개인데 현재 수는 5" 로 렌더하다 터졌다. 배칭 엔진에서는 두 값이 함께 바뀌어 이 상태가 생기지 않는다
- v2 가 내주는 것
	- setter 직후엔 DOM 이 아직 옛 모습 → 바로 읽어야 하면 `flushSync(fn)`
	- 예약된 렌더의 예외는 부른 쪽이 받지 못한다 → 값은 되돌리고 `reportError` 로 보고

---

### 5. 실제 React 와 차이

| | 이 구현 | 실제 React |
| --- | --- | --- |
| Hook 기록 | 컴포넌트 객체의 **배열**, 번호로 찾기 | Fiber 의 **연결 리스트**, `next` 로 따라가기 |
| 상태를 둘 수 있는 곳 | 루트만 (과제 제약) | 모든 컴포넌트 |
| 다시 그리는 범위 | 늘 루트부터 전부 | 상태가 바뀐 컴포넌트부터 |
| 배칭 | v1 = React 17 (이벤트 경계), v2 = React 18 (자동 배칭) 방향 | 18 : 예약 + 우선순위(lane) · 동시성 렌더링 |
| 목록 비교 | 위치(번호)로만 | `key` 로 같은 항목을 찾아 옮김 |
| Hook 종류 | `useState` · `useMemo` · `useEffect` | + `useRef` · `useCallback` · `useContext` · `useReducer` … |
| 렌더 중 오류 | 값을 되돌리고 이전 화면 유지 | Error Boundary |

---

### 6. 한계와 다음 (v3 후보)

- `useRef` 없음 — 오목 타이머는 파일 수준 `live` 객체로 흉내
- 안정된 핸들러(`useCallback` 같은 것) 없음 — 매 렌더 225 칸에 새 클릭 함수 → 이벤트만 바뀐 PROPS 가 230 개 넘게
- `key` 없음 — 목록 앞 삽입 · 뒤집기에서 patch 가 많다
- 단위 테스트 기준 엔진은 v1 (동기). v2 는 전용 비동기 테스트만
- `flushSync` 는 "setter 직후 바뀐 DOM 을 읽어야 할 때" 만 — 타이머에 쓰면 배칭 이점을 버린다

---

### 7. 검증

| 무엇 | 결과 |
| --- | --- |
| `npm test` | 202 개 통과 (v1 단위 · v1 배칭 · v2 · 오목 페이지) |
| v2 전용 (`test/v2-microtask.test.js`) | 10 개 — 예약 · `+3` 누적 · 타이머 · `flushSync` · effect 후속 · 예외 되돌리기 · destroy |
| 실제 브라우저 | 오목에서 v0 · v1 · v2 커밋 수 측정 (4절 표), 콘솔 오류 0 |
| 독립 검증 | Codex 검증 전 |

---

### 8. 중점 포인트 — 내 말로

> [!IMPORTANT]
> 아래 답은 **직접 쓴다.** 괄호는 근거로 볼 곳.

- **Q2-01. UI 를 어떻게 Component 로 나눌 것인가?** (2.3 트리)
	- 
- **Q2-02. State 는 어디에 두는 것이 좋은가?** (2.3, 과제 제약 · 실제 React 는 가까운 공통 부모)
	- 
- **Q2-03. `setState` 는 상태 변경 외에 무엇을 해야 하나?** (1절 흐름, `makeSetter`)
	- 
- **Q2-04. 여러 상태 변경을 한 번에 처리하는 방법은?** (4절 v1 · v2)
	- 
- **Q2-05. 이번에 구현한 React 와 실제 React 의 차이는?** (5절 표)
	- 
- **Q2-06. 함수는 매번 새로 실행되는데, 상태는 어떻게 유지하나?** (2.1 · 2.2)
	- 

---

### 9. 리뷰 때 열어 볼 곳

| 순서 | 파일 : 줄 | 볼 것 |
| --- | --- | --- |
| 1 | `omok/game.js:186` `place` | 앱이 setter 두 개를 부르는 곳 |
| 2 | `engines/v2-microtask/hooks.js:140` `makeSetter` | 저장 → 줄 세움 → 예약 |
| 3 | `hooks.js:119` `schedule` · `:108` `flushFromMicrotask` | 마이크로태스크 한 번 |
| 4 | `component.js:247` `settle` → `:99` `updateOnce` | 렌더 → diff → patch → effect |
| 5 | `hooks.js:68` `nextSlot` | 번호표 사물함 |
| 6 | `engines/v1-batch/hooks.js` `batch` | v1 과 비교 — 작업의 끝을 무엇으로 보나 |
