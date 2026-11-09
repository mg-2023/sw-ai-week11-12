/* ======================================================================
 * app.js — 검증 페이지의 UI (화면 갱신, 이벤트 연결, 초기화)
 *
 *   변환·Diff·Patch·기록 로직은 src/ 아래 모듈에 있고, 여기서는 그것들을 화면과 연결만 한다.
 *     src/vdom.js    DOM / HTML ↔ Virtual DOM
 *     src/diff.js    두 VDOM 비교 → Patch 목록
 *     src/patch.js   Patch 를 실제 영역(DOM)에 반영
 *     src/history.js State History
 * ====================================================================== */

import { domToVdom, containerToVdom, parseHtmlToVdom, serializeNode, serializeRoot, vdomEqual } from './src/vdom.js';
import { diff } from './src/diff.js';
import { applyPatches, createDom, normalizeDom, patchFromHtml, patchToVdom } from './src/patch.js';
import { createHistory } from './src/history.js';

const $ = (s) => document.querySelector(s);
const realEl = $('#real-root'), srcEl = $('#test-src');   // 실제 영역(DOM) / 테스트 영역(HTML 소스를 담은 textarea)
const btnPatch = $('#btn-patch'), btnBack = $('#btn-back'), btnFwd = $('#btn-fwd');

let stateHistory;    // State History (init 에서 생성)

/** 테스트 영역: HTML 문자열 → VDOM / VDOM → HTML 문자열 (DOM 을 거치지 않는다) */
const readTestVdom = (report) => parseHtmlToVdom(srcEl.value, report);
const renderTestFrom = (vdom) => { srcEl.value = serializeRoot(vdom); };
const countNodes = (container) => { let n = 0; const walk = (x) => { n++; x.childNodes.forEach(walk); }; container.childNodes.forEach(walk); return n; };

/** 건드려진 노드를 잠깐 노란색으로 깜빡인다 */
function flash(node) {
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  if (!el || el === realEl || !el.animate) return;
  el.animate([{ outline: '2px solid #f59e0b', backgroundColor: 'rgba(245,158,11,.4)' },
              { outline: '2px solid rgba(245,158,11,0)', backgroundColor: 'rgba(245,158,11,0)' }], { duration: 1200 });
}

/* ---------------------------------------------------------------- 로그 / 화면 갱신 */
const trunc = (s, n = 90) => s.length > n ? s.slice(0, n) + '…' : s;
const show = (v) => v === undefined ? '(없음)' : "'" + v + "'";

function patchRow(p) {
  const row = document.createElement('div'); row.className = 'prow';
  const badge = document.createElement('span'); badge.className = 'badge ' + p.type; badge.textContent = p.type;
  const path = document.createElement('code'); path.textContent = '[' + p.path.join(', ') + ']';
  const d = document.createElement('span'); d.className = 'd';
  if (p.type === 'CREATE' || p.type === 'REPLACE') d.textContent = trunc(serializeNode(p.vnode).replace(/\n\s*/g, ''));
  else if (p.type === 'TEXT') d.textContent = JSON.stringify(p.text);
  else if (p.type === 'PROPS') d.textContent = p.changes.map((c) => c.name + ': ' + show(c.oldValue) + ' → ' + show(c.newValue)).join(', ');
  else d.textContent = '해당 노드 삭제';
  row.append(badge, path, d);
  return row;
}

function chip(text, cls) { const s = document.createElement('span'); s.className = 'badge ' + (cls || ''); s.textContent = text; return s; }

function showLog({ title, patches, message, mutated, verified, error }) {
  $('#log-title').textContent = title;
  const chips = $('#log-chips'); chips.replaceChildren();
  if (patches) chips.append(chip('패치 ' + patches.length + '개'));
  if (mutated !== undefined) chips.append(chip('실제 영역 DOM 변경 ' + mutated + '건'), chip('영역 전체 노드 ' + countNodes(realEl) + '개 (통째로 다시 그렸다면 전부 재생성)'));
  if (verified !== undefined) chips.append(verified ? chip('✅ 실제 영역 = 목표 VDOM', 'ok') : chip('❌ 실제 영역 ≠ 목표 VDOM (버그)', 'bad'));
  if (error) chips.append(chip('오류', 'bad'));
  $('#log-msg').textContent = message || '';
  const list = $('#log-patches');
  list.replaceChildren(...(patches || []).map(patchRow));
  list.hidden = !(patches && patches.length);
}

function checkDirty() {
  let dirty = false;
  try { dirty = !vdomEqual(readTestVdom(), stateHistory.current.vdom); } catch (e) { dirty = true; }
  const el = $('#st-dirty');
  el.textContent = dirty ? '수정됨 · Patch 대기' : 'Patch 완료';
  el.className = 'badge ' + (dirty ? 'warn' : 'ok');
}
let dirtyQueued = false;
const scheduleDirty = () => { if (dirtyQueued) return; dirtyQueued = true; requestAnimationFrame(() => { dirtyQueued = false; checkDirty(); }); };

function updateUI() {
  const { states, index: cur, current } = stateHistory;
  $('#st-pos').textContent = (cur + 1) + ' / ' + states.length;
  btnBack.disabled = !stateHistory.canBack;
  btnFwd.disabled = !stateHistory.canForward;
  $('#vdom-json').textContent = JSON.stringify(current.vdom, null, 2);
  $('#hist').replaceChildren(...states.map((s, i) => {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'hist-item' + (i === cur ? ' current' : '') + (i > cur ? ' future' : '');
    b.append(document.createTextNode('#' + i + ' ' + s.label + (i === cur ? '  ← 현재' : '')));
    const sm = document.createElement('small'); sm.textContent = s.summary + ' · ' + s.time; b.append(sm);
    b.addEventListener('click', () => goTo(i));
    return b;
  }));
  checkDirty();
}

/* ---------------------------------------------------------------- 동작: Patch / 이동 */
function doPatch() {
  try {
    // 테스트 영역 HTML → 새 VDOM → 이전 VDOM 과 Diff → 변경된 부분만 실제 영역에 반영
    const { next, patches, dropped, mutated, touched, verified } = patchFromHtml(realEl, stateHistory.current.vdom, srcEl.value);
    const note = dropped.length ? 'VDOM에서 제외된 항목: ' + dropped.join(', ') : '';
    if (!patches.length) {
      showLog({ title: 'Patch 실행', patches, message: '이전 State와 달라진 부분이 없어요. 테스트 영역을 수정한 뒤 다시 눌러 보세요.' + (note ? ' · ' + note : '') });
      return;
    }
    touched.forEach(flash);
    stateHistory.push(next, patches);                          // 새 VDOM 을 State History 에 저장 (되돌린 뒤 Patch 하면 이후 기록은 버림)
    updateUI();
    showLog({ title: 'Patch 실행 → State #' + stateHistory.index + ' 저장', patches, mutated, verified, message: note });
  } catch (err) { showLog({ title: 'Patch 실행', error: true, message: String(err) }); }
}

function goTo(i) {
  if (!stateHistory.canGoTo(i)) return;
  try {
    const from = stateHistory.index;
    // 실제 영역: 두 State 사이의 Diff 만 적용
    const { patches, mutated, touched, verified } = patchToVdom(realEl, stateHistory.current.vdom, stateHistory.states[i].vdom);
    touched.forEach(flash);
    const title = (i < from ? '뒤로' : '앞으로') + ': State #' + from + ' → #' + i;
    stateHistory.goTo(i);
    renderTestFrom(stateHistory.current.vdom);                 // 테스트 영역: 해당 VDOM 의 HTML 코드로 교체
    updateUI();
    showLog({ title, patches, mutated, verified, message: patches.length ? '' : '두 State의 VDOM이 같아서 실제 영역은 바뀌지 않았어요.' });
  } catch (err) { showLog({ title: '이동', error: true, message: String(err) }); }
}

/* ---------------------------------------------------------------- 초기화: 페이지 로드 */
(function init() {
  const v0 = normalizeDom(realEl);                             // 실제 영역의 샘플 HTML → Virtual DOM (+ 실제 DOM 을 VDOM 과 1:1 로 맞춤)
  stateHistory = createHistory(v0);
  renderTestFrom(v0);                                          // 그 VDOM 을 HTML 코드로 바꿔 테스트 영역에 표시
  const same = vdomEqual(containerToVdom(realEl), v0) && vdomEqual(readTestVdom(), v0);   // 왕복(VDOM→HTML→VDOM)해도 같은지 확인

  btnPatch.addEventListener('click', doPatch);
  btnBack.addEventListener('click', () => goTo(stateHistory.index - 1));
  btnFwd.addEventListener('click', () => goTo(stateHistory.index + 1));
  srcEl.addEventListener('input', scheduleDirty);

  updateUI();
  showLog({
    title: '페이지 로드',
    message: '① 실제 영역의 샘플 HTML을 Virtual DOM으로 변환했고 ② 그 VDOM을 HTML 코드로 바꿔 테스트 영역에 표시했어요. 이제 테스트 영역의 코드를 수정하고 Patch를 눌러 보세요.',
    verified: same,
  });
})();

window.__VD = { domToVdom, containerToVdom, createDom, diff, applyPatches, vdomEqual, parseHtmlToVdom, serializeRoot, get states() { return stateHistory.states; } }; // 콘솔 실험용
