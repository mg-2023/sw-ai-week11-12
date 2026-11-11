# 명세: 조회수 +1 버튼 (component / state / hooks 1단계)

## 목표

기존 VDOM / Diff 검증 페이지에 함수 컴포넌트, `useState`, 클릭 이벤트를 추가한다.
`조회수 +1` 버튼을 누르면 `조회수: 10 회`가 `조회수: 11 회`로 바뀌고, 그 변화가 기존 검증 로그에 `TEXT` 패치 하나로 찍혀야 한다.

## 핵심 결정

이벤트 핸들러를 DOM 노드에 붙이지 않는다. `#real-root`에 리스너 하나만 달고, 클릭된 노드의 경로로 VDOM에서 핸들러를 찾아 실행한다(이벤트 위임).

- 핸들러가 DOM에 없으므로 `src/vdom.js`, `src/diff.js`, `src/patch.js`는 변경하지 않는다.
- 핸들러는 항상 최신 VDOM에서 찾으므로, 렌더마다 함수가 새로 만들어져도 패치가 생기지 않는다.

## VNode 형식

기존 형식에 선택 필드 `events` 하나를 더한다.

```js
{ type, props, children }            // 기존 (텍스트 노드는 문자열)
{ type, props, events, children }    // 핸들러가 있는 노드. events 예: { click: fn }
```

- `props`에는 지금처럼 문자열 속성만 들어간다.
- `diff`, `vdomEqual`, `serializeNode`, `createDom`은 `events`를 보지 않는다. 따라서 Diff 결과, 검증, 테스트 영역 HTML에 영향을 주지 않는다.

## 1. 조회수 +1 버튼을 누르면 일어나는 일

1. **클릭 감지**: `#real-root`에 등록된 click 리스너가 이벤트를 받는다.
2. **경로 계산**: 클릭된 DOM 노드에서 `#real-root`까지 올라가며 `childNodes` 인덱스를 모은다. 버튼이면 `[0, 4]`.
3. **핸들러 찾기**: 현재 VDOM을 그 경로로 따라 내려가 해당 VNode의 `events.click`을 찾는다. 없으면 부모 쪽으로 올라가며 찾는다.
4. **핸들러 실행**: `() => setViews(v => v + 1)`이 실행된다.
5. **state 변경**: `setViews`가 훅 저장소의 값을 10에서 11로 바꾼다. 값이 같으면(`Object.is`) 여기서 끝난다.
6. **리렌더**: 훅 커서를 0으로 되돌리고 `App()`을 다시 실행한다. 자식 컴포넌트까지 펼쳐 일반 VNode 트리를 만들고 `#root`로 감싼다.
7. **Diff**: 기존 `patchToVdom(realEl, 이전 VDOM, 새 VDOM)`을 호출한다. 결과는 `TEXT [0,1,1,0] "11"` 패치 하나다.
8. **Patch와 검증**: 기존 `applyPatches`가 `<b>` 안 텍스트 노드의 값만 바꾸고, 결과 DOM이 새 VDOM과 같은지 확인한다.
9. **커밋 알림**: 새 VDOM을 "이전 VDOM"으로 저장하고 `onCommit`으로 `app.js`에 결과를 넘긴다. `app.js`가 깜빡임, History 저장, 로그 출력을 한다.

리렌더는 `setViews` 호출 즉시 동기적으로 실행한다. 여러 번의 호출을 한 번의 렌더로 묶는 배칭은 이번 범위가 아니다.

## 2. 브라우저에서 보이는 모습

### 컴포넌트 모드 진입

툴바에 모드 토글 버튼을 하나 추가한다. 누르면:

- 실제 영역의 카드 맨 아래에 `조회수 +1` 버튼이 생긴다. 로그에는 `CREATE [0,4]` 패치가 찍힌다. (샘플 HTML을 수정하지 않은 상태 기준. 수정했다면 그 차이도 함께 패치로 나온다.)
- 테스트 영역 textarea는 읽기 전용이 되고, 렌더 결과 HTML을 보여준다.
- `Patch`, `뒤로`, `앞으로` 버튼과 State History 항목 클릭은 비활성화된다.
- `#real-root`의 `inert` 속성을 뗀다. (붙어 있으면 클릭이 전달되지 않는다.)

토글을 다시 누르면 HTML 편집 모드로 돌아간다. 위 항목을 모두 원래대로 되돌리고 위임 리스너를 해제한다. 다시 진입하면 state는 초기값(10)에서 시작한다.

### 버튼 클릭 시

| 위치 | 보이는 변화 |
|---|---|
| 실제 영역 | `조회수: 10 회`가 `조회수: 11 회`로 바뀌고, 숫자 부분만 노랗게 깜빡임 |
| 로그 제목 | `렌더 (state 변경) → State #N 저장` |
| 로그 칩 | `패치 1개`, `실제 영역 DOM 변경 1건`, `✅ 실제 영역 = 목표 VDOM` |
| 패치 목록 | `TEXT [0, 1, 1, 0] "11"` |
| 테스트 영역 | HTML 소스의 `<b>10</b>`이 `<b>11</b>`로 갱신 |
| State History | `렌더 N` 항목 하나 추가, 위치 표시 증가 |
| VDOM JSON | `<b>`의 children이 `["11"]` |

## 3. 모듈과 함수

### 새 모듈

| 모듈 | 함수 | 역할 |
|---|---|---|
| `src/compo.js` | `h(type, props, ...children)` | VNode 생성. `on*` 함수는 `props`가 아닌 `events`로 분리 |
| | `expand(vnode)` | `type`이 함수인 노드를 실행해 일반 VNode 트리로 펼침 |
| `src/hooks.js` | `useState(initial)` | `[값, setter]` 반환. 훅 배열과 커서로 관리. setter는 값 또는 `prev => next` 함수를 받음 |
| | `beginRender()` | 렌더 직전에 커서를 0으로 |
| | `resetHooks()` | 마운트할 때 저장소 비우기 |
| | `onStateChange(fn)` | setter가 부를 리렌더 함수 등록 |
| `src/events.js` | `pathOf(container, node)` | DOM 노드 → 인덱스 경로 |
| | `delegate(container, getVdom)` | 위임 리스너 등록, 해제 함수 반환 |
| `src/root.js` | `createRoot(container, { onCommit })` | `mount(Component, 현재 VDOM)`, `unmount()` 제공. 리렌더 → `patchToVdom` → `onCommit` 흐름 담당 |
| `demo/App.js` | `App`, `ViewCount`, `PlusButton` | 예제 컴포넌트 |

의존 방향:

```
demo/App.js ──▶ compo.js, hooks.js
root.js     ──▶ compo.js, hooks.js, events.js, patch.js(patchToVdom)
app.js      ──▶ root.js, demo/App.js (+ 기존 모듈)
```

`src/` 아래 모듈은 기존 규칙대로 UI(깜빡임, 로그)를 다루지 않는다. 결과는 `onCommit({ next, patches, mutated, touched, verified })`으로만 내보낸다.

### 기존 모듈

| 모듈 | 변경 |
|---|---|
| `src/vdom.js`, `src/diff.js`, `src/patch.js` | 없음 |
| `src/history.js` | `push(vdom, patches, label)`에 선택 인자 `label` 추가 (없으면 기존 `Patch N`) |
| `app.js` | 모드 토글, `createRoot` 연결, `onCommit`에서 기존 `flash` / `updateUI` / `showLog` 호출, 컴포넌트 모드에서 `doPatch` / `goTo` 차단 |
| `virtual-dom-diff-verifier.html` | 토글 버튼 하나 추가 |

### 예제 컴포넌트

```js
function ViewCount({ views }) {
  return h('p', { class: 'desc' }, '조회수: ', h('b', null, views), ' 회');
}

function PlusButton({ onClick }) {
  return h('button', { class: 'btn', onClick }, '조회수 +1');
}

export function App() {
  const [views, setViews] = useState(10);
  return h('div', { class: 'card', id: 'profile' },
    h('h2', { class: 'title' }, 'Virtual DOM 연습'),
    h(ViewCount, { views }),
    h('ul', { class: 'list' },
      h('li', null, 'React'),
      h('li', { class: 'done' }, 'Virtual DOM'),
      h('li', null, 'Diff 알고리즘')),
    h('button', { class: 'btn', disabled: true }, '저장'),
    h(PlusButton, { onClick: () => setViews((v) => v + 1) }));
}
```

## 제약

### `h()`의 정규화 규칙

기존 검증은 Patch 후의 DOM을 다시 VDOM으로 읽어 목표 VDOM과 비교한다. `h()`가 만든 VDOM이 "DOM에서 읽은 VDOM"과 같은 모양이 아니면 화면은 맞아도 `❌`가 뜬다.

- children: 숫자는 문자열로 바꾼다. 배열은 펼친다. `null`, `undefined`, `true`, `false`는 버린다. 이웃한 문자열은 하나로 합친다. 빈 문자열은 버린다.
- props: 값이 `true`면 `''`로 넣는다(`disabled`). `false`, `null`, `undefined`면 넣지 않는다. 그 외는 문자열로 바꾼다.
- `on`으로 시작하고 값이 함수인 prop은 `events`로 옮긴다(`onClick` → `events.click`).
- 요소 사이에 공백만 있는 텍스트를 만들지 않는다.

### 범위 제한

- 훅은 루트 컴포넌트(`App`)에서만 호출한다. 자식 컴포넌트는 props만 받는 순수 함수다.
- 위임하는 이벤트는 `click`뿐이다.
- 컴포넌트 모드에서 뒤로/앞으로는 막는다. VDOM만 되돌리면 화면은 10인데 state는 11인 상태가 되기 때문이다.

## 완료 조건

1. 컴포넌트 모드에서 `조회수 +1`을 누를 때마다 숫자가 1씩 오른다.
2. 클릭마다 패치는 `TEXT [0,1,1,0]` 하나이고, DOM 변경은 1건이다.
3. 매 렌더 후 검증 칩이 `✅`다.
4. 클릭마다 State History에 항목이 하나 추가되고, 테스트 영역 HTML과 VDOM JSON이 갱신된다.
5. HTML 편집 모드의 기존 동작(Patch, 뒤로, 앞으로)이 전과 같다.
6. `src/vdom.js`, `src/diff.js`, `src/patch.js`에 diff가 없다.

## 다음 단계 (이번 범위 아님)

- Todo 추가 / 토글 / 삭제
- State History에 state 스냅샷 저장 (뒤로/앞으로 다시 열기)
- 파생 상태(`useMemo`), `useEffect`
- `setState` 배칭
- 자식 컴포넌트별 state, key 기반 diff
