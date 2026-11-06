# Phase 1 설계 — Virtual DOM · Diff · Patch

> [!summary] 한 줄 컨셉
> **"Virtual DOM 은 순수한 데이터, 실제 DOM 은 번호로 찾는다."**
> 노드는 늘 `{ type, props, children }` 세 칸, Diff 는 경로(path) 달린 할 일 목록, Patch 는 그 목록대로 그 노드만 고친다.

- 실행: `index.html` 더블클릭 (서버 필요 없음)
- 테스트: `npm install` 한 번 → `npm test` (69개)
- 기록: Codex 검증은 [codex-review-log.md](codex-review-log.md)

---

## 1. 한 바퀴 흐름

| 순서 | 무엇 | 함수 (파일) |
| --- | --- | --- |
| 로드 1 | 실제 영역 DOM → Virtual DOM | `domToVdom` (src/vdom.js) |
| 로드 2 | 실제 영역을 VDOM 대로 한 번 다시 그림 (DOM ↔ VDOM 1:1) | `mount` (src/patch.js) |
| 로드 3 | VDOM → HTML 글자 → 테스트 영역 | `toHtml` (src/vdom.js) |
| Patch 1 | 테스트 영역 HTML → 새 VDOM | `htmlToVdom` (src/vdom.js) |
| Patch 2 | 이전 VDOM vs 새 VDOM → 할 일 목록 | `diff` (src/diff.js) |
| Patch 3 | 할 일 목록 → 실제 영역 (바뀐 곳만) | `applyPatches` (src/patch.js) |
| Patch 4 | 새 VDOM 을 기록에 저장 | `history.push` (src/history.js) |
| 뒤로 · 앞으로 | 기록의 VDOM 꺼냄 → diff → patch, 테스트 영역도 다시 씀 | `travel` (app.js) |

---

## 2. 넘겨받은 결정 4개

> 리뷰 전에 바꿔도 된다. 바꾸면 영향 받는 곳을 "바꾸면" 칸에 적었다.

| 결정 | 고른 것 | 이유 | 대안 (내준 것) | 바꾸면 |
| --- | --- | --- | --- | --- |
| ① 텍스트 노드 모양 | 객체 `{ type: '#text', props: { nodeValue: 'hi' }, children: [] }` | 모든 노드가 같은 세 칸 → Diff · render 가 "문자열인가?" 갈래 없이 한 길<br>글자 칸 이름을 DOM 의 `nodeValue` 와 같게 | 그냥 문자열 `'hi'` — 짧고 실제 리액트와 비슷하지만 함수마다 분기 | `text()` · `isText()` 와 diff 의 TEXT 비교 |
| ② 공백만 있는 텍스트 | **줄바꿈이 들어 있으면 버림**, 같은 줄 공백(`<b>a</b> <i>b</i>` 의 한 칸)은 남김. `<pre>` · `<textarea>` 안은 모두 남김 | 들여쓰기는 노드가 되면 Diff 가 "바뀜" 오탐을 낸다<br>같은 줄 공백은 화면에 보인다<br>JSX 의 공백 규칙과 같다<br>테스트 영역을 들여써서 보여 줘도 다시 읽으면 같은 VDOM (왕복 안전) | 다 버림 — 단순하지만 단어 사이 공백이 사라짐<br>다 남김 — 들여쓰기만 바꿔도 Diff 가 생김 | `isIndentText` 한 함수 |
| ③ 주석 | **버림**. 주석 때문에 끊긴 글자는 한 덩어리로 합침 (`a<!--x-->b` → `"ab"`) | 화면에 안 보임<br>남기면 Diff · Patch 에 노드 종류가 하나 더 생김<br>합치지 않으면 HTML 로 썼다 다시 읽을 때 개수가 달라짐 (Codex ① 이 찾음) | 남김 — 원본에 충실하지만 `#comment` 종류를 모든 함수가 알아야 함 | `childrenToVdom` |
| ④ Patch 가 노드 찾는 법 | **번호로 걷기**: patch 마다 `path` (예: `[2, 0]`) → `childNodes[2].childNodes[0]` | VDOM 이 순수 데이터로 남아 History 에 그대로 저장 · 복사 가능 (실제 노드를 붙여 두면 기록이 옛 노드를 가리킴)<br>Phase 2 에서 매번 새로 만드는 트리에 옛 연결을 넘길 필요 없음 | 렌더할 때 객체에 실제 노드를 붙여 두기 — 바로 찾지만 객체가 데이터가 아님 | 전제: DOM 과 VDOM 이 1:1 → 로드 때 `mount` 로 맞춤<br>번호 밀림 → diff 가 REMOVE 를 뒤 번호부터 냄 |

---

## 3. 모듈별 입력 · 출력

| 모듈 | 함수 | 입력 | 출력 |
| --- | --- | --- | --- |
| src/vdom.js | `domToVdom(node)` | 실제 DOM 노드 | VDOM 노드 (버릴 노드면 `null`) |
| | `htmlToVdom(html, rootVnode)` | HTML 글자, 이전 루트 | 새 루트 VDOM (`<script>` · `on…="문자열"` 뺌) |
| | `render(vnode, doc)` | VDOM 노드 | 새 실제 DOM 노드 (`createElement` 재귀, `innerHTML` 안 씀) |
| | `setProp(el, name, value)` | 요소, 속성 이름 · 값 | 없음. `null`/`false` 면 지움, `value`/`checked` 는 프로퍼티까지, `on…` 함수는 이벤트 |
| | `toHtml(children)` | VDOM 자식 배열 | 들여쓴 HTML 글자 (다시 읽으면 같은 VDOM) |
| src/diff.js | `diff(old, new)` | VDOM 두 개 | patch 목록 `[{ type, path, ... }]` |
| src/patch.js | `applyPatches(rootEl, patches)` | 실제 루트 요소, patch 목록 | 루트 요소 (루트가 바뀌면 새 요소) |
| | `mount(rootEl, vnode)` | 실제 루트 요소, VDOM | 루트 요소 (자식을 VDOM 대로 다시 그림) |
| src/history.js | `createHistory(v0)` | 첫 VDOM | `{ push, back, forward, current, canBack, canForward }` — 꺼낼 때마다 깊은 복사 |

**patch 종류 5개**

| type | 추가 칸 | 실제 DOM 에 하는 일 |
| --- | --- | --- |
| `CREATE` | `node` | 부모의 `path` 끝 번호 자리에 `insertBefore` |
| `REMOVE` | — | 그 노드 `removeChild` |
| `REPLACE` | `node` | 종류(type)가 다르면 통째로 `replaceChild` |
| `TEXT` | `value` | `nodeValue` 만 바꿈 (노드는 그대로) |
| `PROPS` | `set`, `remove` | 바뀐 속성만 `setProp` |

**Phase 2 대비**

- `props` 에 함수가 오면 이벤트로 붙이고, 바뀌면 옛 함수를 떼어 냄 (`setProp`, 테스트 있음)
- `h(type, props, ...children)` 로 VDOM 을 직접 만들 수 있음 (컴포넌트가 돌려줄 모양)
- 함수는 같은 함수일 때만 "안 바뀜" (diff 가 `!==` 로 비교)

---

## 4. 고려한 엣지 케이스

> 테스트 이름에 `[C1-n]` 이 붙은 것은 Codex 가 찾아서 고친 것.

### 정상

| 경우 | 기대 | 테스트 |
| --- | --- | --- |
| 아무것도 안 바꾸고 Patch | patch 0건, 기록 안 늘어남 | diff "같은 트리면 patches 가 비어 있다", 페이지 확인 |
| 글자만 바뀜 | TEXT 1건, 텍스트 노드 객체는 그대로 | patch "TEXT: 글자만 바꾸고 노드는 그대로" |
| 속성 바뀜 · 생김 · 없어짐 | PROPS 1건에 모아서 | diff · patch "PROPS" |
| 목록 끝에 추가 · 삭제 | CREATE / 뒤에서부터 REMOVE | diff "자식이 늘면 / 줄면" |
| 태그가 바뀜 | REPLACE, 형제는 그대로 | patch "REPLACE" |
| 뒤로 · 앞으로 · 뒤로 간 뒤 새 Patch | 앞 기록은 버림 (브라우저와 같음) | patch "History" 3개 |

### 경계

| 경우 | 기대 | 테스트 |
| --- | --- | --- |
| 들여쓰기 공백 | 버림, 같은 줄 공백은 남김 | vdom "들여쓰기 공백" |
| `<pre>` 안 공백 · 첫 줄바꿈 | 모두 남김, 왕복해도 같음 | vdom "pre", "toHtml 왕복" |
| 주석, 주석으로 끊긴 글자 | 버림, 합침 | `[C1-2]` |
| 빈 테스트 영역 | 자식 0개로 Patch | 페이지 확인 |
| 불리언 속성 (`disabled`, `checked`) | 지우면 실제로 꺼짐 (`setAttribute('disabled','false')` 함정 피함) | vdom "setProp: false · null" |
| 사용자가 실제 영역 input 에 친 값 | Patch 의 value 가 덮음 | patch "사용자가 바꾼 input 값" |
| 사용자가 친 textarea | 자식 글자와 `.value` 를 같이 맞춤 | `[C3-3]` |
| `<select value>` | option 이 생긴 뒤 고름 | `[C1-6]`, `[C2-1]` |
| SVG · MathML · `foreignObject` · `xlink:href` | 이름공간대로 만듦 | vdom "SVG", `[C1-4]`, `[C1-5]` |
| `<table>` 조각, `<template>` | 파서 규칙대로 (`tbody` 자동), `.content` 사용 | vdom "table", `[C3-2]` |
| 특수 문자 · 한글 · 이모지 · `&nbsp;` · `\r` | 그대로 왕복 | vdom "특수 문자", `[C1-7]` |
| 루트가 생김 · 없어짐 | 새 루트 / `null` | `[C2-2]` |
| `__proto__` 같은 속성 이름 | 진짜 칸으로 비교 | `[C2-3]` |
| 무작위 트리 500쌍 | render(old) + patch == new | patch "무작위 트리 500쌍" |

### 이상

| 경우 | 기대 | 테스트 |
| --- | --- | --- |
| 닫히지 않은 HTML (`<p>a<p>b`) | 브라우저 파서가 고친 모양을 따름, 테스트 영역도 고친 모양으로 다시 씀 | vdom "닫히지 않은 HTML" |
| `<img onerror>` · `<script>` 입력 | 읽을 때 실행 안 함(template 파싱), 실제 영역에 넣을 때도 뺌 | vdom "스크립트 · onerror", patch "테스트 영역 입력의 script" |
| 텍스트에 `<img onerror=…>` 글자 | 글자로만 들어감 (`innerHTML` 안 씀) | vdom "render 는 텍스트를 HTML 로 해석하지 않는다" |
| `<input type="file" value>` | 예외 없이 그림 | `[C1-1]` |
| DOM 과 VDOM 이 어긋남 | "경로 […] 에서 노드를 찾지 못했습니다" 에러 | patch "어긋나면 알 수 있는 에러" |
| 모르는 patch 종류 | 에러 | 같은 테스트 |

---

## 5. 알려진 한계 (일부러 안 한 것)

| 한계 | 왜 안 했나 | 나중에 |
| --- | --- | --- |
| `key` 비교 없음 — 목록 맨 앞에 넣으면 뒤 항목이 모두 TEXT 로 바뀌고 끝에 CREATE | Phase 1 마감 우선. 결과는 맞고 효율만 떨어짐 (테스트로 동작 고정) | Phase 2 에서 목록 렌더링이 생기면 `props.key` 로 이동(MOVE) patch 추가 |
| 로드 때 실제 영역을 한 번 다시 그림 (`mount`) | 번호로 걷기의 전제(1:1)를 맞추는 가장 단순한 방법 | — |
| 줄바꿈만 있는 공백은 화면에서도 사라짐 (예: `</label>\n<button>` 사이 공백) | 결정 ② 의 대가 | 같은 줄에 쓰면 남는다 |
| `<plaintext>` 지원 안 함 | 닫을 수 없는 폐기된 요소 | — |
| 실제 영역에서 사용자가 바꾼 값(입력 · 체크)은 VDOM 에 없음 | VDOM 은 테스트 영역 HTML 에서만 만든다 (요구사항대로) | Phase 2 에서 state 로 다룸 |

---

## 6. 테스트 도구

| 도구 | 왜 |
| --- | --- |
| `node:test` (Node 내장) | 설치 없이 `npm test` 한 줄 |
| `jsdom` (개발 의존성 하나) | Node 에는 `document` 가 없다. 브라우저 DOM 을 흉내 내서 변환 · Patch 를 실제 DOM API 로 검사 |
| 브라우저 직접 확인 | 실제 Chrome 에서 Patch · 뒤로 · 앞으로를 눌러 봄 (patch 수 == 실제 DOM 변경 수) |
