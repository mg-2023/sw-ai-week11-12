/* ======================================================================
 * app.js — 검증 페이지의 UI (화면 갱신, 이벤트 연결, 초기화)
 *
 *   변환·Diff·Patch·기록·컴포넌트 로직은 src/ 아래 모듈에 있고, 여기서는 그것들을 화면과 연결만 한다.
 *     src/vdom.js    DOM / HTML ↔ Virtual DOM
 *     src/diff.js    두 VDOM 비교 → Patch 목록
 *     src/patch.js   Patch 를 실제 영역(DOM)에 반영
 *     src/history.js State History (보기 전용)
 *     src/root.js    컴포넌트 마운트 · state 변경 시 리렌더 (compo.js / hooks.js / events.js 사용)
 *     demo/App.js    예제 컴포넌트 (카운터: useState / useMemo / useEffect)
 *
 *   두 가지 모드
 *     HTML 편집 모드 : 테스트 영역 HTML 을 고치고 Patch → 변경분만 실제 영역에 반영
 *     컴포넌트 모드  : App 을 마운트. 실제 영역의 버튼 클릭 → setState → 리렌더 → Diff → Patch
 * ====================================================================== */

import { domToVdom, containerToVdom, parseHtmlToVdom, serializeNode, serializeRoot, vdomEqual } from './src/vdom.js';
import { diff } from './src/diff.js';
import { applyPatches, createDom, normalizeDom, patchFromHtml, patchToVdom } from './src/patch.js';
import { createHistory } from './src/history.js';
import { createRoot } from './src/root.js';
import { App } from './demo/App.js';

const $ = (s) => document.querySelector(s);
const realEl = $('#real-root'), srcEl = $('#test-src');   // 실제 영역(DOM) / 테스트 영역(HTML 소스를 담은 textarea)
const btnPatch = $('#btn-patch'), btnBack = $('#btn-back'), btnFwd = $('#btn-fwd'), btnMode = $('#btn-mode');

let stateHistory;    // State History (init 에서 생성)
let root;            // 컴포넌트 루트 (init 에서 생성)
let componentMode = false;

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
  const el = $('#st-dirty');
  if (componentMode) { el.textContent = '컴포넌트 모드'; el.className = 'badge'; return; }
  let dirty = false;
  try { dirty = !vdomEqual(readTestVdom(), stateHistory.current.vdom); } catch (e) { dirty = true; }
  el.textContent = dirty ? '수정됨 · Patch 대기' : 'Patch 완료';
  el.className = 'badge ' + (dirty ? 'warn' : 'ok');
}
let dirtyQueued = false;
const scheduleDirty = () => { if (dirtyQueued) return; dirtyQueued = true; requestAnimationFrame(() => { dirtyQueued = false; checkDirty(); }); };

/** VDOM JSON 표시: events 의 핸들러 함수는 JSON 에 안 나오므로 "[function]" 으로 보여 준다 */
const vdomJson = (vdom) => JSON.stringify(vdom, (k, v) => (typeof v === 'function' ? '[function]' : v), 2);

function updateUI() {
  const { states, index: cur, current } = stateHistory;
  $('#st-pos').textContent = (cur + 1) + ' / ' + states.length;
  // 컴포넌트 모드에서는 이동 금지: VDOM 만 되돌리면 화면은 0 인데 state(훅)는 1 인 상태가 된다
  btnBack.disabled = componentMode || !stateHistory.canBack;
  btnFwd.disabled = componentMode || !stateHistory.canForward;
  $('#vdom-json').textContent = vdomJson(current.vdom);
  $('#hist').replaceChildren(...states.map((s, i) => {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'hist-item' + (i === cur ? ' current' : '') + (i > cur ? ' future' : '');
    b.disabled = componentMode;                                // 컴포넌트 모드: 기록 보기만 가능
    b.append(document.createTextNode('#' + i + ' ' + s.label + (i === cur ? '  ← 현재' : '')));
    const sm = document.createElement('small'); sm.textContent = s.summary + ' · ' + s.time; b.append(sm);
    b.addEventListener('click', () => goTo(i));
    return b;
  }));
  checkDirty();
}

/* ---------------------------------------------------------------- 동작: Patch (HTML 편집 모드) */
function doPatch() {
  if (componentMode) return;                                   // 컴포넌트 모드에서는 화면을 state 가 결정한다
  try {
    // 테스트 영역 HTML → 새 VDOM → 이전 VDOM 과 Diff → 변경된 부분만 실제 영역에 반영
    const { next, patches, dropped, mutated, touched, verified } = patchFromHtml(realEl, stateHistory.current.vdom, srcEl.value);
    const note = dropped.length ? 'VDOM에서 제외된 항목: ' + dropped.join(', ') : '';
    if (!patches.length) {
      showLog({ title: 'Patch 실행', patches, message: '이전 State와 달라진 부분이 없어요. 테스트 영역을 수정한 뒤 다시 눌러 보세요.' + (note ? ' · ' + note : '') });
      return;
    }
    touched.forEach(flash);
    stateHistory.push(next, patches);                          // 새 VDOM 을 State History 에 저장
    updateUI();
    showLog({ title: 'Patch 실행 → State #' + stateHistory.index + ' 저장', patches, mutated, verified, message: note });
  } catch (err) { showLog({ title: 'Patch 실행', error: true, message: String(err) }); }
}

/* ---------------------------------------------------------------- 동작: 뒤로 / 앞으로 / History 이동 (HTML 편집 모드) */
function goTo(i) {
  if (componentMode || !stateHistory.canGoTo(i)) return;
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

/* ---------------------------------------------------------------- 동작: 컴포넌트 모드 */

/** root.js 가 렌더(마운트 / state 변경)를 실제 영역에 반영한 뒤 부른다 */
function onCommit({ reason, next, patches, mutated, touched, verified }) {
  const mount = reason === 'mount';
  renderTestFrom(next);                                        // 테스트 영역: 렌더 결과 HTML (읽기 전용)
  if (!patches.length) {
    updateUI();
    showLog({ title: mount ? '컴포넌트 마운트' : '렌더 (state 변경)', patches, message: '이전 VDOM과 달라진 부분이 없어 실제 영역은 그대로예요.' });
    return;
  }
  touched.forEach(flash);
  const label = mount ? '컴포넌트 마운트' : '렌더 ' + stateHistory.states.length;
  stateHistory.push(next, patches, label);
  updateUI();
  showLog({
    title: (mount ? '컴포넌트 마운트' : '렌더 (state 변경)') + ' → State #' + stateHistory.index + ' 저장',
    patches, mutated, verified,
    message: mount ? '실제 영역의 "+1" 버튼을 눌러 보세요. 클릭 → setState → 리렌더 → Diff → Patch 순서로 반영돼요. useMemo / useEffect 의 실행 여부는 브라우저 콘솔과 탭 제목에서 확인할 수 있어요.' : '',
  });
}

function onRenderError(err, reason) {
  showLog({ title: reason === 'mount' ? '컴포넌트 마운트' : '렌더 (state 변경)', error: true, message: String(err) });
}

function setMode(on) {
  componentMode = on;
  btnMode.setAttribute('aria-pressed', String(on));
  btnMode.textContent = on ? 'HTML 편집 모드로' : '컴포넌트 모드';
  btnPatch.disabled = on;
  srcEl.readOnly = on;
  realEl.inert = !on;                                          // inert 가 붙어 있으면 클릭이 전달되지 않는다
  document.body.classList.toggle('compo-mode', on);
  $('#test-badge').textContent = on ? '렌더 결과 (읽기 전용)' : 'HTML 소스를 자유롭게 수정';
  $('#test-badge').className = 'badge ' + (on ? '' : 'warn');
  $('#real-hint').textContent = on
    ? '컴포넌트 모드: 카운터 버튼들을 클릭할 수 있어요. 클릭 이벤트는 실제 영역에 단 하나의 리스너로 위임됩니다.'
    : '여기는 직접 수정·조작할 수 없어요(inert). Patch / 뒤로(앞으로)의 결과만 보입니다.';
  $('#test-hint').textContent = on
    ? '컴포넌트 모드: 렌더 결과 HTML을 보여 주는 읽기 전용 영역이에요.'
    : 'HTML 코드를 직접 고친 뒤 Patch를 누르세요. 뒤로(앞으로) 이동하면 Patch하지 않은 수정은 사라집니다.';
  $('#hist-note').textContent = on ? '(컴포넌트 모드: 보기 전용)' : '(클릭하면 해당 State로 이동)';
  if (stateHistory) updateUI();                               // 뒤로/앞으로·History 활성 상태 갱신
}

function toggleMode() {
  if (!componentMode) {
    setMode(true);
    root.mount(App, stateHistory.current.vdom);                // 현재 실제 영역의 VDOM 에서 App 렌더 결과로 Diff → Patch. state 는 초기값부터
    if (!root.mounted) setMode(false);
  } else {
    root.unmount();                                            // 위임 리스너 해제
    setMode(false);
    renderTestFrom(stateHistory.current.vdom);
    updateUI();
    showLog({ title: 'HTML 편집 모드로 전환', message: '실제 영역은 마지막 렌더 결과 그대로예요. 테스트 영역을 고친 뒤 Patch할 수 있어요. 다시 컴포넌트 모드로 들어가면 state는 초기값(0)부터 시작합니다.' });
  }
}

/* ---------------------------------------------------------------- 초기화: 페이지 로드 */
(function init() {
  const v0 = normalizeDom(realEl);                             // 실제 영역의 샘플 HTML → Virtual DOM (+ 실제 DOM 을 VDOM 과 1:1 로 맞춤)
  stateHistory = createHistory(v0);
  root = createRoot(realEl, { onCommit, onError: onRenderError });
  renderTestFrom(v0);                                          // 그 VDOM 을 HTML 코드로 바꿔 테스트 영역에 표시
  const same = vdomEqual(containerToVdom(realEl), v0) && vdomEqual(readTestVdom(), v0);   // 왕복(VDOM→HTML→VDOM)해도 같은지 확인

  btnPatch.addEventListener('click', doPatch);
  btnBack.addEventListener('click', () => goTo(stateHistory.index - 1));
  btnFwd.addEventListener('click', () => goTo(stateHistory.index + 1));
  btnMode.addEventListener('click', toggleMode);
  srcEl.addEventListener('input', scheduleDirty);

  setMode(false);
  updateUI();
  showLog({
    title: '페이지 로드',
    message: '① 실제 영역의 샘플 HTML을 Virtual DOM으로 변환했고 ② 그 VDOM을 HTML 코드로 바꿔 테스트 영역에 표시했어요. 이제 테스트 영역의 코드를 수정하고 Patch를 누르거나, 컴포넌트 모드로 들어가 보세요.',
    verified: same,
  });
})();

window.__VD = { domToVdom, containerToVdom, createDom, diff, applyPatches, vdomEqual, parseHtmlToVdom, serializeRoot, get states() { return stateHistory.states; }, get root() { return root; } }; // 콘솔 실험용
