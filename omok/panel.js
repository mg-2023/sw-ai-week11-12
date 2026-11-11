/* 엔진 내부 상태 패널(일반 DOM — 엔진으로 그리지 않음)과 오목 앱 시작 스크립트 */
(function (root) {
  'use strict';

  const { FunctionComponent } = root.MiniReact;
  const doc = root.document;
  const Omok = root.Omok;
  const info = root.ENGINE_INFO || { key: 'src', engines: { src: { label: '현재 작업본 (src)' } } };
  const LOG_MAX = 14;

  const container = doc.getElementById('app');
  const panel = doc.getElementById('engine-panel');
  const toggle = doc.getElementById('panel-toggle');
  const totals = { commits: 0, dom: 0 };
  const log = [];

  const observer = new root.MutationObserver((list) => { totals.dom += list.length; });
  observer.observe(container, { subtree: true, childList: true, attributes: true, characterData: true });

  /* 패널 안 [data-cell=name] 칸에 글자를 쓰는 함수 */
  function setCell(name, value) {
    const el = panel.querySelector(`[data-cell="${name}"]`);
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
  }

  fillEngineSelect();
  setCell('engine', info.engines[info.key].label);
  setCell('batch', typeof root.MiniReact.flushSync === 'function' ? '마이크로태스크 — 어디서 부르든 한 번'
    : typeof root.MiniReact.batch === 'function' ? '있음 — 엔진 이벤트 경계' : '없음 — setter 마다 갱신');
  toggle.addEventListener('click', () => setOpen(!panel.classList.contains('open')));
  panel.querySelector('.panel-close').addEventListener('click', () => setOpen(false));

  Omok.app = new FunctionComponent(Omok.App, {}, container);
  Omok.app.onCommit(onCommit);
  Omok.app.mount();
})(globalThis);
