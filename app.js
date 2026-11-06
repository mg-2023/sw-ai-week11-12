/* 검증 페이지: 실제 영역 · 테스트 영역 · Patch · 뒤로가기 · 앞으로가기를 묶는 스크립트 */
(function () {
  'use strict';

  const M = window.MiniReact;
  const actualEl = document.getElementById('actual');
  const testEl = document.getElementById('test');
  const btnPatch = document.getElementById('btn-patch');
  const btnBack = document.getElementById('btn-back');
  const btnForward = document.getElementById('btn-forward');
  const posEl = document.getElementById('history-pos');
  const statusEl = document.getElementById('status');
  const logEl = document.getElementById('patch-log');
  const logSummaryEl = document.getElementById('log-summary');

  const observer = new MutationObserver(() => {});
  observer.observe(actualEl, { subtree: true, childList: true, attributes: true, characterData: true });

  let shown = M.domToVdom(actualEl);
  M.mount(actualEl, shown);
  observer.takeRecords();
  const history = M.createHistory(shown);
  showInTestArea(shown);
  refreshButtons();
  setStatus('준비됨: 실제 영역을 Virtual DOM 으로 읽어 테스트 영역에 그렸습니다');

  btnPatch.addEventListener('click', onPatch);
  testEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onPatch();
    }
  });

  /* 테스트 영역을 읽어 Diff 하고 바뀐 곳만 실제 영역에 반영한 뒤 기록에 저장하는 함수 */
  function onPatch() {
    const next = M.htmlToVdom(testEl.value, shown);
    const patches = M.diff(shown, next);
    if (patches.length === 0) {
      M.syncFormState(actualEl, shown);
      setStatus('바뀐 곳이 없습니다 (기록에 넣지 않음)');
      showLog([], 0);
      showInTestArea(next);
      return;
    }
    const mutations = apply(patches, next);
    if (mutations === null) return;
    shown = history.push(next);
    showInTestArea(shown);
    refreshButtons();
    setStatus(`Patch ${patches.length}건 반영, 기록 ${history.index + 1} 번째에 저장`);
    showLog(patches, mutations);
  }

  btnBack.addEventListener('click', () => travel(history.back(), '뒤로'));
  btnForward.addEventListener('click', () => travel(history.forward(), '앞으로'));

  /* 기록의 Virtual DOM 으로 실제 영역 · 테스트 영역을 함께 바꾸는 함수 */
  function travel(target, label) {
    if (!target) return;
    const patches = M.diff(shown, target);
    const mutations = apply(patches, target);
    if (mutations === null) {
      M.mount(actualEl, target);
      observer.takeRecords();
    }
    shown = target;
    showInTestArea(shown);
    refreshButtons();
    setStatus(`${label}: 기록 ${history.index + 1} 번째로 이동 (Patch ${patches.length}건)`);
    showLog(patches, mutations);
  }

  /* patch 를 실제 영역에 적용하고 DOM 변경 수를 돌려주며, 실패하면 되돌리고 null 을 돌려주는 함수 */
  function apply(patches, target) {
    observer.takeRecords();
    try {
      M.applyPatches(actualEl, patches);
    } catch (err) {
      M.mount(actualEl, shown);
      M.syncFormState(actualEl, shown);
      observer.takeRecords();
      setStatus(`적용 실패, 되돌렸습니다: ${err.message}`);
      showLog([], 0);
      return null;
    }
    const count = observer.takeRecords().length;
    if (target) M.syncFormState(actualEl, target);
    flash(patches);
    return count;
  }

  /* 바뀐 노드를 잠깐 노랗게 깜빡이는 함수 */
  function flash(patches) {
    for (const p of patches) {
      let node;
      try {
        node = M.findNode(actualEl, p.type === 'REMOVE' ? p.path.slice(0, -1) : p.path);
      } catch (e) {
        continue;
      }
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (el && el.animate) {
        el.animate(
          [{ backgroundColor: 'rgba(255, 210, 0, 0.55)', outline: '2px solid #f5a300' }, { backgroundColor: 'transparent', outline: '2px solid transparent' }],
          { duration: 1200, easing: 'ease-out' },
        );
      }
    }
  }

  /* Virtual DOM 을 HTML 로 바꿔 테스트 영역에 쓰는 함수 */
  function showInTestArea(vnode) {
    testEl.value = M.toHtml(vnode.children);
  }

  /* 뒤로 · 앞으로 버튼 상태와 기록 위치를 갱신하는 함수 */
  function refreshButtons() {
    btnBack.disabled = !history.canBack();
    btnForward.disabled = !history.canForward();
    posEl.textContent = `기록 ${history.index + 1} / ${history.length}`;
  }

  /* 상태 문구를 바꾸는 함수 */
  function setStatus(msg) {
    statusEl.textContent = msg;
  }

  /* 마지막 patch 목록과 DOM 변경 수를 화면에 보여 주는 함수 */
  function showLog(patches, mutations) {
    logSummaryEl.textContent = `patch ${patches.length}건 · 실제 DOM 변경 ${mutations}건`;
    logEl.textContent = '';
    for (const p of patches) {
      const li = document.createElement('li');
      li.textContent = describe(p);
      li.className = `p-${p.type.toLowerCase()}`;
      logEl.appendChild(li);
    }
  }

  /* patch 하나를 사람이 읽을 한 줄로 만드는 함수 */
  function describe(p) {
    const at = `[${p.path.join(', ')}]`;
    const short = (s) => (s.length > 40 ? s.slice(0, 40) + '…' : s);
    switch (p.type) {
      case 'TEXT': return `TEXT ${at} → "${short(p.value)}"`;
      case 'PROPS': {
        const set = Object.entries(p.set).map(([k, v]) => `${k}="${short(String(v))}"`).join(' ');
        const rm = p.remove.map((k) => `-${k}`).join(' ');
        return `PROPS ${at} ${[set, rm].filter(Boolean).join(' ')}`;
      }
      case 'CREATE': return `CREATE ${at} <${p.node.type === '#text' ? '텍스트' : p.node.type}>`;
      case 'REPLACE': return `REPLACE ${at} → <${p.node.type === '#text' ? '텍스트' : p.node.type}>`;
      case 'REMOVE': return `REMOVE ${at}`;
      default: return `${p.type} ${at}`;
    }
  }
})();
