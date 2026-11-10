# mini-react 학습 가이드

이 문서는 코드를 실행 순서대로 따라가며 설명합니다.
먼저 지도로 전체 흐름을 보고, 그다음 각 부분이 왜 그렇게 만들어졌는지 봅니다.

읽는 순서를 추천하면 이렇습니다.

1. 1장의 지도를 보고 파일들이 어떻게 이어지는지 잡습니다.
2. 2장에서 버튼을 눌렀을 때 함수가 불리는 순서를 따라갑니다.
3. 3장에서 각 부분의 이유를 봅니다.
4. 5장의 질문에 소리 내어 답해 봅니다.

---

## 1. 집 비유로 보는 전체 그림

이 프로젝트는 집 고치기와 같습니다.

| 코드 | 집 비유 |
|---|---|
| 실제 DOM | 지금 서 있는 진짜 집 |
| Virtual DOM | 종이에 그린 설계도 |
| `diff` | 어제 설계도와 오늘 설계도를 나란히 놓고 다른 곳 찾기 |
| `Patch[]` | 공사 지시서: "2층 창문 교체", "거실 벽 페인트" |
| `applyPatches` | 지시서대로 그 부분만 공사 |
| `hooks` 배열 | 현관 신발장: 사람은 드나들어도 칸은 그대로 |
| `useState` | 신발장 몇 번 칸에 넣어 둔 물건 |
| `key` | 가구에 붙인 이름표: 옮겨도 같은 가구로 알아봄 |
| Batching | 심부름을 모았다가 한 번에 다녀오기 |
| `useEffect` | 공사가 끝난 뒤에 할 일 |
| 정리 함수 | 집을 나가기 전에 불 끄기 |
| `useMemo` | 어제 계산한 가계부 메모를 다시 쓰기 |

집을 조금 고칠 때마다 허물고 새로 짓지 않습니다.
설계도만 비교해서 다른 곳만 공사합니다. 이것이 이 과제 전체의 생각입니다.

### 파일 연결 지도

화살표는 "이 파일이 저 파일을 가져다 쓴다"는 뜻입니다.

```text
main.ts
  │
  ▼
app/app.ts ─────────────── 주소의 # 값으로 페이지 전환
  │
  ├─▶ app/lab-page.ts ───▶ app/controls.ts      Phase 1 검증 페이지
  │        │                     │
  │        ▼                     │
  │   app/inspector.ts           │              노드 지도, 연산 목록
  │        ▲                     │
  └─▶ app/test-page.ts           │              Phase 2 집중 보드
           │                     │
           ▼                     │
   phase2/hooks/use-*.ts         │
           │                     │
           ▼                     │
   phase2/function-component.ts  │
           │     ▲               │
           │  phase2/h.ts        │
           ▼                     ▼
   phase1/diff.ts   phase1/patch.ts   phase1/history.ts
   phase1/dom-to-vdom.ts   phase1/vdom-to-html.ts
           │
           ▼
   phase1/types.ts                              모두가 쓰는 자료 모양
```

의존 방향은 한쪽입니다. `app`은 `phase2`를 알고, `phase2`는 `phase1`을 알지만,
반대 방향은 없습니다. 덕분에 `phase1`은 Hook을 전혀 몰라도 혼자 테스트할 수 있습니다.

---

## 2. 실행 순서 지도

### 2-1. 페이지를 열 때 (Phase 1)

```text
createLabPage()
  │
  ├─ 1. real.innerHTML = SAMPLE_HTML          실제 영역에 샘플 HTML을 넣음
  ├─ 2. childrenToVdom(real)                  DOM을 읽어 Virtual DOM 생성
  ├─ 3. real.replaceChildren(createDom(...))  들여쓰기 공백을 뺀 트리대로 DOM을 다시 만듦
  ├─ 4. testArea.write(initial)               같은 트리로 테스트 영역을 그림
  │       ├─ vdomToHtml() → 코드 입력칸
  │       └─ createDom()  → 화면 편집칸
  └─ 5. createLabControls({ initial })        기록의 첫 칸 v1 생성
```

3번이 왜 필요한지가 중요합니다. Diff의 주소는 "몇 번째 자식"인데,
들여쓰기 공백은 트리에서 빠지고 DOM에는 남아 있으면 번호가 어긋납니다.
그래서 시작할 때 DOM을 트리와 1:1로 맞춰 둡니다.

### 2-2. Patch 버튼을 누를 때

```text
[Patch 클릭]
  │
  ▼
controls.patch()
  │
  ├─ 1. readTestArea()
  │       코드칸 글자 → htmlToVdom() → 새 Virtual DOM
  │
  ├─ 2. diff(history.current, next)
  │       옛 트리와 새 트리 비교 → Patch[] 지시서
  │
  ├─ 3. 지시서가 비었나?
  │       예  → 기록을 늘리지 않음
  │       아니오 ↓
  │
  ├─ 4. applyPatches(realRoot, patches, onApply)
  │       연산마다: 주소로 노드 찾기 → DOM 고치기 → onApply 알림
  │                                              └ recordTouch → 노드 지도
  │
  ├─ 5. history.push(next)                    새 트리를 기록에 저장
  │
  └─ 6. onTransition → renderReport()
          연산 개수, MutationObserver 건수, 노드 지도, 연산 목록 갱신
```

### 2-3. 뒤로가기를 누를 때

```text
controls.back()
  │
  ▼
navigate('back', ...)
  ├─ previous = history.current              지금 화면의 트리
  ├─ target   = history.back()               돌아갈 트리
  ├─ diff(previous, target)                  기록 이동도 Diff를 거침
  ├─ applyPatches(...)                       실제 영역을 바뀐 곳만 고침
  └─ writeTestArea(target)                   테스트 영역도 함께 바꿈
```

기록을 옮길 때도 전체를 다시 그리지 않습니다. Patch 때와 같은 길을 씁니다.

### 2-4. Diff 안쪽

```text
diff(old, new)
  │
  ▼
diffNode(old, new, path)
  ├─ 같은 객체인가?                → 끝 (useMemo로 재사용한 트리)
  ├─ 둘 다 글자인가?
  │     내용이 다르면 TEXT
  ├─ 태그나 key가 다른가?          → REPLACE 후 끝
  └─ 같은 요소라면
        ├─ diffProps    → PROPS, LISTENERS
        └─ diffChildren
              ├─ matchChildren       새 자식마다 짝이 될 옛 자식 찾기
              ├─ 1단계: 짝끼리 diffNode 재귀 (옛 번호 그대로)
              ├─ 2단계: 짝 없는 옛 자식 REMOVE (뒤에서부터)
              └─ 3단계: LIS로 가만히 둘 노드를 고르고
                        뒤에서부터 MOVE, INSERT
```

### 2-5. 상태가 바뀔 때 (Phase 2)

```text
[사용자 클릭]
  │
  ▼
dispatchToHandler → 표에서 onClick을 찾아 실행
  │
  ▼
setState(값)
  ├─ Object.is로 같은 값이면 끝
  ├─ slot.value 교체                    hooks 배열의 칸에 저장
  └─ owner.scheduleUpdate()
        ├─ 이미 예약돼 있으면 끝        ← setState 여러 번이 여기서 합쳐짐
        └─ queueMicrotask(...)          이벤트 처리가 끝난 직후로 예약
  │
  ▼  (지금 이벤트 처리가 끝남)
flushScheduledUpdate → update()
  │
  ├─ 1. render()
  │       currentOwner = this, cursor = 0
  │       컴포넌트 함수 실행
  │         ├─ useState/useMemo/useEffect → claimSlot()이 다음 칸을 내줌
  │         └─ h(Child, props)            → renderStateless (Hook 금지 구역)
  │
  ├─ 2. diff(옛 트리, 새 트리)          Phase 1의 코드를 그대로 씀
  ├─ 3. applyPatches(...)               바뀐 곳만 DOM 반영
  ├─ 4. this.vdom = 새 트리
  ├─ 5. flushEffects()                  정리 함수 전부 → effect 전부
  └─ 6. onCommit()                      렌더 기록 패널 갱신
```

---

## 3. 왜 이렇게 만들었나

각 항목은 하는 일, 이유, 버린 대안, 연결, 더 찾아볼 검색어 순서입니다.

### 3-1. Virtual DOM 모양 — `phase1/types.ts`

```ts
type VNode = VElement | VText
interface VElement { kind: 'element'; tag: string; props: Props; children: VNode[]; key?: Key }
interface VText    { kind: 'text'; text: string }
```

그냥 평범한 자바스크립트 객체입니다. 화면에 그려지지 않으니 만들고 비교하는 비용이 작습니다.

`kind`라는 꼬리표를 붙인 이유는, 이 값을 검사하면 TypeScript가
"여기서는 `tag`가 있다"고 알아서 좁혀 주기 때문입니다.

- 버린 대안: 글자 노드를 그냥 `string`으로 두는 방식입니다. 더 짧지만 모든 곳에서
  `typeof`로 나눠야 하고 나중에 필드를 더할 수 없습니다.
- 검색어: `TypeScript discriminated union`

### 3-2. DOM을 트리로 읽기 — `phase1/dom-to-vdom.ts`

`domToVdom`은 DOM을 재귀로 내려가며 객체로 옮겨 적습니다. 세 가지를 정리합니다.

1. **들여쓰기 공백을 버립니다.** 줄바꿈이 든 공백만 있는 글자는 코드 정렬용입니다.
   한 줄 안의 공백(`<b>가</b> <i>나</i>`)은 화면에 보이니 남깁니다. `pre` 안은 전부 지킵니다.
2. **이어진 글자를 합칩니다.** 같은 화면이 항상 같은 트리가 되게 하기 위해서입니다.
3. **실행될 수 있는 것을 뺍니다.** `script`, `on...` 속성, `javascript:` 주소입니다.

HTML 문자열을 읽을 때 `<template>`을 쓴 이유가 있습니다.
`div.innerHTML`로 파싱하면 `<img onerror>`가 파싱만으로 실행될 수 있지만,
`template` 내용은 화면과 분리된 문서에 있어서 안전합니다. `<tr>`도 버려지지 않습니다.

- 버린 대안: 정규식으로 HTML 파싱. 닫히지 않은 태그, 자동 `tbody` 같은 규칙을
  다시 구현해야 합니다. 브라우저 파서를 쓰면 공짜입니다.
- 검색어: `HTML template element inert`, `Node.nodeType`

### 3-3. 코드로 되돌리기 — `phase1/vdom-to-html.ts`

아무것도 안 고치고 Patch를 누르면 연산이 0개여야 합니다.
그러려면 `트리 → 코드 → 트리`가 항상 처음과 같아야 합니다.

그래서 자식이 전부 요소일 때만 줄을 나눕니다. 글자가 섞인 곳에서 줄을 나누면
그 줄바꿈이 내용이 되어 트리가 달라지기 때문입니다.

### 3-4. 지시서를 만드는 Diff — `phase1/diff.ts`

#### 다섯 가지 기본 케이스

| 케이스 | 언제 | 연산 |
|---|---|---|
| 추가 | 새 자식이 생김 | `INSERT` |
| 삭제 | 자식이 사라짐 | `REMOVE` |
| 교체 | 태그가 달라짐, 글자와 요소가 바뀜 | `REPLACE` |
| 속성 변경 | 태그는 같고 속성이 달라짐 | `PROPS` |
| 글자 변경 | 글자 내용이 달라짐 | `TEXT` |

여기에 두 가지를 더했습니다. `MOVE`는 key가 있을 때 노드를 재사용해서 옮기고,
`LISTENERS`는 DOM을 건드리지 않는 핸들러 교체입니다.

#### 왜 바로 고치지 않고 지시서를 만드나

Diff가 DOM을 직접 고치면 코드는 짧아지지만, 무엇이 바뀌었는지 기록이 남지 않습니다.
지시서를 데이터로 돌려주면 세 가지가 가능합니다.

- 브라우저 없이 `diff()` 결과만 비교하는 테스트
- 화면의 연산 목록과 노드 지도
- 나중에 지시서를 합치거나 미루는 확장

#### 연산 순서가 왜 정확성인가

연산의 주소는 "옛 트리에서 몇 번째 자식"입니다.
자식 순서를 먼저 바꾸면 그 뒤의 주소가 전부 틀어집니다. 그래서 순서를 정했습니다.

```text
어떤 노드에 대해
  ① 자식들의 내부 연산을 먼저 낸다     (자식 번호가 아직 그대로)
  ② 그다음 자식 목록을 바꾼다          (REMOVE, MOVE, INSERT)
```

아파트로 치면, 호수가 바뀌기 전에 각 집 내부 공사를 먼저 끝내는 것과 같습니다.

자식 목록을 바꾸는 단계에서는 `order` 배열이 패치 진행 상황을 흉내 냅니다.
덕분에 `MOVE`와 `INSERT`의 번호는 "그 연산이 실행되는 순간의 번호"가 됩니다.

#### 짝 찾기: `matchChildren`

자식을 어떻게 짝지을지가 "최소 변경"을 좌우합니다. 두 번에 나눠 찾습니다.

1. **1차:** 같은 신분끼리 순서대로 짝을 짓습니다. 신분은 key와 태그로 만듭니다.
   글자는 글자끼리, key 없는 `li`는 key 없는 `li`끼리입니다.
2. **2차:** 남은 key 없는 노드끼리 자리 순서로 짝을 지어 `REPLACE` 한 번으로 끝냅니다.

이 덕분에 `[div, p, span] → [p, span]`은 교체 두 번과 삭제가 아니라 `REMOVE` 하나로 끝납니다.

key가 없는 같은 태그 목록은 자리 순서로만 비교합니다.
맨 앞에 끼워 넣으면 뒤 항목의 글자가 전부 바뀌는 연산이 나옵니다.
key가 필요한 이유를 보여 주는 동작이고, 실제 React도 같습니다.

#### LIS: 가장 적게 옮기기

`[a, b, c, d] → [b, c, d, a]`를 봅시다. 새 순서를 옛 번호로 쓰면 `[1, 2, 3, 0]`입니다.

```text
옛 번호 수열    1  2  3  0
증가하는 부분   1  2  3        ← 이 셋은 서로 순서가 이미 맞음
```

서로 순서가 맞는 노드를 최대한 많이 고르면, 나머지만 옮기면 됩니다.
이것이 가장 긴 증가 부분 수열(LIS)입니다. 여기서는 `a` 하나만 옮기면 끝입니다.

뒤에서부터 처리하는 이유는, 오른쪽 이웃이 이미 확정돼서 "이 노드 앞에 넣어라"라는
기준점으로 쓸 수 있기 때문입니다.

- 버린 대안: 앞에서부터 하나씩 맞추기. 간단하지만 위 예시에서 이동이 3번 나옵니다.
- 참고: 실제 React는 LIS 대신 `lastPlacedIndex`라는 더 단순한 방식을 쓰고,
  LIS는 Vue 3가 쓰는 방식입니다.
- 검색어: `longest increasing subsequence`, `Vue 3 diff LIS`, `React reconciliation key`

### 3-5. 지시서대로 공사 — `phase1/patch.ts`

`applyPatches`는 연산을 순서대로 읽고 `switch`로 나눠 DOM API를 부릅니다.
주소를 못 찾으면 넘어가지 않고 오류를 냅니다. 조용히 틀리면 찾기가 훨씬 어렵습니다.

`value`, `checked`, `selected`는 특별합니다. 속성(attribute)은 처음 값이고,
프로퍼티(property)가 지금 화면 값입니다. 사용자가 한 번 입력한 뒤에는
`setAttribute('value', ...)`만으로는 화면이 안 바뀌어서 둘 다 맞춥니다.
같은 값이면 넣지 않습니다. 넣으면 커서가 끝으로 튀기 때문입니다.

#### 이벤트 핸들러를 표에 넣은 이유

컴포넌트 함수는 렌더마다 새로 실행되니 `onClick`도 매번 새 함수입니다.
그때마다 `removeEventListener`와 `addEventListener`를 부르면 낭비입니다.

```text
button ──(리스너는 한 번만)──▶ dispatchToHandler ──▶ 표에서 최신 함수 찾기
```

표의 내용만 바꾸면 되므로 DOM 작업이 생기지 않습니다.
`WeakMap`을 쓴 이유는, 요소가 사라지면 표도 메모리에서 함께 사라지기 때문입니다.

- 버린 대안: 실제 React처럼 루트 한 곳에서 이벤트를 받는 위임 방식.
  리스너 수가 줄지만, 이벤트 버블링을 직접 흉내 내야 해서 이번 범위에서는 뺐습니다.
- 검색어: `attribute vs property`, `event delegation`, `WeakMap`

### 3-6. 기록 — `phase1/history.ts`

배열 하나와 현재 위치 `cursor`가 전부입니다.
과거로 돌아간 뒤 새로 저장하면 앞쪽 기록을 버립니다. 브라우저 방문 기록과 같습니다.

트리를 복사하지 않고 참조만 저장해도 안전합니다.
이 코드에서 트리는 고치지 않고 새로 만들기만 하기 때문입니다.

### 3-7. `h()`와 자식 컴포넌트 — `phase2/h.ts`

```ts
h('button', { className: 'a', onClick: save }, '저장')
```

JSX가 컴파일되면 불리는 함수와 같은 역할입니다.
여기서 `className`을 `class`로, `style` 객체를 문자열로 정리합니다.
입구에서 정리해 두면 Diff는 값 비교만 하면 됩니다.

첫 인자가 함수면 자식 컴포넌트입니다. 상태가 없는 순수 함수이므로 그 자리에서 바로
실행해서 결과 트리로 펼칩니다. 그래서 Diff는 컴포넌트를 전혀 모릅니다.

### 3-8. 상태가 사라지지 않는 이유 — `phase2/function-component.ts`

과제의 질문입니다. **"함수는 매번 새로 실행되는데, 상태는 어떻게 유지할까?"**

답은 **상태를 함수 바깥에 두는 것**입니다.

```text
FunctionComponent 인스턴스 (계속 살아 있음)
  hooks: [ 칸0: count=3 ][ 칸1: 메모 ][ 칸2: effect ]
             ▲             ▲            ▲
             │             │            │
  렌더 함수 (매번 새로 실행, 끝나면 사라짐)
    useState(0)   ← 첫 번째 호출 = 칸0
    useMemo(...)  ← 두 번째 호출 = 칸1
    useEffect(..) ← 세 번째 호출 = 칸2
```

렌더가 시작될 때 `cursor`를 0으로 되돌리고, Hook이 불릴 때마다 다음 칸을 내줍니다.
신발장에 들어오는 순서대로 칸 번호를 받는 것과 같습니다.

`useState`는 인자로 컴포넌트를 받지 않습니다. 그럼 어느 신발장인지 어떻게 알까요?
렌더 직전에 모듈 변수 `currentOwner`에 자기를 적어 두기 때문입니다.

칸을 순서로 찾기 때문에 **조건문 안에서 Hook을 부르면 칸이 어긋납니다.**
그래서 `claimSlot`은 칸 종류가 다르거나 개수가 달라지면 바로 오류를 냅니다.

- 버린 대안: `useState('count', 0)`처럼 이름표로 찾는 방식. 순서 제약은 없지만
  호출마다 고유한 이름을 지어야 합니다.
- 검색어: `Rules of Hooks`, `why do hooks rely on call order`

#### 과제 제약을 코드로 막은 방법

"Hook은 루트에서만" 규칙은 문서로만 두지 않았습니다.
자식을 실행할 때 `statelessDepth`를 올려 두고, 그 안에서 Hook이 불리면 오류를 냅니다.

### 3-9. `setState`가 하는 일 — `phase2/hooks/use-state.ts`

값만 바꾸면 화면은 그대로입니다. `setState`는 세 가지를 합니다.

1. 새 값을 계산합니다. 함수를 받으면 이전 값으로 실행합니다.
2. 같은 값이면 멈춥니다. `Object.is`로 비교합니다.
3. 칸의 값을 바꾸고 다시 그리기를 **예약**합니다.

`setCount`는 칸이 만들어질 때 한 번만 생기는 클로저입니다.
그래서 렌더가 반복돼도 같은 함수이고, 언제 불러도 자기 칸을 찾아갑니다.

이 함수에는 함정이 하나 있습니다. 객체를 안에서 고치고 같은 참조를 넣으면
`Object.is`가 같다고 판단해서 화면이 안 바뀝니다. 그래서 `[...list, item]`처럼 새로 만듭니다.

- 검색어: `JavaScript closure`, `stale closure React`

### 3-10. Batching — `scheduleUpdate`

```ts
setFilter('all')
setQuery('')
setSortBy('created')
```

바로 다시 그리면 렌더가 세 번입니다. 그래서 바로 그리지 않고 예약합니다.

```text
setFilter → 예약 없음 → queueMicrotask 예약
setQuery  → 이미 예약됨 → 끝
setSortBy → 이미 예약됨 → 끝
(이벤트 처리 끝)
마이크로태스크 실행 → 렌더 한 번
```

심부름 세 개를 모았다가 한 번에 다녀오는 것과 같습니다.

- 버린 대안: `setTimeout(0)`은 브라우저가 그 사이에 화면을 먼저 그릴 수 있어서,
  상태가 반만 바뀐 화면이 잠깐 보일 수 있습니다. 마이크로태스크는 그리기 전에 실행됩니다.
- 검색어: `event loop microtask`, `React automatic batching`

### 3-11. `useEffect` — `phase2/hooks/use-effect.ts`

렌더는 화면 모양을 계산하는 시간이라 부수 효과가 있으면 안 됩니다.
그래서 렌더 중에는 "할 일"만 예약하고, 화면 반영 뒤에 실행합니다.

```text
렌더 중     deps가 바뀌었나? → 예약만 함
화면 반영
그다음      예약된 정리 함수를 전부 실행 → 새 effect를 전부 실행
```

`deps`는 렌더가 아니라 실행할 때 저장합니다.
렌더가 도중에 실패했을 때, 실행한 적 없는 effect를 실행한 것으로 착각하지 않기 위해서입니다.

정리 함수가 왜 필요한지는 집중 보드의 타이머가 보여 줍니다.
`clearInterval`이 없으면 멈춘 뒤에도 옛 타이머가 살아남습니다.
나갈 때 불을 끄지 않은 것과 같습니다.

### 3-12. `useMemo` — `phase2/hooks/use-memo.ts`

칸에 `deps`와 결과를 저장하고, `deps`가 그대로면 지난 결과를 돌려줍니다.
비교 규칙은 `hooks/deps.ts` 하나를 `useEffect`와 같이 씁니다.

Diff와도 연결됩니다. 메모한 트리는 객체가 같아서 `diffNode`의 첫 줄
`oldNode === newNode`에서 바로 끝납니다. 계산도 비교도 건너뜁니다.

집중 보드에서는 타이머가 1초마다 다시 그려도 목록을 재계산하지 않습니다.
실제 브라우저에서 3초 동안 재계산 횟수가 늘지 않는 것을 확인했습니다.

---

## 4. 구현 방식과 코드 스타일

### 코드 표기

틀에 있던 코드의 표기를 그대로 따랐습니다.

| 항목 | 규칙 | 이유 |
|---|---|---|
| 세미콜론 | 쓰지 않음 | 틀의 기존 코드와 통일 |
| 따옴표 | 작은따옴표 | 틀의 기존 코드와 통일 |
| 들여쓰기 | 2칸 | 틀의 기존 코드와 통일 |
| import | `.ts` 확장자 포함 | `allowImportingTsExtensions` 설정 |
| 타입 import | `import type` | `verbatimModuleSyntax` 설정 |
| enum | 쓰지 않고 문자열 유니언 | `erasableSyntaxOnly` 설정 |
| 주석 | 왜 그런지만 씀 | 무엇을 하는지는 코드와 이름이 말함 |

### 설계 방식

| 방식 | 어디에 | 얻는 것 |
|---|---|---|
| 판별 유니언 | `VNode`, `Patch` | `switch`에서 타입이 자동으로 좁혀지고 빠진 케이스를 잡음 |
| 순수 함수 | `diff`, `selectTasks`, 자식 컴포넌트 | 같은 입력이면 같은 결과라 테스트가 쉬움 |
| 불변 데이터 | Virtual DOM, 상태 | 복사 없이 기록 저장, `===`로 빠른 비교 |
| 데이터로 표현한 명령 | `Patch[]` | 실행과 기록, 표시를 분리 |
| 의존성 주입 | `createLabControls` | 버튼 없이 규칙만 테스트 |
| 경계에서 정규화 | `h`, `domToVdom` | 안쪽 코드는 깨끗한 값만 다룸 |
| 빠르게 실패 | Hook 순서, 패치 경로 | 조용히 틀리지 않고 그 자리에서 알림 |
| 클로저 | `setValue` | 렌더가 끝나도 자기 칸을 기억 |

### 테스트 방식

| 층 | 내용 |
|---|---|
| 단위 테스트 | 모듈마다 입력과 출력 확인 |
| 기능 테스트 | jsdom에서 버튼을 눌러 화면 흐름 확인 |
| 무작위 대조 | 시드를 고정한 무작위 트리로 패치 결과와 새로 만든 DOM을 비교 |
| 돌연변이 검사 | 코드를 일부러 망가뜨려서 테스트가 잡아내는지 확인 |
| 실제 브라우저 | 레이아웃, 포커스, MutationObserver, 애니메이션 확인 |

돌연변이 검사에서 구멍을 하나 찾았습니다. 루트의 key 비교를 없애도 테스트가
통과했습니다. 자식은 짝짓기 단계에서 이미 key를 비교해서, 이 줄이 일하는 곳이
루트뿐이었기 때문입니다. 그 뒤 테스트를 추가했습니다.

---

## 5. 설명 연습 질문

과제의 중점 포인트입니다. 코드를 보지 않고 답해 보세요.

### Phase 1

**실제 DOM은 왜 느린가요?**
DOM을 바꾸면 브라우저가 위치와 크기를 다시 계산하고(Reflow), 다시 칠합니다(Repaint).
Reflow는 자식과 주변까지 번질 수 있어서 비쌉니다. 값을 바꾸고 바로 크기를 읽는 일을
반복하면 그때마다 계산이 강제되어 특히 느려집니다.

**Virtual DOM은 왜 필요한가요?**
"더 빠른 DOM"이 아닙니다. 손으로 잘 짠 DOM 코드가 더 빠를 수도 있습니다.
진짜 이점은 개발자가 "어떤 모습이어야 하는가"만 적으면, 최소 변경을 도구가
찾아 준다는 점입니다. 변경을 모아서 한 번에 반영하기도 쉬워집니다.

**DOM 변화를 감지하는 API는 무엇인가요?**
`MutationObserver`입니다. 이 프로젝트는 연산 개수와 별개로 이것으로 실제 변경을
세어서, Diff의 주장을 브라우저가 검증하게 했습니다. 이동 한 번은 빼기와 끼우기,
두 건으로 잡힙니다.

**Diff의 시간 복잡도는요?**
두 트리의 완전한 최소 편집은 O(n³)이라 쓸 수 없습니다. 그래서 "태그가 다르면
아래는 비교하지 않는다", "형제끼리만 비교한다"는 가정으로 대부분 O(n)에 끝냅니다.
이 구현에서 안 바뀐 목록은 LIS 때문에 O(n log n)입니다. 옮기거나 끼우는 노드마다
`indexOf`를 쓰므로, 많이 뒤섞인 긴 목록은 O(n²)까지 늘어날 수 있습니다.

**key는 왜 필요한가요?**
자리가 바뀌어도 같은 노드임을 알아보기 위해서입니다. 없으면 자리 순서로 비교해서
내용을 전부 고치게 되고, 입력값과 포커스도 다른 항목으로 넘어갈 수 있습니다.

### Phase 2

**State는 어디에 두나요?**
그 값을 쓰는 컴포넌트들의 가장 가까운 공통 부모입니다. 이번 과제는 루트에 모두 둡니다.
값은 props로 내려가고, 변경은 콜백으로 올라옵니다(Lifting State Up).

**UI를 어떻게 나눴나요?**
한 가지 일을 하고 props만으로 설명되는 단위로 나눴습니다. `Progress`, `FocusTimer`,
`Composer`, `Toolbar`, `TaskList`, `TaskRow`입니다.

**setState는 값 변경 말고 무엇을 하나요?**
같은 값이면 멈추고, 다시 그리기를 예약합니다. 3-9와 3-10을 보세요.

**왜 조건문 안에서 Hook을 쓰면 안 되나요?**
칸을 호출 순서로 찾기 때문입니다. 3-8을 보세요.

### 이 구현과 실제 React의 차이

| 항목 | mini-react | 실제 React |
|---|---|---|
| 렌더 | 재귀로 한 번에 끝냄 | Fiber로 쪼개고 중단, 재개 가능 |
| 우선순위 | 없음 | 업데이트마다 우선순위가 다름 |
| 상태 위치 | 루트만 | 모든 컴포넌트 |
| 자식 컴포넌트 | `h()`에서 바로 펼침 | Fiber 노드로 따로 관리 |
| 상태 변경 | 호출 즉시 칸에 반영 | 큐에 쌓고 렌더할 때 계산 |
| 이벤트 | 요소마다 리스너와 표 | 루트에서 위임, SyntheticEvent |
| `useEffect` 시점 | DOM 반영 직후 동기 실행 | 보통 화면을 그린 뒤 실행 |
| 목록 이동 | LIS | `lastPlacedIndex` |
| 반환값 | 노드 하나 또는 null | 배열, Fragment, Portal 등 |
| 제어 컴포넌트 | 상태가 안 바뀌면 입력값을 되돌리지 않음 | 상태 값으로 되돌림 |

---

## 6. 직접 해 볼 실험

1. 실험실에서 `순서 뒤집기`를 누른 뒤 Patch를 누르고, 연산 목록의 이동 개수를 세어 보세요.
2. 코드칸에서 `data-key`를 모두 지우고 Patch한 뒤 다시 `순서 뒤집기`를 해 보세요.
   이동 대신 글자 변경이 나옵니다. key의 역할이 보입니다.
3. 집중 보드에서 타이머를 켜고 노드 지도를 보세요. 칸 하나만 색이 듭니다.
4. `use-effect.ts`의 정리 함수 호출을 잠깐 지우고 테스트를 돌려 보세요.
5. `diff.ts`에서 `to` 계산을 `anchor`로 바꾸고 테스트를 돌려 보세요.
   무작위 대조 테스트가 어떤 입력에서 깨지는지 볼 수 있습니다.
