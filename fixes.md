# Virtual DOM · Diff 검증기 추가 Edge 케이스 분석 및 해결 방안

기존 1차 수정 사항(`vnode.ns` 네임스페이스 도입, `#real-root`의 `inert` 처리, `<pre>`·`<template>`·`<noscript>` 대응 등)이 반영된 최신 [`virtual-dom-diff-verifier.html`](./virtual-dom-diff-verifier.html)을 대상으로 10가지 복합 `<math>` 수식 및 특수 속성 테스트를 수행한 결과입니다.

---

## 1. XML 접두사(`mml:`, `svg:` 등)가 포함된 MathML / SVG 태그 불일치 및 오류

### 일어나는 버그 요약
* Word, MathType, LaTeX 변환기 등에서 복사한 수식에 흔히 포함되는 `<mml:mrow>`, `<m:mi>`나 `<svg:rect>`처럼 **태그 이름에 콜론(`:`) 접두사가 들어간 경우**, Patch 실행 직후 **`❌ 실제 영역 ≠ 목표 VDOM (버그)`** 배지가 발생합니다.
* 만약 `<math><m::row>x</m::row></math>`처럼 유효하지 않은 QName 형태의 태그가 들어오면 `createElementNS`에서 예외가 발생해 빨간색 **`오류`** 배지가 뜨며 Patch가 중단됩니다.

### 원인
1. `parseHtmlToVdom`의 `<template>.innerHTML`(HTML5 파서)은 `<mml:mrow>`를 파싱할 때 콜론을 네임스페이스 접두사로 분리하지 않고 `prefix: null`, **`localName: "mml:mrow"`**인 요소로 생성합니다. 따라서 목표 VDOM(`next`)에는 `type: "mml:mrow"`로 기록됩니다.
2. 반면 `createDom`의 `document.createElementNS(vnode.ns, "mml:mrow")`는 XML QName 규칙에 따라 콜론 앞뒤를 분리하여 `prefix: "mml"`, **`localName: "mrow"`**로 실제 DOM 요소를 생성합니다.
3. Patch 직후 검증 단계(`containerToVdom(realEl)`)에서 실제 영역의 `node.localName`을 읽으면 `"mrow"`가 반환되므로, 목표 VDOM의 `"mml:mrow"`와 일치하지 않아 검증이 실패합니다.

### 버그를 발생시키는 코드 조각
```html
<!-- 케이스 A: ❌ 실제 영역 ≠ 목표 VDOM (버그) 발생 -->
<math display="block" xmlns:mml="http://www.w3.org/1998/Math/MathML">
  <mml:mrow>
    <mml:mi>x</mml:mi>
    <mml:mo>=</mo>
    <mml:mfrac>
      <mml:mrow><mml:mo>−</mml:mo><mml:mi>b</mml:mi><mml:mo>±</mml:mo><mml:msqrt><mml:mrow><mml:msup><mml:mi>b</mml:mi><mml:mn>2</mml:mn></mml:msup><mml:mo>−</mml:mo><mml:mn>4</mml:mn><mml:mi>a</mml:mi><mml:mi>c</mml:mi></mml:mrow></mml:msqrt></mml:mrow>
      <mml:mrow><mml:mn>2</mn><mml:mi>a</mml:mi></mml:mrow>
    </mml:mfrac>
  </mml:mrow>
</math>

<!-- 케이스 B: createElementNS 예외(오류 배지) 발생 -->
<math><m::row>x</m::row></math>
```

### 해결 방안
* **방안 A (접두사 제거 정규화)**: SVG/MathML(`node.namespaceURI !== XHTML`) 요소에서 태그 이름에 콜론(`:`)이 들어 있으면, HTML5 파서 결과에서 접두사를 떼어내거나(`type.includes(':') ? type.split(':').pop() : type`), `createElement` / `createElementNS`가 허용하는 유효한 태그 이름인지 사전 검사(`tagNameOk`)하여 불일치를 방지합니다.
* **방안 B (유효하지 않은 태그 필터링)**: `attrNameOk`와 동일하게 `createElement` / `createElementNS` 가능 여부를 확인하는 헬퍼를 두어, 생성 불가능한 태그나 `localName`이 변형되는 태그를 VDOM 변환 단계(`domToVdom`)에서 제외(`report` 알림)합니다.

```js
const tagNameOk = (ns, name) => {
  try {
    const el = ns ? document.createElementNS(ns, name) : document.createElement(name);
    return el.localName === name; // createElementNS가 prefix를 분리해 localName이 달라지는 경우도 차단
  } catch (e) {
    return false;
  }
};
```

---

## 2. `xlink:*` 및 `xml:*` 속성의 이름 검증 불일치

### 일어나는 버그 요약
* `<math xlink:="1">`이나 `<svg xlink:a:b="1">`, `<div xml:a:b="1">`처럼 `xlink:` 또는 `xml:` 뒤에 빈 문자열이나 추가 콜론이 들어간 속성을 입력하고 Patch를 누르면 **`❌ 실제 영역 ≠ 목표 VDOM (버그)`** 배지가 발생합니다.

### 원인
1. `attrNameOk(name)` 함수는 일반 `probe.setAttribute(name, '')`만 호출하여 속성 이름의 유효성을 검사합니다. 일반 `setAttribute`는 XML `Name` 규칙만 따르므로 `xlink:`나 `xlink:a:b`처럼 콜론이 여러 개이거나 끝나는 이름도 예외 없이 통과시킵니다.
2. 하지만 실제 DOM에 속성을 반영하는 `setProp` 함수는 `name.startsWith('xlink:')` 또는 `name.startsWith('xml:')`일 때 **`el.setAttributeNS(...)`**를 호출합니다.
3. `setAttributeNS`는 엄격한 XML `QName`(`prefix:localPart` 형태이며 `localPart`가 비어 있거나 콜론을 포함하면 안 됨) 규칙을 요구하므로 `NamespaceError` 예외를 던지고, `setProp`의 `catch` 블록이 이를 무시하면서 실제 영역 DOM에만 속성이 누락됩니다.

### 버그를 발생시키는 코드 조각
```html
<!-- 케이스 A: 빈 로컬 이름 -->
<math xlink:="1"><mi>x</mi></math>

<!-- 케이스 B: 콜론 2개 이상 포함 -->
<svg xlink:a:b="1"></svg>
<div xml:a:b="1"></div>
```

### 해결 방안
* `attrNameOk`에서 `setProp`과 동일한 분기(`xlink:`, `xml:`)를 사용하여 `setAttributeNS`까지 통과하는지 함께 검증하도록 수정합니다.

```js
const attrNameOk = (() => {
  const probe = document.createElement('div'), cache = new Map();
  return (name) => {
    if (!cache.has(name)) {
      let ok = true;
      try {
        if (name.startsWith('xlink:')) probe.setAttributeNS(XLINK_NS, name, '');
        else if (name.startsWith('xml:')) probe.setAttributeNS(XML_NS, name, '');
        else probe.setAttribute(name, '');
        probe.removeAttribute(name);
      } catch (e) { ok = false; }
      cache.set(name, ok);
    }
    return cache.get(name);
  };
})();
```

---

## 3. MathML 텍스트 요소(`<mtext>` 등) 내부의 의미 있는 공백 소실

### 일어나는 버그 요약
* 수식 내부에 설명 텍스트나 공백을 넣기 위해 사용하는 `<mtext>` 태그 안에서 **인라인 HTML 태그 사이의 공백**(`<b>빛의 속도</b> <i>c</i>`)이나 **공백 단독 텍스트**(`<mtext> </mtext>`)를 넣으면, Patch 후 해당 공백이 삭제되어 글자들이 다닥다닥 붙어 렌더링됩니다.

### 원인
* `isInsignificantSpace`와 `canIndent` 함수에서 외부 네임스페이스(`namespaceURI !== XHTML`)일 때 공백을 보존할 예외 태그 목록으로 `SVG_TEXT = new Set(['text', 'tspan', 'textPath'])`만 지정되어 있습니다.
* 그로 인해 MathML의 텍스트 컨테이너인 `<mtext>`, `<mi>`, `<mn>`, `<mo>`, `<ms>`가 일반 도형 컨테이너(`<mrow>`, `<svg>` 등)와 똑같이 취급되어 내부의 공백 텍스트 노드가 ‘무의미한 들여쓰기 공백’으로 삭제됩니다.

### 버그를 발생시키는 코드 조각
```html
<!-- 케이스 A: </b>와 <i> 사이의 공백이 사라져 "빛의 속도c"로 붙어버림 -->
<math display="block">
  <mrow>
    <mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup>
    <mtext> (단, <b>빛의 속도</b> <i>c</i> = 3×10⁸ m/s) </mtext>
  </mrow>
</math>

<!-- 케이스 B: <mtext> </mtext> 안의 공백이 삭제되어 <mtext></mtext>이 됨 -->
<math display="block">
  <mrow>
    <mo>∀</mo><mi>x</mi><mo>∈</mo><mi>ℝ</mi><mo>,</mo>
    <mtext> </mtext>
    <msup><mi>x</mi><mn>2</mn></msup><mo>≥</mo><mn>0</mn>
  </mrow>
</math>
```

### 해결 방안
* 공백이 의미를 갖는 외부 네임스페이스 텍스트 요소 집합(`FOREIGN_TEXT`)에 MathML 텍스트 통합 지점 요소들(`mtext`, `mi`, `mn`, `mo`, `ms`)을 추가하거나, `<mtext>` 내부의 인라인 요소 사이 공백을 일반 HTML 인라인 공백과 동일하게 보존하도록 수정합니다.

```js
// SVG 및 MathML에서 텍스트 공백이 의미를 갖는 요소
const FOREIGN_TEXT = new Set(['text', 'tspan', 'textPath', 'mtext', 'mi', 'mn', 'mo', 'ms']);
```
이후 `isInsignificantSpace`와 `canIndent`에서 `SVG_TEXT` 대신 `FOREIGN_TEXT`를 참조하면 `<mtext>` 내부의 공백이 정상적으로 유지됩니다.
