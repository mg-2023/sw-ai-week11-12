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

# Phase 1 Flow
## 첫 실행 시
```html
<div class="card" id="profile">
    <h2 class="title">Virtual DOM 연습</h2>
    <p class="desc">조회수: <b>10</b> 회</p>
    <ul class="list">
	    <li>React</li>
	    <li class="done">Virtual DOM</li>
	    <li>Diff 알고리즘</li>
    </ul>
    <button class="btn" disabled>저장</button>
</div>
```

이 html 코드가 맨 처음 불러와지면서 첫 히스토리를 만든다
왼쪽의 실제 영역에는 이 html 코드가 실제로 렌더링되고, 오른쪽 테스트 영역에는 위 코드가 그대로 들어가서 사용자가 편집할 수 있게 되어있다
## 테스트 영역을 고치면
단순히 테스트 영역을 편집한다고 해서 왼쪽이 새로 렌더링되는 것이 아니다
대신 위에 제공된 **Patch** 버튼을 눌러서 실제 영역을 갱신해야 한다
### Patch를 누른 직후
들어가기 앞서, DOM이란 **D**ocument **O**bject **M**odel으로 html 요소를 객체로 표현한 것을 의미하고, 자바스크립트 내에서 이걸 JSON 형식으로 만들어 놓은 걸 Virtual DOM, VDOM이라고 한다

Patch 버튼을 누르면 원본 코드와 새로 입력한 코드를 기준으로 **Virtual DOM**이라는 걸 만든다
두 VDOM을 비교해서 다른 점만 찾는데, 이번에 사용한 코딩 에이전트는 다른 점을 어떤 기준에 의해서 찾는 게 아니라 **단순 위치를 비교해서 다른 점을 찾았다**. 그리고는 달라진 점을 인덱스 번호로 표시해줬다
### 달라진 HTML의 반영
처음 나왔던 html 코드를 이렇게 바꿨다고 해보자
```html
<div class="card" id="profile">
    <h1 class="title">Virtual DOM 연습</h1>
    <p class="desc">조회수: <b>11</b></p>
    <ul class="list">
	    <li>React</li>
	    <li>Virtual DOM</li>
	    <li>Diff 알고리즘</li>
	    <li>Phase 2 구현 예정</li>
    </ul>
    <button class="btn" disabled>저장</button>
</div>
```

두 VDOM을 루트부터 타고 내려가면서 원본과 달라진 점을 찾는데, 5가지 핵심 케이스를 중심으로 차이점을 찾게 된다
#### 1. CREATE
"Phase 2 구현 예정"이라는 li 태그를 가지는 노드가 추가되었다.
VDOM 트리 입장에서는 `[0, 2, 3]`번 인덱스가 추가된 것이므로 `CREATE [0, 2, 3]`을 로그에 찍는다, 그리고 상세 로그에 `<li>...</li>`를 추가한다
#### 2. DELETE
"회"라는 텍스트가 삭제되었고, `DELETE [0, 1, 2]`를 로그에 찍는다
#### 3. REPLACE
루트 바로 아래의 h2 태그가 h1 태그로 대체되어서, `REPLACE [0, 0]`을 로그에 찍는다
상세 로그에는 `<h1>...</h1>`이 추가된다
#### 4. PROPS
Virtual DOM이 들어있는 li 태그의 class 속성이 없어졌다
`PROPS [0, 2, 1]`을 로그에 찍고, 상세 로그에 class 속성이 done에서 (없음)이 찍힌다
#### 5. TEXT
b 태그 안의 텍스트 10이 11로 바뀌었다
`TEXT [0, 1, 1]`을 로그에 찍고, 상세 로그에 10에서 11로 바뀌었다고 추가한다
