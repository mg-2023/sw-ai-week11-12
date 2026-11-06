# Codex 검증 기록

- 검증자: Codex CLI (`codex exec -s read-only`) — 읽기 전용, 파일을 고치지 않음
- 지시: 과제 요구사항 원문 + "빠진 동작 · 엣지 케이스 · 버그만, 스타일 지적 X"
- 표 읽는 법: 찾은 것 → 받아들였나(이유) → 고친 것 · 테스트 이름

---

## ① 변환 (`src/vdom.js`)

| # | Codex 가 찾은 것 | 심각도 | 받아들였나 · 이유 | 고친 것 |
| --- | --- | --- | --- | --- |
| 1 | `<input type="file" value="x">` 를 render 하면 `.value` 대입에서 예외 | 높음 | ✅ 사용자가 칠 수 있는 HTML 로 페이지가 멈춘다 | `setProp` 에서 file 입력은 `.value` 를 건드리지 않음 · `[C1-1]` |
| 2 | `a<!--x-->b` 가 처음엔 텍스트 2개, 왕복하면 1개 → 아무것도 안 고쳐도 Diff 가 생김 | 중간 | ✅ 결정 3(주석 버림)의 빈틈. 테스트 영역은 왕복을 거친다 | `childrenToVdom` 이 주석을 건너뛰며 이어진 글자를 합침 · `[C1-2]` |
| 3 | SVG 안 `<style>` 글자를 HTML raw text 처럼 이스케이프 안 함 | 중간 | ✅ 왕복하면 구조가 깨짐 | 직렬화가 이름공간을 따라가며 HTML 일 때만 raw text · `[C1-3]` |
| 4 | `xlink:href` 를 `setAttribute` 로 넣어 이름공간을 잃음 | 중간 | ✅ 고치는 비용이 작다 | `xlink:` · `xml:` 은 `setAttributeNS` · `[C1-4]` |
| 5 | MathML 을 HTML 로 만듦 / SVG `<title>` 안 HTML 요소를 SVG 로 만듦 | 중간 | ✅ 파서와 같은 규칙(integration point)을 따름 | `namespaceFor` · `namespaceForChildren` · `[C1-5]` |
| 6 | `<select value="b">` 가 처음 렌더에서 `a` 로 보임 (option 보다 먼저 value 대입) | 중간 | ✅ | render 에서 select 의 value 는 자식 뒤에 넣음 · `[C1-6]` |
| 7 | `\r` 이 왕복하며 `\n` 으로 바뀜 | 낮음 | ✅ 한 줄 수정 | `&#13;` 로 직렬화 · `[C1-7]` |
| 8 | `<plaintext>` 왕복 시 닫는 태그가 글자로 붙음 | 낮음 | ❌ 닫을 수 없는 폐기된 요소. 문서에 "지원 안 함" 으로 적음 | `toHtml` 주석 |

- 참고: Codex 샌드박스에서는 `node --test` 가 `spawn EPERM` → `--experimental-test-isolation=none` 으로 돌림 (우리 환경 문제 아님)

---

## ② Diff (`src/diff.js`)

| # | Codex 가 찾은 것 | 심각도 | 받아들였나 · 이유 | 고친 것 |
| --- | --- | --- | --- | --- |
| 1 | `<select value>` 의 PROPS 가 option CREATE 보다 먼저 나와 선택이 틀림. option 순서만 바뀌면 value 를 다시 안 넣음 | 중간 | ✅ ③ 에서도 같은 것을 따로 찾음 | select 는 값이나 자식이 바뀌면 자식 patch **뒤에** value PROPS 를 냄 · `[C2-1]` |
| 2 | `diff(undefined, 새 트리)` 의 루트 CREATE 를 patch 가 처리 못 함 (중첩되거나 예외) | 중간 | ✅ diff 와 patch 의 약속이 어긋남 | `applyPatches(null, patches, doc)` 로 새 루트를 돌려주고, 루트 REMOVE 는 null · `[C2-2]` |
| 3 | 이름이 `__proto__` 인 속성이 `set[name] = v` 로는 칸이 안 생겨 빠짐 | 낮음 | ✅ 한 줄 수정. 변환(`domToVdom`)에도 같은 문제가 있어 같이 고침 | `Object.defineProperty` 로 넣음 · `[C2-3]` |

## ③ Patch + History (`src/patch.js`, `src/history.js`)

| # | Codex 가 찾은 것 | 심각도 | 받아들였나 · 이유 | 고친 것 |
| --- | --- | --- | --- | --- |
| 1 | select value 순서 (② 1 과 같음) | 중간 | ✅ | ② 1 에서 고침 |
| 2 | `<template>` 안에서 REPLACE 하면 옛 노드(svg)의 이름공간을 물려받아 SVG `<p>` 가 생김 | 중간 | ✅ | 부모가 문서 조각이면 HTML 이름공간 · `[C3-2]` |
| 3 | 사용자가 입력한 `<textarea>` 는 글자 자식만 바꿔서는 화면 값이 안 바뀜 (Patch · 뒤로가기 모두) | 중간 | ✅ 속성 vs 프로퍼티 문제와 같은 종류 | 자식 글자를 바꾼 뒤 `.value` 도 맞춤 (`syncTextarea`) · `[C3-3]` |
| - | History 경계 · 분기는 확인된 버그 없음 | | | |

## 직접 찾은 것 (브라우저 확인 중)

| 찾은 것 | 처리 |
| --- | --- |
| 테스트 영역에 친 `<script>` 가 Patch 때 실행됨 (`createElement('script')` 로 붙여도 실행) | `htmlToVdom` 이 기본으로 `<script>` · `on…="문자열"` 을 뺌 (`stripScripts`). Phase 2 이벤트는 함수라 영향 없음 |
| 샘플의 `</label>` 과 `<button>` 사이 줄바꿈이 버려져 "동의함제출" 로 붙음 | 결정 2 의 예상된 대가. 샘플을 한 줄로 고치고 설계 문서에 적음 |

---

## ④ 검증 페이지 (`index.html`, `app.js`)

| # | Codex 가 찾은 것 | 심각도 | 받아들였나 · 이유 | 고친 것 |
| --- | --- | --- | --- | --- |
| 1 | patch 도중 예외(`a@` 같은 속성 이름)가 나면 일부만 바뀐 채 남고, `shown` · 기록과 화면이 계속 어긋남 | 높음 | ✅ 부분 적용은 가장 나쁜 상태. 단, 실제 Chrome 은 파서가 만든 속성 이름을 모두 받아 줘서 재현 안 됨 (jsdom 에서만 예외) → 방어 코드로 둠 | `apply` 가 실패하면 `mount(shown)` 으로 되돌리고 기록을 안 늘림 · `[C4-1]`, 브라우저에서 강제 실패로 확인 |
| 2 | 실제 영역 input 에 직접 친 값 · 체크 해제가 뒤로가기 · 변경 없는 Patch 뒤에도 남음 (두 기록의 value 가 같아 PROPS 가 안 나옴) | 중간 | ✅ "두 영역이 함께 바뀌어야" 에 어긋남 | `syncFormState` 가 Patch · 이동 뒤 폼 프로퍼티만 VDOM 대로 맞춤 (DOM 변경 0건) · `[C4-2]`, 브라우저 확인 |

---

## ⑤ 최종 (브랜치 전체)

- 요구사항 체크: 11개 중 8개 충족, 3개 "부분" → 원인은 아래 버그 ①②③ → ①② 고쳐서 해소, ③ 은 한계로 문서화
- 기준: 71개 테스트 모두 통과한 상태에서 리뷰

| # | Codex 가 찾은 것 | 심각도 | 받아들였나 · 이유 | 고친 것 |
| --- | --- | --- | --- | --- |
| 1 | `<p>a<script>…</script>b</p>` → script 를 뺀 뒤 `"a"` `"b"` 가 따로 남아, 안 고치고 다시 Patch 해도 TEXT · REMOVE 가 생기고 기록이 늘어남 | 중간 | ✅ 주석 병합(C1-2)과 같은 구멍 | `stripScripts` 뒤에 `mergeTexts` · `[C5-1]` |
| 2 | `<li value="01">` 은 `.value` 대입으로 `"1"` 이 되고, `<progress value="abc">` 는 예외 | 중간 | ✅ 프로퍼티 동기화를 폼 요소에만 해야 함 | `FORM_TAGS` (input · textarea · select · option) 만 프로퍼티 · `[C5-2]` |
| 3 | MathML `annotation-xml encoding="text/html"` · `<mi>` 안 `mglyph` 이름공간이 파서와 다름 | 중간 | ❌ 거의 안 쓰는 경계. 마감 대비 효과가 작음 | 설계 문서 「알려진 한계」 에 적음 |
| 문서 | 테스트 개수(69→73), History 테스트 수(3→4), PROPS 테스트 이름, "깊은 복사" 범위, "patch 수 == DOM 변경 수" 표현 | — | ✅ 모두 사실과 다름 | `docs/phase1-design.md` 수정 |

---

## 요약: Codex 가 잡은 것 중 중요한 3개

| 무엇 | 왜 중요했나 | 처리 |
| --- | --- | --- |
| patch 도중 예외 → 화면 · 기록이 어긋난 채로 굳음 (④-1) | 검증 페이지의 신뢰가 깨지는 유일한 "높음" | 실패하면 지금 기록대로 되돌림 |
| 주석 · script 를 뺀 자리에서 글자가 둘로 갈라짐 (①-2, ⑤-1) | 아무것도 안 고쳐도 Diff 가 생김 = 과제 핵심 동작의 오탐 | 뺀 자리 양옆 글자를 합침 |
| select · textarea · 직접 친 input 처럼 "속성 ≠ 지금 상태" 인 곳 (②-1, ③-3, ④-2) | 노트 2.3 의 속성 vs 프로퍼티 함정이 실제로 터진 곳 | 자식 뒤 value, `.value` 동기화, `syncFormState` |
