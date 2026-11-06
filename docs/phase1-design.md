# Phase 1 설계 — Virtual DOM · Diff · Patch

> [!summary] 한 줄 컨셉
> **"Virtual DOM 은 순수한 데이터, 실제 DOM 은 번호로 찾는다."**
> 노드는 늘 `{ type, props, children }` 세 칸, Diff 는 경로(path) 달린 할 일 목록, Patch 는 그 목록대로 그 노드만 고친다.

- 실행: `index.html` 더블클릭 (서버 필요 없음)
- 테스트: `npm install` 한 번 → `npm test` (73개)
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
| src/history.js | `createHistory(v0)` | 첫 VDOM | `{ push, back, forward, current, canBack, canForward }` — 넣고 꺼낼 때마다 트리를 재귀 복사 (props 는 한 단계 복사 — 지금 props 값은 글자 · 함수뿐이라 충분) |

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

### 구현 메모 — 왜 이렇게 했나

> 코드 주석은 함수마다 한 줄로 줄였다. 지운 주석 중 "이유"를 설명하던 것을 여기 모았다.

**공통**

| 어디 | 무엇 | 왜 |
| --- | --- | --- |
| 모든 `src/*.js` | ES 모듈 대신 즉시 실행 함수 + `window.MiniReact` / `module.exports` | `index.html` 을 `file://` 로 더블클릭해 열면 브라우저가 ES 모듈을 막는다. 같은 파일을 Node 테스트에서도 `require` 로 읽는다 |

**변환 · 렌더 (src/vdom.js)**

| 함수 | 무엇 | 왜 |
| --- | --- | --- |
| `domToVdom` | 태그 이름을 `tagName` 이 아니라 `localName` 으로 읽음 | HTML 은 소문자, SVG 는 `linearGradient` 처럼 원래 대소문자가 남는다 (`tagName` 은 HTML 을 대문자로 줌) |
| `domToVdom` · `stripScripts` · `diffProps` | 속성을 `props[name] = v` 대신 `Object.defineProperty` 로 넣음 | 이름이 `__proto__` 면 대입으로는 칸이 안 생긴다 |
| `domToVdom` · `render` | `<template>` 는 자식을 `.content` 에서 읽고 `.content` 에 넣음 | template 의 자식은 `childNodes` 가 아니라 문서 조각 `.content` 안에 있다 |
| `childrenToVdom` | `children` 이 아니라 `childNodes` 를 돈다 | `children` 은 요소만 줘서 텍스트를 잃는다 |
| `htmlToChildren` | `<template>` 의 `innerHTML` 로 파싱 | template 안은 실행되지 않는다 → `<img onerror>` · `<script>` 가 읽는 순간 실행되지 않음 |
| `stripScripts` | 테스트 영역 입력에서 `<script>` 와 `on…="문자열"` 을 뺌 | `createElement('script')` 로 만들어 붙여도 실행된다. Phase 2 의 이벤트는 문자열이 아니라 함수라 영향 없음 |
| `setProp` | 이벤트 함수를 `WeakMap` 에 요소별로 기억 | 함수를 바꿀 때 옛 함수를 `removeEventListener` 해야 한다 |
| `setProp` | 함수를 붙일 때 같은 이름의 문자열 속성(`onclick="…"`)을 지움 | 남아 있으면 둘 다 실행된다 |
| `setProp` | `xlink:` · `xml:` 속성은 `setAttributeNS` | `setAttribute` 로 넣으면 이름공간을 잃어 SVG `<use>` 참조가 동작하지 않는다 |
| `setProp` | `value` · `checked` · `selected` 는 속성과 프로퍼티를 함께, 단 `input` · `textarea` · `select` · `option` 에만 | 지금 상태는 프로퍼티에 있다 (`<input value="a">` 에 b 를 치면 속성 a, `.value` b). `<li value>` · `<progress value>` 의 `.value` 는 숫자라 대입하면 `"01"` → `"1"` 이 되거나 예외 |
| `setProp` | `type="file"` 이면 `.value` 를 건드리지 않음 | 보안상 `''` 외의 값은 넣을 수 없다 (예외) |
| `namespaceForChildren` | `foreignObject` · `desc` · `title`(SVG), `mi` · `mo` · `mn` · `ms` · `mtext`(MathML) 안의 자식은 HTML | HTML 파서의 "integration point" 규칙과 같게 |
| `render` | `<select>` 의 `value` 는 자식(option)을 다 붙인 뒤에 넣음 | option 이 생기기 전에는 그 값을 고를 수 없다 |
| `toHtml` | 자식이 모두 요소일 때만 들여씀, `<pre>` 안은 안 들여씀 | 들여쓰기(줄바꿈 + 공백)는 읽을 때 버려지니 안전. 글자가 섞여 있으면 글자에 공백이 붙어 버린다 |
| `nodeToHtml` | `<script>` · `<style>` 등 raw text 요소 안 글자는 이스케이프하지 않음, 단 HTML 이름공간일 때만 | 이스케이프하면 내용이 바뀐다. SVG 안 `<style>` 은 raw text 가 아니다 |
| `nodeToHtml` | `<pre>` · `<textarea>` 글자가 줄바꿈으로 시작하면 줄바꿈 하나를 더 씀 | 파서가 여는 태그 바로 뒤 첫 줄바꿈 하나를 지운다 |
| `escapeText` · `escapeAttr` | ` ` 은 `&nbsp;`, `\r` 은 `&#13;` 로 씀 | 그대로 쓰면 다시 읽을 때 보통 공백 · `\n` 으로 바뀐다 |

**Diff (src/diff.js)**

| 함수 | 무엇 | 왜 |
| --- | --- | --- |
| `walk` | 없어진 뒤쪽 자식은 뒤 번호부터 REMOVE | 앞에서부터 빼면 남은 번호가 밀려 엉뚱한 노드를 지운다. 생긴 자식은 앞 번호부터 CREATE |
| `walk` | `<select value>` 는 값이나 option 이 바뀌면 자식 patch 뒤에 value PROPS 를 한 번 더 냄 (value 만 바뀐 앞 PROPS 는 뺌) | option 이 다 갖춰진 뒤에야 고를 수 있다 |

**Patch (src/patch.js)**

| 함수 | 무엇 | 왜 |
| --- | --- | --- |
| `findNode` | 경로에서 노드를 못 찾으면 에러 | DOM 과 VDOM 이 어긋났다는 뜻 → 조용히 엉뚱한 곳을 고치지 않게 |
| `applyPatches` | REPLACE 때 부모가 문서 조각(template 안)이거나 없으면 HTML 이름공간 | 옛 노드(예: svg)의 이름공간을 물려받으면 SVG `<p>` 가 생긴다 |
| `syncTextarea` | textarea 의 글자 자식을 고친 뒤 `.value` 도 맞춤 | 글자 자식은 "처음 값" 일 뿐, 사용자가 한 번 입력하면 화면 값은 따로 논다 |
| `syncFormState` | Patch · 기록 이동 뒤 폼 요소의 프로퍼티만 VDOM 대로 맞춤 | diff 는 VDOM 끼리만 비교해서 사용자가 실제 영역에 직접 친 값은 patch 에 안 잡힌다. 속성은 안 건드리니 DOM 변경은 0건 |
| `mount` | 루트 요소와 그 속성은 두고 자식만 다시 그림 | 이 뒤로 `childNodes` 와 `children` 이 1:1 이 된다 (결정 ④ 의 전제) |

**검증 페이지 (app.js)**

| 함수 | 무엇 | 왜 |
| --- | --- | --- |
| (로드) | `MutationObserver` 로 실제 영역 변경을 셈 | "바뀐 곳만" 반영했는지 patch 수와 나란히 눈으로 확인 |
| `onPatch` | 변경이 없으면 기록에 안 넣고, 파서가 고친 모양으로 테스트 영역을 다시 씀 | 같은 화면이 기록에 쌓이지 않게. 잘못 닫힌 HTML 이 어떻게 읽혔는지 보여 줌 |
| `apply` | 적용 중 예외가 나면 지금 기록(`shown`)대로 `mount` 하고 `null` | 일부만 바뀐 채 남으면 화면 · 기록 · 테스트 영역이 계속 어긋난다 |
| `travel` | 적용이 실패하면 목표 기록을 그대로 다시 그림 | 기록끼리의 이동은 원래 실패하지 않지만 만약을 위해 |
| `flash` | 바뀐 노드를 `element.animate` 로 깜빡임, REMOVE 는 부모 · 텍스트는 부모 요소를 | class 를 붙이면 속성이 바뀌어 DOM ↔ VDOM 이 어긋난다. Web Animations 는 속성을 안 건드림 |

---

## 4. 고려한 엣지 케이스

> 테스트 이름에 `[C1-n]` 이 붙은 것은 Codex 가 찾아서 고친 것.

### 정상

| 경우 | 기대 | 테스트 |
| --- | --- | --- |
| 아무것도 안 바꾸고 Patch | patch 0건, 기록 안 늘어남 | diff "같은 트리면 patches 가 비어 있다", 페이지 확인 |
| 글자만 바뀜 | TEXT 1건, 텍스트 노드 객체는 그대로 | patch "TEXT: 글자만 바꾸고 노드는 그대로" |
| 속성 바뀜 · 생김 · 없어짐 | PROPS 1건에 모아서 | diff "속성: 바뀐 것 · 생긴 것은 set…", patch "PROPS" |
| 목록 끝에 추가 · 삭제 | CREATE / 뒤에서부터 REMOVE | diff "자식이 늘면 / 줄면" |
| 태그가 바뀜 | REPLACE, 형제는 그대로 | patch "REPLACE" |
| 뒤로 · 앞으로 · 뒤로 간 뒤 새 Patch | 앞 기록은 버림 (브라우저와 같음) | patch "History" 4개 |

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
| `<li value="01">` · `<progress value="abc">` | 속성만 넣음 (`.value` 프로퍼티는 폼 요소만) | `[C5-2]` |
| 루트가 생김 · 없어짐 | 새 루트 / `null` | `[C2-2]` |
| `__proto__` 같은 속성 이름 | 진짜 칸으로 비교 | `[C2-3]` |
| 무작위 트리 500쌍 | render(old) + patch == new | patch "무작위 트리 500쌍" |

### 이상

| 경우 | 기대 | 테스트 |
| --- | --- | --- |
| 닫히지 않은 HTML (`<p>a<p>b`) | 브라우저 파서가 고친 모양을 따름, 테스트 영역도 고친 모양으로 다시 씀 | vdom "닫히지 않은 HTML" |
| `<img onerror>` · `<script>` 입력 | 읽을 때 실행 안 함(template 파싱), 실제 영역에 넣을 때도 뺌, 뺀 자리 양옆 글자는 합침 (`[C5-1]`) | vdom "스크립트 · onerror", patch "테스트 영역 입력의 script" |
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
| MathML 의 드문 경계 (`annotation-xml encoding="text/html"` 안 HTML, `<mi>` 안 `mglyph`) 이름공간이 파서와 다름 | 거의 안 쓰는 경우라 Phase 1 범위 밖 (Codex ⑤) | 필요하면 `namespaceForChildren` 에 규칙 추가 |
| `<plaintext>` 지원 안 함 | 닫을 수 없는 폐기된 요소 | — |
| 실제 영역에서 사용자가 바꾼 값(입력 · 체크)은 VDOM 에 없음 | VDOM 은 테스트 영역 HTML 에서만 만든다 (요구사항대로) | Phase 2 에서 state 로 다룸 |

---

## 6. 테스트 도구

| 도구 | 왜 |
| --- | --- |
| `node:test` (Node 내장) | 설치 없이 `npm test` 한 줄 |
| `jsdom` (개발 의존성 하나) | Node 에는 `document` 가 없다. 브라우저 DOM 을 흉내 내서 변환 · Patch 를 실제 DOM API 로 검사 |
| 브라우저 직접 확인 | 실제 Chrome 에서 Patch · 뒤로 · 앞으로를 눌러 봄. 페이지가 patch 수와 실제 DOM 변경 수(MutationObserver)를 나란히 보여 줌 — 둘은 같지 않을 수 있다 (PROPS 1건에 속성 2개면 변경 2건) |
