/**
 * app.js — 검증 페이지: 실제 영역 · 테스트 영역 · Patch · 뒤로가기 · 앞으로가기
 *
 * 상태는 둘뿐:
 *   shown   지금 실제 영역에 그려진 Virtual DOM (Diff 의 "이전")
 *   history State History (Virtual DOM 스냅샷 목록)
 */
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

  // 실제 DOM 이 몇 번 바뀌었는지 센다 → "바뀐 곳만" 반영했는지 눈으로 확인
  const observer = new MutationObserver(() => {});
  observer.observe(actualEl, { subtree: true, childList: true, attributes: true, characterData: true });

  // ── 로드: 실제 영역 → Virtual DOM → 테스트 영역 ──
  let shown = M.domToVdom(actualEl);
  M.mount(actualEl, shown); // 들여쓰기 · 주석 노드를 없애 DOM ↔ VDOM 을 1:1 로 (patch 가 번호로 찾기 위해)
  observer.takeRecords();
  const history = M.createHistory(shown);
  showInTestArea(shown);
  refreshButtons();
  setStatus('준비됨: 실제 영역을 Virtual DOM 으로 읽어 테스트 영역에 그렸습니다');

  // ── Patch ──
  btnPatch.addEventListener('click', onPatch);
  testEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onPatch();
    }
  });

  function onPatch() {
    const next = M.htmlToVdom(testEl.value, shown); // 1. 테스트 영역 → 새 Virtual DOM
    const patches = M.diff(shown, next); // 2. 이전과 비교
    if (patches.length === 0) {
      M.syncFormState(actualEl, shown); // 실제 영역에서 손으로 바꾼 입력값도 되돌린다
      setStatus('바뀐 곳이 없습니다 (기록에 넣지 않음)');
      showLog([], 0);
      showInTestArea(next); // 파서가 고친 모양으로 다시 보여 준다
      return;
    }
    const mutations = apply(patches, next); // 3. 바뀐 곳만 실제 영역에
    if (mutations === null) return; // 적용 실패 → 되돌렸고 기록도 안 늘림
    shown = history.push(next); // 4. State History 에 저장
    showInTestArea(shown);
    refreshButtons();
    setStatus(`Patch ${patches.length}건 반영, 기록 ${history.index + 1} 번째에 저장`);
    showLog(patches, mutations);
  }

  // ── 뒤로 · 앞으로: 기록의 Virtual DOM 으로 두 영역을 함께 바꾼다 ──
  btnBack.addEventListener('click', () => travel(history.back(), '뒤로'));
  btnForward.addEventListener('click', () => travel(history.forward(), '앞으로'));

  function travel(target, label) {
    if (!target) return;
    const patches = M.diff(shown, target);
    const mutations = apply(patches, target);
    if (mutations === null) {
      // 기록끼리의 이동은 원래 실패하지 않지만, 만약을 위해 목표 기록 그대로 다시 그린다
      M.mount(actualEl, target);
      observer.takeRecords();
    }
    shown = target;
    showInTestArea(shown);
    refreshButtons();
    setStatus(`${label}: 기록 ${history.index + 1} 번째로 이동 (Patch ${patches.length}건)`);
    showLog(patches, mutations);
  }

  // ── 도움 함수 ──

  /**
   * patches 를 실제 영역에 적용하고, 실제 DOM 변경 횟수를 돌려준다.
   * 중간에 실패하면 (예: 파서는 받아 주지만 setAttribute 는 거부하는 속성 이름 `a@`)
   * 일부만 바뀐 채로 남지 않게 지금 기록(shown)대로 다시 그리고 null 을 돌려준다.
   * target: 적용 뒤 폼 상태(입력값 · 체크)를 맞출 기준 VDOM
   */
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

  /** 바뀐 노드를 잠깐 노랗게. 속성을 건드리지 않는 Web Animations 를 써서 DOM ↔ VDOM 이 어긋나지 않게 한다 */
  function flash(patches) {
    for (const p of patches) {
      let node;
      try {
        // REMOVE 는 노드가 없으니 부모, 텍스트는 그 부모 요소를 깜빡인다
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

  function showInTestArea(vnode) {
    testEl.value = M.toHtml(vnode.children);
  }

  function refreshButtons() {
    btnBack.disabled = !history.canBack();
    btnForward.disabled = !history.canForward();
    posEl.textContent = `기록 ${history.index + 1} / ${history.length}`;
  }

  function setStatus(msg) {
    statusEl.textContent = msg;
  }

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
