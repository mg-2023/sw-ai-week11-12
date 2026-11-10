# 함수 단위 구현 순서

🔴 중요한 로직 / 🟠 버그가 잘 나는 곳

**전체 흐름**

틀 확인 -> Phase 1 -> Phase 2 -> 화면 -> 테스트 -> 브라우저 확인 -> 문서 -> 템플릿 정리

## Phase 1

- **types.ts**
  - ==🔴VNode== -> ==🔴Patch== -> `textNode` -> `elementNode`
- **dom-to-vdom.ts**
  - ==🟠isAllowedAttribute== -> `elementToVdom` -> `domToVdom` -> ==🟠childrenToVdom== -> `htmlToVdom`
- **vdom-to-html.ts**
  - `escapeText` -> `escapeAttribute` -> `serializeProps` -> ==🟠canBreakLines== -> `serializeElement` -> `serialize` -> ==🔴vdomToHtml==
- **diff.ts**
  - `diff` -> ==🔴diffNode== -> `diffProps` -> `keyOf` -> `identityOf`
  - ==🟠matchChildren== -> ==🔴longestIncreasingSubsequence==
  - ==🔴diffChildren==
    - 짝끼리 내부 비교 -> ==🟠뒤에서부터 REMOVE== -> ==🟠MOVE 도착 번호 계산== -> INSERT
- **patch.ts**
  - `dispatchToHandler` -> `eventTypeOf` -> ==🟠setListener== -> `removeListener`
  - ==🟠syncValue== -> ==🟠syncLiveProperty== -> `removeProp` -> `setProp`
  - `namespaceOf` -> ==🟠childNamespaceOf== -> ==🔴createDom==
  - ==🟠resolve== -> `childAt` -> ==🔴applyPatches==
- **history.ts**
  - `constructor` -> `current` -> `position` -> `size` -> `canBack` -> `canForward` -> ==🟠push== -> `back` -> `forward` -> `go`

## Phase 2

- **function-component.ts**
  - `getHookOwner` -> `renderStateless` -> `constructor`
  - ==🔴mount== -> ==🔴update== -> `unmount`
  - ==🟠claimSlot== -> `queueEffect`
  - ==🔴scheduleUpdate== -> ==🟠flushScheduledUpdate==
  - ==🟠isUpdateLoop== -> ==🔴render==
  - ==🟠flushEffects==
- **h.ts**
  - `toKebabCase` -> `toCssText` -> `normalizeProps` -> `normalizeChildren` -> ==🟠withKey== -> ==🔴h==
- **deps.ts**
  - ==🟠depsChanged==
- **use-state.ts**
  - ==🔴useState== -> ==🟠setValue==
- **use-effect.ts**
  - ==🔴useEffect== -> `dispose`
  - ==🟠cleanup== -> ==🟠run==
- **use-memo.ts**
  - ==🔴useMemo==

## 화면

- **inspector.ts**
  - ==🔴createMutationCounter== -> `take` -> `recordTouch`
  - `shorten` -> `describeNode` -> `describePatch` -> `formatPath` -> `domPatches` -> `renderPatchList`
  - `createCell` -> `renderNodeMap`
- **controls.ts**
  - `createLabControls` -> ==🔴patch== -> ==🟠navigate==
- **lab-page.ts**
  - `edit` -> `rootNode` -> `childrenOf` -> `required` -> `renderLayout`
  - `createTestArea` -> `read` -> `write` -> `renderMode` -> ==🟠setMode==
  - ==🔴createLabPage== -> `onScenario` -> `onCodeKeyDown` -> `renderTimeline` -> `messageFor` -> `renderReport`
    - 샘플을 트리로 읽기 -> ==🟠DOM을 트리대로 다시 만들기== -> 테스트 영역 그리기 -> 컨트롤 만들기
- **test-page.ts**
  - ==🟠isTask== -> `loadTasks` -> `saveTasks` -> `selectTasks` -> `summarize` -> `formatTime`
  - `Progress` -> `FocusTimer` -> `Composer` -> `onSubmit` -> `Toolbar` -> ==🟠TaskRow== -> `TaskList`
  - ==🔴FocusBoard==
    - 상태 선언 -> useMemo 목록 계산 -> 저장 effect -> 제목 effect -> ==🟠타이머 정리 함수== -> ==🟠시간 종료 처리==
    - `resetTimer` -> `addTask` -> `changeTask` -> ==🟠removeTasks==
    - `onMinutes` -> ==🔴onResetView== -> `onPickFocus`
  - `renderPageLayout` -> `createTestPage` -> ==🟠report==
- **app.ts**
  - `pageFromHash` -> `startApp` -> `showCurrentPage`
- **진입점과 스타일**
  - `main.ts` -> `index.html` -> `main.css`

## 검증과 마무리

- **검증**
  - 단위·기능 테스트 -> ==🟠무작위 트리 대조== -> ==🟠돌연변이 검사== -> 실제 브라우저 확인 -> 발견한 문제 수정
- **마무리**
  - `learn-guide.md` -> `README.md` -> 안 쓰는 템플릿 파일 삭제
