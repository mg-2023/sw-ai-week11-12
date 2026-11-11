/* 엔진 내부 상태 패널(일반 DOM — 엔진으로 그리지 않음)과 오목 앱 시작 스크립트 */
(function (root) {
  'use strict';

  const { FunctionComponent } = root.MiniReact;
  const doc = root.document;
  const Omok = root.Omok;
  const info = root.ENGINE_INFO || { key: 'v1-batch', engines: { 'v1-batch': { label: 'v1 이벤트 경계 배칭' } } };
  const LOG_MAX = 14;

  const container = doc.getElementById('app');
  const panel = doc.getElementById('engine-panel');
  const toggle = doc.getElementById('panel-toggle');
  const detailEl = doc.getElementById('panel-detail');
  const totals = { commits: 0, dom: 0 };
  const log = [];

  const observer = new root.MutationObserver((list) => { totals.dom += list.length; });
  observer.observe(container, { subtree: true, childList: true, attributes: true, characterData: true });

  /* 패널 · 세부 패널 안 [data-cell=name] 칸에 글자를 쓰는 함수 */
  function setCell(name, value) {
    const el = doc.querySelector(`[data-cell="${name}"]`);
    if (el) el.textContent = value;
  }

  /* Hook 값을 패널에 보일 짧은 글자로 줄이는 함수 (큰 배열 · Set 은 크기만) */
  function brief(value) {
    if (Array.isArray(value)) return `Array(${value.length})`;
    if (value instanceof Set) return `Set(${value.size})`;
    if (value === undefined) return '—';
    const s = JSON.stringify(value);
    return s.length > 40 ? s.slice(0, 40) + '…' : s;
  }

  /* 패널을 펼치거나 접는 함수 */
  function setOpen(open) {
    panel.classList.toggle('open', open);
    doc.body.classList.toggle('panel-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    if (!open) setDetail(false);
  }

  /* 엔진 버전 고르기 칸을 채우고, 바꾸면 그 버전으로 다시 여는 함수 */
  function fillEngineSelect() {
    const select = panel.querySelector('#engine-select');
    for (const [key, e] of Object.entries(info.engines)) {
      const opt = doc.createElement('option');
      opt.value = key;
      opt.textContent = e.label;
      if (key === info.key) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      const url = new URL(root.location.href);
      url.searchParams.set('engine', select.value);
      root.location.href = url.toString();
    });
  }

  /* 커밋 보고 하나를 받아 누계 · 마지막 커밋 · 기록 · Hooks 를 패널에 그리는 함수 */
  function onCommit(report) {
    totals.dom += observer.takeRecords().length;
    totals.commits += 1;
    const p = report.patches;
    const patchSum = p.CREATE + p.REMOVE + p.REPLACE + p.TEXT + p.PROPS;
    setCell('commits', totals.commits);
    setCell('dom', totals.dom);
    setCell('kind', report.kind + (report.recovered ? ' (복구됨)' : ''));
    setCell('cause', Omok.cause);
    setCell('ms', report.ms.toFixed(2));
    setCell('compared', report.compared);
    setCell('patches', `CREATE ${p.CREATE} · REMOVE ${p.REMOVE} · REPLACE ${p.REPLACE} · TEXT ${p.TEXT} · PROPS ${p.PROPS}`);
    setCell('event-only', report.eventOnly);

    log.unshift({ no: totals.commits, cause: Omok.cause, patches: patchSum, ms: report.ms });
    if (log.length > LOG_MAX) log.pop();
    const ol = panel.querySelector('.log');
    ol.textContent = '';
    for (const entry of log) {
      const li = doc.createElement('li');
      li.textContent = `#${entry.no} ${entry.cause} · patch ${entry.patches} · ${entry.ms.toFixed(1)}ms`;
      ol.appendChild(li);
    }

    const hooks = panel.querySelector('.hooks');
    hooks.textContent = '';
    Omok.app.inspect().hooks.forEach((hook, i) => {
      const li = doc.createElement('li');
      li.textContent = `[${i}] ${hook.kind} : ${brief(hook.value)}`;
      hooks.appendChild(li);
    });

    if (report.kind === 'update') detail.commitNo = totals.commits;
    renderPatches();
  }

  // ───────── 세부 목록 : Phase 1 엔진(diff · VDOM · path)을 들여다보기 ─────────

  const M = root.MiniReact;
  const detail = { open: false, patches: [], commitNo: 0 };

  // 엔진의 diff 를 감싸 마지막 명령 목록을 붙잡는다 (엔진은 MiniReact.diff 를 부를 때마다 이 객체에서 꺼낸다)
  const originalDiff = M.diff;
  M.diff = function (oldV, newV, stats) {
    const patches = originalDiff.call(this, oldV, newV, stats);
    detail.patches = patches;
    return patches;
  };

  /* VDOM 노드 하나를 "태그.클래스" 나 "#text '글자'" 같은 짧은 글자로 줄이는 함수 */
  function describeVnode(v) {
    if (!v) return '없음';
    if (v.type === '#text') return `#text "${String(v.props.nodeValue).slice(0, 24)}"`;
    const cls = v.props && v.props.class ? '.' + String(v.props.class).trim().split(/\s+/).join('.') : '';
    return `<${v.type}${cls}>`;
  }

  /* 실제 DOM 노드 하나를 짧은 글자로 줄이는 함수 */
  function describeDom(node) {
    if (!node) return '없음';
    if (node.nodeType === 3) return `#text "${node.nodeValue.slice(0, 24)}"`;
    const cls = node.getAttribute('class') ? '.' + node.getAttribute('class').trim().split(/\s+/).join('.') : '';
    return `<${node.localName}${cls}>`;
  }

  /* path 를 따라 VDOM 을 내려가 그 노드를 돌려주는 함수 (없으면 null) */
  function vnodeAt(vdom, path) {
    let v = vdom;
    for (const i of path) {
      if (!v || !v.children || !v.children[i]) return null;
      v = v.children[i];
    }
    return v;
  }

  /* path 를 따라 실제 DOM 을 내려가 그 노드를 돌려주는 함수 (엔진의 findNode 사용, 없으면 null) */
  function domAt(path) {
    try { return M.findNode(container, path); } catch (err) { return null; }
  }

  /* 명령 하나의 내용을 짧은 글자로 줄이는 함수 */
  function patchDetail(p) {
    if (p.type === 'TEXT') return `"${String(p.value).slice(0, 30)}"`;
    if (p.type === 'CREATE' || p.type === 'REPLACE') return '새 ' + describeVnode(p.node);
    if (p.type === 'REMOVE') return '그 자리 노드 지움';
    const keys = Object.keys(p.set).map((k) => (typeof p.set[k] === 'function' ? k + '(함수)' : `${k}=${JSON.stringify(p.set[k])}`));
    return keys.concat(p.remove.map((k) => '−' + k)).join(' · ');
  }

  /* PROPS 명령이 클릭 함수 같은 이벤트 함수만 바꿨는지 확인하는 함수 */
  function eventOnly(p) {
    return p.type === 'PROPS' && p.remove.length === 0
      && Object.keys(p.set).every((k) => /^on/i.test(k) && typeof p.set[k] === 'function');
  }

  /* 마지막 diff 명령 목록을 그리는 함수 (세부 목록이 열려 있을 때만) */
  function renderPatches() {
    if (!detail.open) return;
    const hide = detailEl.querySelector('#hide-event-only').checked;
    const all = detail.patches;
    const shown = hide ? all.filter((p) => !eventOnly(p)) : all;
    setCell('patch-count', `커밋 #${detail.commitNo} · ${all.length}개 중 ${shown.length}개 표시`);
    const ol = detailEl.querySelector('.patch-list');
    ol.textContent = '';
    for (const p of shown) {
      const li = doc.createElement('li');
      li.className = 'patch-' + p.type.toLowerCase();
      const target = p.type === 'REMOVE' ? '(지워진 자리)' : describeDom(domAt(p.path));
      li.innerHTML = '';
      const type = doc.createElement('strong');
      type.textContent = p.type;
      const where = doc.createElement('code');
      where.textContent = `[${p.path.join(',')}]`;
      const what = doc.createElement('span');
      what.textContent = ` ${target} — ${patchDetail(p)}`;
      li.append(type, ' ', where, what);
      li.addEventListener('click', () => { detailEl.querySelector('#path-input').value = p.path.join(','); showPath(); });
      ol.appendChild(li);
    }
    if (shown.length === 0) {
      const li = doc.createElement('li');
      li.textContent = all.length === 0 ? '아직 diff 가 없다 (처음 그리기는 diff 없이 mount)' : '모두 클릭 함수 교체뿐';
      ol.appendChild(li);
    }
  }

  /* 입력한 path 의 VDOM 노드와 실제 DOM 노드를 나란히 보여 주는 함수 */
  function showPath() {
    const raw = detailEl.querySelector('#path-input').value.trim();
    const path = raw === '' ? [] : raw.split(/[\s,]+/).map(Number);
    if (path.some((n) => !Number.isInteger(n) || n < 0)) {
      setCell('path-show', '0 이상의 정수를 쉼표로 (예 0,1,0,1,112)');
      return;
    }
    const vdom = Omok.app.inspect().vdom;
    setCell('path-show', `[${path.join(',')}]`);
    setCell('path-vdom', describeVnode(vnodeAt(vdom, path)));
    setCell('path-dom', describeDom(domAt(path)));
  }

  /* VDOM 노드 하나를 펼칠 수 있는 줄로 만드는 함수 (자식은 펼칠 때 만든다 — 칸이 225개라서) */
  function treeNode(v, path) {
    const label = `[${path.join(',')}] ${describeVnode(v)}`;
    if (v.type === '#text' || v.children.length === 0) {
      const div = doc.createElement('div');
      div.className = 'tree-leaf';
      div.textContent = label;
      return div;
    }
    const d = doc.createElement('details');
    const s = doc.createElement('summary');
    s.textContent = `${label}  · 자식 ${v.children.length}`;
    d.appendChild(s);
    d.addEventListener('toggle', () => {
      if (!d.open || d.dataset.filled) return;
      d.dataset.filled = '1';
      v.children.forEach((c, i) => d.appendChild(treeNode(c, path.concat(i))));
    });
    return d;
  }

  /* 지금 VDOM(엔진이 보관한 this.vdom 의 복사본)으로 트리를 다시 그리는 함수 */
  function renderTree() {
    const box = detailEl.querySelector('.vdom-tree');
    box.textContent = '';
    const vdom = Omok.app.inspect().vdom;
    if (!vdom) return;
    setCell('vdom-base', `커밋 #${totals.commits} 기준 · path 는 컨테이너(#app)부터`);
    const top = treeNode(vdom, []);
    top.open = true;
    box.appendChild(top);
  }

  /* 세부 목록을 펼치거나 접는 함수 (엔진 패널 오른쪽에 패널이 하나 더 나온다) */
  function setDetail(open) {
    detail.open = open;
    detailEl.classList.toggle('open', open);
    doc.body.classList.toggle('panel-detail', open);
    const btn = panel.querySelector('.detail-toggle');
    btn.setAttribute('aria-expanded', String(open));
    btn.textContent = open ? '세부 목록 ◂' : '세부 목록 ▸';
    if (open) { renderPatches(); renderTree(); }
  }

  fillEngineSelect();
  setCell('engine', info.engines[info.key].label);
  panel.querySelector('.detail-toggle').addEventListener('click', () => setDetail(!detail.open));
  detailEl.querySelector('#hide-event-only').addEventListener('change', renderPatches);
  detailEl.querySelector('#path-go').addEventListener('click', showPath);
  detailEl.querySelector('#path-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') showPath(); });
  detailEl.querySelector('#vdom-refresh').addEventListener('click', renderTree);
  detailEl.querySelector('.detail-close').addEventListener('click', () => setDetail(false));
  setCell('batch', typeof root.MiniReact.flushSync === 'function' ? '마이크로태스크 — 어디서 부르든 한 번'
    : typeof root.MiniReact.batch === 'function' ? '있음 — 엔진 이벤트 경계' : '없음 — setter 마다 갱신');
  toggle.addEventListener('click', () => setOpen(!panel.classList.contains('open')));
  panel.querySelector('.panel-close').addEventListener('click', () => setOpen(false));

  Omok.app = new FunctionComponent(Omok.App, {}, container);
  Omok.app.onCommit(onCommit);
  Omok.app.mount();
})(globalThis);
