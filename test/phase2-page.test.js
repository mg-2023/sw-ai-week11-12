// Phase 2 측정 페이지(phase2.html) 기능 테스트: jsdom 에 페이지와 스크립트 여섯 개를 순서대로 올려 확인한다
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = ['src/vdom.js', 'src/diff.js', 'src/patch.js', 'src/hooks.js', 'src/component.js', 'phase2/app.js'];

/* phase2.html 을 읽어 jsdom 에 올리고 스크립트를 순서대로 실행한 window 를 돌려주는 함수 */
function loadPage() {
  const html = fs.readFileSync(path.join(ROOT, 'phase2.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  for (const file of SCRIPTS) dom.window.eval(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  return dom.window;
}

/* 입력칸에 글자를 넣고 input 이벤트를 보내는 함수 */
function typeText(win, value) {
  const input = win.document.querySelector('#demo input[type="text"]');
  input.value = value;
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
}

/* 추가 버튼을 누르는 함수 */
function clickAdd(win) {
  win.document.querySelector('#demo button[type="submit"]').click();
}

/* 데모 영역의 항목(li) 목록을 돌려주는 함수 */
function items(win) {
  return Array.from(win.document.querySelectorAll('#demo li'));
}

/* "남은 일" 숫자를 돌려주는 함수 */
function remaining(win) {
  return Number(win.document.querySelector('#demo .remaining').textContent);
}

test('페이지를 열면 할 일 2개가 보이고 측정 패널에 mount 보고가 있다', () => {
  const win = loadPage();
  assert.strictEqual(items(win).length, 2);
  const panel = win.document.getElementById('panel');
  assert.match(panel.querySelector('.kind').textContent, /mount/);
  assert.match(panel.querySelector('.ms').textContent, /\d/);
  assert.match(panel.querySelector('.hook-count').textContent, /\d/);
});

test('입력 후 추가하면 항목이 3개가 되고 남은 일이 갱신되고 입력칸이 비워진다', () => {
  const win = loadPage();
  const before = remaining(win);
  typeText(win, '새 할 일');
  clickAdd(win);
  assert.strictEqual(items(win).length, 3);
  assert.strictEqual(remaining(win), before + 1);
  assert.strictEqual(win.document.querySelector('#demo input[type="text"]').value, '');
});

test('체크하면 남은 일이 줄고 삭제하면 항목이 줄어든다', () => {
  const win = loadPage();
  const before = remaining(win);
  items(win)[0].querySelector('input[type="checkbox"]').click();
  assert.strictEqual(remaining(win), before - 1);
  items(win)[0].querySelector('button').click();
  assert.strictEqual(items(win).length, 1);
});

test('빈 입력과 공백만 입력은 추가되지 않는다', () => {
  const win = loadPage();
  clickAdd(win);
  typeText(win, '   ');
  clickAdd(win);
  assert.strictEqual(items(win).length, 2);
});

test('script 태그 글자는 실행되지 않고 글자로만 보인다', () => {
  const win = loadPage();
  typeText(win, '<script>alert(1)</script>');
  clickAdd(win);
  const last = items(win)[2];
  assert.strictEqual(last.querySelector('script'), null);
  assert.match(last.textContent, /<script>alert\(1\)<\/script>/);
});

test('시나리오 버튼마다 records 에 한 줄이 쌓인다', () => {
  const win = loadPage();
  const ids = ['add100', 'reverse', 'prepend', 'editOne', 'set10'];
  ids.forEach((id, i) => {
    win.document.querySelector(`[data-scenario="${id}"]`).click();
    const records = win.Phase2.records;
    assert.strictEqual(records.length, i + 1);
    const r = records[i];
    assert.strictEqual(r.version, 'v0 기본');
    assert.strictEqual(r.scenario, id);
    for (const key of ['renders', 'ms', 'compared', 'patches', 'domMutations']) assert.strictEqual(typeof r[key], 'number');
  });
  assert.strictEqual(win.document.querySelectorAll('#records tbody tr').length, 5);
});

test('set10 은 렌더를 10번 한다', () => {
  const win = loadPage();
  win.document.querySelector('[data-scenario="set10"]').click();
  assert.strictEqual(win.Phase2.records[0].renders, 10);
});

test('add100 은 항목 100개를 더하고 DOM 변경을 센다', () => {
  const win = loadPage();
  win.document.querySelector('[data-scenario="add100"]').click();
  assert.strictEqual(items(win).length, 102);
  const r = win.Phase2.records[0];
  assert.strictEqual(r.renders, 1);
  assert.ok(r.patches > 0);
  assert.ok(r.domMutations > 0);
});

test('패널의 hooks 표시가 app.inspect().hooks 와 같다', () => {
  const win = loadPage();
  typeText(win, '글');
  const shown = Array.from(win.document.querySelectorAll('#panel .hooks li')).map((li) => li.textContent);
  const expected = Array.from(win.Phase2.app.inspect().hooks, (hook) => `${hook.kind}: ${JSON.stringify(hook.value)}`);
  assert.deepStrictEqual(shown, expected);
});

test('이벤트만 바뀐 PROPS 는 패널에 따로 보인다', () => {
  const win = loadPage();
  typeText(win, '글');
  assert.match(win.document.querySelector('#panel .event-only').textContent, /[1-9]/);
});

test('recordsToMarkdown 첫 줄은 표 머리다', () => {
  const win = loadPage();
  const md = win.Phase2.recordsToMarkdown([]);
  assert.strictEqual(md.split('\n')[0], '| 버전 | 시나리오 | 렌더 | 시간(ms) | 비교 | patch | DOM 변경 |');
});

test('문서 제목에 남은 일 수가 들어간다', () => {
  const win = loadPage();
  assert.ok(win.document.title.includes(String(remaining(win))));
  items(win)[0].querySelector('input[type="checkbox"]').click();
  assert.ok(win.document.title.includes(String(remaining(win))));
});

test('addClick 은 준비(타이핑)를 빼고 추가 클릭만 잰다 — 배칭 뒤 1', () => {
  const win = loadPage();
  win.document.querySelector('[data-scenario="addClick"]').click();
  const r = win.Phase2.records[0];
  assert.strictEqual(r.scenario, 'addClick');
  assert.strictEqual(items(win).length, 3);
  assert.strictEqual(win.document.querySelector('#demo input[type="text"]').value, '');
  assert.strictEqual(r.renders, 1);
});
