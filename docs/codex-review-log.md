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
