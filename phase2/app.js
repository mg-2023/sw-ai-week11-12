/* Phase 2 측정 페이지: 데모 앱(엔진으로 그림) · 측정 패널(일반 DOM) · 시나리오 · 기록 표를 잇는 스크립트 */
(function (root) {
  'use strict';

  const { h, FunctionComponent, useState, useMemo, useEffect } = root.MiniReact;
  const doc = root.document;

  const VERSION_DEFAULT = 'v0 기본';
  const HEADER = '| 버전 | 시나리오 | 렌더 | 시간(ms) | 비교 | patch | DOM 변경 |';

  let nextId = 1;

  /* 새 할 일 하나를 만드는 함수 (id 는 데모 로직용 고정 번호) */
  function makeTodo(text) {
    return { id: nextId++, text, done: false };
  }

  /* 기록 목록을 마크다운 표 글자로 바꾸는 함수 */
  function recordsToMarkdown(records) {
    const lines = [HEADER, '|---|---|---:|---:|---:|---:|---:|'];
    for (const r of records) {
      lines.push(`| ${r.version} | ${r.scenario} | ${r.renders} | ${r.ms.toFixed(2)} | ${r.compared} | ${r.patches} | ${r.domMutations} |`);
    }
    return lines.join('\n');
  }

  /* 입력칸과 추가 버튼을 그리는 자식 (props 만 받는다) */
  function TodoInput({ text, onText, onAdd }) {
    return h('form', { onSubmit: (e) => { e.preventDefault(); onAdd(); } },
      h('input', { type: 'text', value: text, placeholder: '할 일을 입력', onInput: (e) => onText(e.target.value) }),
      h('button', { type: 'submit' }, '추가'));
  }

  /* 할 일 한 줄(체크 · 글자 · 삭제)을 그리는 자식 */
  function TodoItem({ todo, onToggle, onRemove }) {
    return h('li', { class: todo.done ? 'done' : null },
      h('input', { type: 'checkbox', checked: todo.done, onChange: onToggle }),
      h('span', null, todo.text),
      h('button', { type: 'button', onClick: onRemove }, '삭제'));
  }

  /* 할 일 목록을 그리는 자식 (key 없이 위치로 비교하는 v0 기준선) */
  function TodoList({ todos, onToggle, onRemove }) {
    return h('ul', null, todos.map((todo) => h(TodoItem, {
      todo,
      onToggle: () => onToggle(todo.id),
      onRemove: () => onRemove(todo.id),
    })));
  }

  /* 남은 일 숫자를 보여 주는 자식 */
  function Summary({ remaining, total }) {
    return h('p', null, '남은 일 ', h('b', { class: 'remaining' }, remaining), ' / 전체 ', total);
  }

  /* 상태를 모두 가진 루트 (목록 · 입력값 · 남은 개수 · 문서 제목 · 시나리오 액션 등록) */
  function App() {
    const [todos, setTodos] = useState(() => [makeTodo('Virtual DOM 이해하기'), makeTodo('Diff 구현하기')]);
    const [text, setText] = useState('');
    const remaining = useMemo(() => todos.filter((t) => !t.done).length, [todos]);

    useEffect(() => { doc.title = `남은 일 ${remaining} — 미니 리액트 Phase 2`; }, [remaining]);
    useEffect(() => {
      Object.assign(root.Phase2.actions, {
        add100: () => setTodos((list) => list.concat(Array.from({ length: 100 }, (_, i) => makeTodo(`항목 ${i + 1}`)))),
        reverse: () => setTodos((list) => list.slice().reverse()),
        prepend: () => setTodos((list) => [makeTodo('맨 앞 항목')].concat(list)),
        editOne: () => setTodos((list) => list.map((t, i) => (i === Math.floor(list.length / 2) ? { ...t, text: t.text + '!' } : t))),
        addClick: () => doc.querySelector('#demo button[type="submit"]').click(),
        set10: () => { for (let i = 0; i < 10; i++) setTodos((list) => list.map((t, j) => (j === 0 ? { ...t, done: !t.done } : t))); },
      });
    }, []);

    /* 입력값을 다듬어 비어 있지 않으면 목록 끝에 더하고 입력칸을 비우는 함수 */
    const add = () => {
      const value = text.trim();
      if (!value) return;
      setTodos((list) => list.concat(makeTodo(value)));
      setText('');
    };
    /* id 가 같은 할 일의 완료 표시를 뒤집는 함수 */
    const toggle = (id) => setTodos((list) => list.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
    /* id 가 같은 할 일을 목록에서 빼는 함수 */
    const remove = (id) => setTodos((list) => list.filter((t) => t.id !== id));

    return h('div', null,
      h(TodoInput, { text, onText: setText, onAdd: add }),
      h(TodoList, { todos, onToggle: toggle, onRemove: remove }),
      h(Summary, { remaining, total: todos.length }));
  }

  const records = [];
  const totals = { renders: 0, ms: 0, compared: 0, patches: 0, domMutations: 0 };
  const Phase2 = { app: null, actions: {}, prepares: {}, records, recordsToMarkdown, runScenario };
  /* addClick 준비 : 입력칸에 글자를 넣고 input 이벤트를 보내는 함수 */
  Phase2.prepares.addClick = () => {
    const input = doc.querySelector('#demo input[type="text"]');
    input.value = '측정 항목';
    input.dispatchEvent(new root.Event('input', { bubbles: true }));
  };
  root.Phase2 = Phase2;

  const demo = doc.getElementById('demo');
  const panel = doc.getElementById('panel');
  const observer = new root.MutationObserver((list) => { totals.domMutations += list.length; });
  observer.observe(demo, { subtree: true, childList: true, attributes: true, characterData: true });

  /* 패널의 칸 하나에 글자를 쓰는 함수 */
  function setCell(name, value) {
    panel.querySelector('.' + name).textContent = value;
  }

  /* 커밋 보고와 hooks 를 측정 패널에 보여 주고 누계에 더하는 함수 */
  function onCommit(report) {
    totals.domMutations += observer.takeRecords().length;
    if (report.kind === 'update') {
      totals.renders += 1;
      totals.ms += report.ms;
      totals.compared += report.compared;
      totals.patches += Object.values(report.patches).reduce((a, b) => a + b, 0);
    }
    const p = report.patches;
    setCell('kind', report.kind + (report.recovered ? ' (복구됨)' : ''));
    setCell('ms', report.ms.toFixed(2));
    setCell('compared', report.compared);
    setCell('patches', `CREATE ${p.CREATE} · REMOVE ${p.REMOVE} · REPLACE ${p.REPLACE} · TEXT ${p.TEXT} · PROPS ${p.PROPS}`);
    setCell('event-only', report.eventOnly);
    setCell('hook-count', report.hookCount);
    setCell('dom-total', totals.domMutations);
    const list = panel.querySelector('.hooks');
    list.textContent = '';
    for (const hook of Phase2.app.inspect().hooks) {
      const li = doc.createElement('li');
      li.textContent = `${hook.kind}: ${JSON.stringify(hook.value)}`;
      list.appendChild(li);
    }
  }

  /* 기록 표를 records 대로 다시 그리는 함수 */
  function renderRecords() {
    const body = doc.querySelector('#records tbody');
    body.textContent = '';
    for (const r of records) {
      const tr = doc.createElement('tr');
      for (const v of [r.version, r.scenario, r.renders, r.ms.toFixed(2), r.compared, r.patches, r.domMutations]) {
        const td = doc.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
  }

  /* 시나리오 액션을 한 번 돌려 숫자 차이를 기록 한 줄로 남기는 함수 */
  function runScenario(id) {
    const action = Phase2.actions[id];
    if (!action) throw new Error('모르는 시나리오: ' + id);
    const prepare = Phase2.prepares[id];
    if (prepare) prepare();
    totals.domMutations += observer.takeRecords().length;
    const before = { ...totals };
    action();
    totals.domMutations += observer.takeRecords().length;
    records.push({
      version: doc.getElementById('version').value || VERSION_DEFAULT,
      scenario: id,
      renders: totals.renders - before.renders,
      ms: totals.ms - before.ms,
      compared: totals.compared - before.compared,
      patches: totals.patches - before.patches,
      domMutations: totals.domMutations - before.domMutations,
    });
    renderRecords();
    setCell('dom-total', totals.domMutations);
  }

  /* 마크다운 표를 클립보드에 복사하는 함수 (클립보드가 없으면 조용히 넘어감) */
  function copyMarkdown() {
    const md = recordsToMarkdown(records);
    if (root.navigator && root.navigator.clipboard) root.navigator.clipboard.writeText(md).catch(() => {});
  }

  for (const btn of doc.querySelectorAll('[data-scenario]')) btn.addEventListener('click', () => runScenario(btn.dataset.scenario));
  doc.getElementById('copy-md').addEventListener('click', copyMarkdown);

  Phase2.app = new FunctionComponent(App, {}, demo);
  Phase2.app.onCommit(onCommit);
  Phase2.app.mount();
})(globalThis);
