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

# React 1 + 2 Flow
## 1. 주요 기능 (5줄 요약)
- **HTML 편집 → Patch**: 테스트 영역의 HTML로 새 VDOM을 만들고 이전 VDOM과 Diff해서, 달라진 부분만 실제 영역에 반영한 뒤 결과가 목표 VDOM과 같은지 검증
- **컴포넌트 모드**: `h()`로 작성한 함수 컴포넌트(`App`)를 실제 영역에 마운트하면, 카드 맨 아래에 `조회수 +1` 버튼이 생김
- **useState 훅**: 훅 배열 + 커서로 state를 관리하고, setter가 호출되면 즉시 리렌더 → Diff → Patch가 일어남
- **이벤트 위임**: `#real-root`에 click 리스너 하나만 두고, 클릭된 노드의 경로로 최신 VDOM에서 핸들러를 찾아 실행 (핸들러를 DOM에 붙이지 않음)
- **State History**: Patch / 렌더 기록을 저장하고, HTML 편집 모드에서는 뒤로 / 앞으로 / 항목 클릭으로 이동 가능, 컴포넌트 모드에서는 보기 전용

## 2. 각 모듈별 기능 (표)
| 모듈 | 구분 | 주요 함수 | 역할 |
|---|---|---|---|
| `src/vdom.js` | 기존 | `domToVdom`, `containerToVdom`<br>`parseHtmlToVdom`, `serializeRoot`<br>`vdomEqual` | 실제 DOM / HTML 문자열 ↔ VDOM 변환<br>두 VDOM 비교 |
| `src/diff.js` | 기존 | `diff`, `diffProps` | 두 VDOM을 같은 위치끼리 비교해 패치 목록<br>(`CREATE` / `REMOVE` / `REPLACE` / `TEXT` / `PROPS`) 생성 |
| `src/patch.js` | 기존 | `applyPatches`, `patchFromHtml`<br>`patchToVdom`, `normalizeDom` | 패치를 실제 DOM에 적용하고<br>결과 DOM이 목표 VDOM과 같은지 검증 |
| `src/history.js` | 수정 | `createHistory`<br>→ `push(vdom, patches, label)`, `goTo` | State History 저장 / 이동<br>(`label` 인자 추가, 없으면 `Patch N`) |
| `src/compo.js` | 추가 | `h`, `expand` | VNode 생성(`on*` 함수는 `events`로 분리)<br>함수 컴포넌트를 일반 VNode 트리로 펼침 |
| `src/hooks.js` | 추가 | `useState`, `beginRender`<br>`resetHooks`, `onStateChange` | 훅 배열 + 커서로 state 관리, setter 호출 시 리렌더 요청 |
| `src/events.js` | 추가 | `pathOf`, `delegate` | DOM 노드 → 인덱스 경로 계산<br>경로로 VDOM에서 핸들러를 찾는 위임 리스너 등록 / 해제 |
| `src/root.js` | 추가 | `createRoot` → `mount`, `unmount` | 리렌더 → `patchToVdom` → `onCommit` 흐름 담당 |
| `demo/App.js` | 추가 | `App`, `ViewCount`, `PlusButton` | 조회수 +1 예제 컴포넌트 |
| `app.js` | 수정 | `doPatch`, `goTo`, `toggleMode`<br>`onCommit` | 화면 갱신, 모드 토글, 깜빡임 / 로그 / History 표시 |

## 3. 조회수 +1 버튼을 눌렀을 때의 흐름
```
클릭 → 경로 [0, 4] → events.click 실행 → setViews(10 → 11) → App() 재실행 → Diff → TEXT [0, 1, 1, 0] "11" → DOM 1건 변경
```
1. **클릭 감지**: `#real-root`에 하나만 등록된 click 리스너가 이벤트를 받는다
2. **경로 계산**: 클릭된 DOM 노드에서 `#real-root`까지 올라가며 `childNodes` 인덱스를 모은다. 버튼이면 `[0, 4]`
3. **핸들러 찾기**: 최신 VDOM을 그 경로대로 내려가 해당 VNode의 `events.click`을 찾는다. 없으면 부모 쪽으로 올라가며 찾는다
4. **핸들러 실행**: `() => setViews(v => v + 1)`이 실행된다
5. **state 변경**: 훅 배열의 값이 10에서 11로 바뀐다. 값이 같으면(`Object.is`) 여기서 끝난다
6. **리렌더**: 훅 커서를 0으로 되돌리고 `App()`을 다시 실행한다. 자식 컴포넌트까지 펼쳐 `#root`로 감싼 새 VDOM을 만든다
7. **Diff**: `patchToVdom(실제 영역, 이전 VDOM, 새 VDOM)`을 호출하면 `TEXT [0, 1, 1, 0] "11"` 패치 하나가 나온다
8. **Patch와 검증**: `<b>` 안 텍스트 노드의 값만 바꾸고, 결과 DOM이 새 VDOM과 같은지 확인한다
9. **커밋**: 새 VDOM을 "이전 VDOM"으로 저장하고 `onCommit`으로 `app.js`에 넘긴다. `app.js`는 숫자 부분을 깜빡이고, State History에 `렌더 N`을 저장하고, 로그를 출력한다

핸들러는 DOM이 아니라 VDOM에 있으므로, 렌더마다 함수가 새로 만들어져도 패치가 생기지 않는다

## 4. 기능 테스트 결과
팀 통합 테스트 케이스 55개 중 55개 전부 통과

## 5. 실행 시 주의사항
반드시 **이 디렉토리 안에서** 파이썬으로 로컬 서버를 열어야 동작합니다!
```python
python -m http.server 8000
```
그리고 다음 링크로 들어가서 시연을 해주세요
```
http://localhost:8000/virtual-dom-diff-verifier.html
```

---
