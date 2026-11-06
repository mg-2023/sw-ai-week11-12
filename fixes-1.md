### 1. `<svg>` 및 하위 태그 렌더링 실패 + 검증 오류 (`❌ 실제 영역 ≠ 목표 VDOM`)
가장 재현하기 쉬운 버그입니다. HTML 소스 편집에서 아이콘 등으로 흔히 쓰이는 `<svg>`를 넣으면 발생합니다.

* **원인**:
  1. [`parseHtmlToVdom`](file:///c:/Users/user/Desktop/dev/week11-12/virtual-dom-diff-verifier.html#L373-L377)은 `<template>.innerHTML`을 사용하므로 HTML5 파서가 `<svg>`와 그 자식들을 **SVG 네임스페이스**로 파싱합니다. 이때 `viewBox` 같은 속성이나 `<linearGradient>`, `<clipPath>` 같은 태그의 대소문자가 유지됩니다.
  2. 반면 [`createDom`](file:///c:/Users/user/Desktop/dev/week11-12/virtual-dom-diff-verifier.html#L269-L275)은 네임스페이스 구분 없이 무조건 `document.createElement(vnode.type)`를 호출해 **일반 HTML 네임스페이스(`HTMLUnknownElement`)**로 생성합니다.
* **결과**:
  * 브라우저가 SVG로 인식하지 못해 **화면에 그래픽이 전혀 그려지지 않습니다.**
  * `viewBox="0 0 24 24"`나 `<clipPath>` 등을 넣으면 `createDom`에서는 HTML 규칙에 따라 소문자(`viewbox`, `clippath`)로 강제 변환되지만, 목표 VDOM(`next`)에는 카멜케이스(`viewBox`, `clipPath`)로 남아 있어 Patch 직후 **`❌ 실제 영역 ≠ 목표 VDOM (버그)`** 배지가 뜹니다.
* **재현 코드**:
  ```html
  <svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="10"></circle></svg>
  ```

---

### 2. `<pre>` 관련 직렬화/파싱 비대칭 문제 (모드 전환만 해도 VDOM 변질)
[`isIgnorableText`](file:///c:/Users/user/Desktop/dev/week11-12/virtual-dom-diff-verifier.html#L214-L218)에서 `<pre>, <textarea>` 내부의 줄바꿈 공백은 보존하도록 예외 처리를 해두었는데, 정작 직렬화 함수([`serializeNode`](file:///c:/Users/user/Desktop/dev/week11-12/virtual-dom-diff-verifier.html#L360-L369))와 HTML5 파서 규칙이 이 예외와 충돌합니다.

1. **`<pre><code>...</code></pre>` 구조에서 들여쓰기 공백이 실제 텍스트 노드로 주입됨**:
   * `<pre><code>안녕</code></pre>`를 입력하고 Patch한 뒤, **미리보기 편집 → HTML 소스 편집**으로 탭만 왕복해 보세요.
   * `<pre>`의 직속 자식은 `<code>`(엘리먼트)뿐이므로 [`hasText(v.children)`](file:///c:/Users/user/Desktop/dev/week11-12/virtual-dom-diff-verifier.html#L367-L368)가 `false`가 되어 `<pre>\n  <code>안녕</code>\n</pre>` 형태로 줄바꿈+들여쓰기를 넣어 직렬화합니다.
   * 이후 `<pre>` 내부의 줄바꿈과 공백은 `isIgnorableText`가 무시하지 않으므로, **아무 수정을 하지 않고 탭만 바꿨는데도 `<pre>` 안에 공백 텍스트 노드가 새로 생겨 `수정됨 · Patch 대기` 상태가 됩니다.**
2. **`<pre>` 시작 직후의 첫 줄바꿈(`\n`) 소실**:
   * HTML5 파서 명세상 `<pre>`와 `<textarea>` 여는 태그 직후의 첫 번째 `\n`은 파싱 시 무조건 제거됩니다.
   * 따라서 `<pre>\n\n안녕</pre>`을 입력해 VDOM에 `"\n안녕"`을 저장하더라도, [`serializeNode`](file:///c:/Users/user/Desktop/dev/week11-12/virtual-dom-diff-verifier.html#L367)가 이를 `<pre>\n안녕</pre>`으로 직렬화하는 순간 파서가 앞의 `\n`을 먹어버려 `"\n"`이 사라집니다.

---

### 3. 인라인 요소 사이의 줄바꿈이 공백 대신 완전히 삭제됨
HTML에서는 `<span>A</span>\n<span>B</span>`처럼 인라인 태그 사이에 줄바꿈이 있으면 공백 1칸(`"A B"`)으로 렌더링됩니다.
* 하지만 [`isIgnorableText`](file:///c:/Users/user/Desktop/dev/week11-12/virtual-dom-diff-verifier.html#L214-L218)는 부모/형제 태그가 블록인지 인라인인지 구분하지 않고 **줄바꿈(`\n`)이 포함된 공백 텍스트 노드를 무조건 삭제**합니다.
* **재현 코드**:
  ```html
  <p>
    <span>조회수:</span>
    <b>10</b>
    <span>회</span>
  </p>
  ```
  위와 같이 작성하면 공백이 모두 증발하여 `조회수:10회`로 다닥다닥 붙어서 렌더링됩니다.
* 반대로 **한 줄로** `<ul> <li>A</li> <li>B</li> </ul>`처럼 블록 태그 사이에 `\n` 없이 공백(`" "`)만 넣으면, `!/\n/.test(node.nodeValue)` 조건 때문에 들여쓰기 공백으로 인식되지 않고 `<ul>`의 실제 텍스트 자식 노드로 VDOM에 남습니다.

---

### 4. 속성 이름 오타 시 `setProp` 예외 무시로 인한 영구 불일치
HTML5 파서(`innerHTML`)와 DOM API(`setAttribute`)의 속성 이름 허용 범위가 다릅니다.
* **원인**: HTML 소스 편집에서 실수로 `<div class="card",>`(쉼표 오타)나 `<button @click="fn">`처럼 입력하면, `t.innerHTML`은 `","`이나 `"@click"`을 정상 속성으로 파싱해 목표 VDOM(`next.props`)에 넣습니다.
* 하지만 Patch 시 [`setProp`](file:///c:/Users/user/Desktop/dev/week11-12/virtual-dom-diff-verifier.html#L261-L266)의 `el.setAttribute(name, value)`에서 `InvalidCharacterError`가 발생해 `catch`로 무시됩니다.
* **결과**: 실제 DOM에는 속성이 안 붙었는데 `states[cur].vdom`에는 해당 속성이 저장되어 **`❌ 실제 영역 ≠ 목표 VDOM (버그)`**가 발생하며, 이후 오타를 지우고 다시 Patch해도 실제 DOM에는 없던 속성을 지우는 패치가 실행됩니다.

---

### 5. `<template>`, `<noscript>`, `<xmp>` 등 특수 파싱 태그 처리 오류
[`SKIP_TAGS`](file:///c:/Users/user/Desktop/dev/week11-12/virtual-dom-diff-verifier.html#L203)에 포함되지 않은 HTML 특수 태그들에서 파싱/직렬화 불일치가 일어납니다.

* **`<template>`**: `<template><span>내용</span></template>`을 입력하면, DOM 명세상 자식 노드가 `node.childNodes`가 아니라 `node.content.childNodes`에 들어가므로 [`childrenToVdom`](file:///c:/Users/user/Desktop/dev/week11-12/virtual-dom-diff-verifier.html#L233-L242)이 내부 요소를 전부 잃어버리고 빈 `<template></template>`으로 만듭니다.
* **`<noscript>`, `<xmp>`, `<noembed>`, `<noframes>`**: 스크립트가 켜진 브라우저에서 `t.innerHTML`은 이 태그들의 내부를 일반 DOM이 아닌 **RAWTEXT(단일 텍스트 노드)** 로 파싱합니다. 이후 [`serializeNode`](file:///c:/Users/user/Desktop/dev/week11-12/virtual-dom-diff-verifier.html#L361)가 이 텍스트 안의 `<`, `>`, `&`를 `&lt;`, `&gt;`, `&amp;`로 이스케이프해 버리면, 다시 RAWTEXT로 파싱될 때 엔티티 디코딩이 되지 않아 모드를 전환할 때마다 `&amp;lt;`처럼 문자열이 깨집니다.

---

### 6. `<input>`, `<textarea>`, `<details>`의 DOM 상태(Property)와 Attribute 불일치
* [`setProp`](file:///c:/Users/user/Desktop/dev/week11-12/virtual-dom-diff-verifier.html#L261-L266)이 `setAttribute` / `removeAttribute`만 사용하기 때문에 발생하는 현상입니다.
* 예를 들어 `<input value="초기값">`이나 `<input type="checkbox" checked>`를 렌더링한 뒤, 사용자가 **실제 영역(Real)** 의 인풋에 타이핑하거나 체크박스를 한 번이라도 클릭하면 브라우저 내부의 *dirty flag*가 켜집니다. 그 이후에는 HTML 소스 편집에서 `value="새값"`으로 고쳐서 `PROPS` 패치(`setAttribute('value', '새값')`)가 정상 실행되어도 **화면의 인풋 값은 바뀌지 않습니다.**
* 마찬가지로 실제 영역에 `<details>` 태그를 두고 사용자가 클릭해서 열고 닫으면 실제 영역 DOM에 `open` 속성이 생겨나는데, VDOM History는 이를 모르기 때문에 다음 Patch 때 **`❌ 실제 영역 ≠ 목표 VDOM (버그)`**가 뜹니다.

---

### 7. (보안 필터 참고) `javascript:` 링크 우회 케이스
설계 의도상 `javascript:` 링크를 막기 위해 [`isSafeAttr`](file:///c:/Users/user/Desktop/dev/week11-12/virtual-dom-diff-verifier.html#L207-L211)에서 `/^\s*javascript:/i.test(value)`로 검사하고 있습니다.
* 하지만 HTML 엔티티로 스킴 중간에 탭/개행(`&#9;`, `&#10;`, `&#13;`)이나 선두 제어문자(`&#1;`~`&#31;`)를 넣은 경우(예: `<a href="java&#9;script:alert(1)">`), `t.innerHTML` 파싱 후 `value`가 `"java\tscript:alert(1)"`이 되어 정규식을 통과하지만 브라우저는 URL 파싱 시 탭/개행/제어문자를 제거하고 `javascript:`를 실행합니다.
* 이를 완벽히 막으려면 검사 전에 `value.replace(/[\u0000-\u001f\u007f]+/g, '')`로 제어문자 및 탭/줄바꿈을 제거한 뒤 정규식을 검사하는 것이 안전합니다.
