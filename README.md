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

## 미니 리액트 Phase 1 (feat-Jongeume)

> Virtual DOM 은 순수한 데이터, 실제 DOM 은 번호로 찾는다.

| 하고 싶은 것 | 방법 |
| --- | --- |
| 검증 페이지 열기 | `index.html` 더블클릭 (서버 필요 없음) |
| 단위 테스트 | `npm install` 한 번 → `npm test` |
| 설계 · 결정 · 엣지 케이스 | [docs/phase1-design.md](docs/phase1-design.md) |
| Codex 교차 검증 기록 | [docs/codex-review-log.md](docs/codex-review-log.md) |

| 파일 | 역할 |
| --- | --- |
| `src/vdom.js` | DOM ↔ Virtual DOM 변환, `render`, `setProp`, `toHtml` |
| `src/diff.js` | 두 Virtual DOM → patch 목록 |
| `src/patch.js` | patch 목록 → 실제 DOM (바뀐 곳만), `mount` |
| `src/history.js` | State History (뒤로 · 앞으로) |
| `app.js` · `index.html` · `style.css` | 검증 페이지 |
