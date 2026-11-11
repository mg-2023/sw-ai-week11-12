// 오목 데모(index.html) 기능 테스트: jsdom 에 페이지를 올리고 v1 엔진 · 오목 · 패널 스크립트를 순서대로 실행해 확인한다
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = ['engines/v1-batch/vdom.js', 'engines/v1-batch/diff.js', 'engines/v1-batch/patch.js', 'engines/v1-batch/hooks.js', 'engines/v1-batch/component.js', 'omok/game.js', 'omok/panel.js'];

/* omok.html 을 올리고 스크립트를 실행한 뒤, 커밋 보고 목록과 함께 window 를 돌려주는 함수 (로더는 jsdom 이 불러오지 않는다) */
function loadPage(t) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/index.html' });
  for (const file of SCRIPTS) dom.window.eval(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const reports = [];
  dom.window.Omok.app.onCommit((r) => reports.push(r));
  t.after(() => dom.window.close());
  return { win: dom.window, reports };
}

/* i 번 칸을 누르는 함수 */
function place(win, i) {
  win.document.querySelector(`.cell[data-i="${i}"]`).click();
}

/* 이름이 text 인 버튼을 누르는 함수 */
function press(win, text) {
  const btn = Array.from(win.document.querySelectorAll('button')).find((b) => b.textContent.trim() === text);
  btn.click();
}

test('처음 화면 : 칸 225개, 흑 차례, 둔 돌 없음', (t) => {
  const { win } = loadPage(t);
  assert.strictEqual(win.document.querySelectorAll('.cell').length, 225);
  assert.strictEqual(win.document.querySelectorAll('.cell .stone').length, 0);
  assert.match(win.document.title, /흑돌 차례/);
});

test('칸을 누르면 돌이 놓이고 차례가 바뀐다 — 착수 setter 두 개가 커밋 1회로 묶인다', (t) => {
  const { win, reports } = loadPage(t);
  place(win, 112);
  assert.ok(win.document.querySelector('.cell[data-i="112"] .stone.B'));
  assert.match(win.document.title, /백돌 차례/);
  assert.strictEqual(reports.length, 1);
});

test('이미 돌이 있는 칸은 눌러도 바뀌지 않는다', (t) => {
  const { win, reports } = loadPage(t);
  place(win, 0);
  place(win, 0);
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(win.document.querySelectorAll('.cell .stone').length, 1);
});

test('가로 다섯 줄이면 흑 승리, 다섯 칸이 표시되고 판이 잠긴다', (t) => {
  const { win } = loadPage(t);
  for (let k = 0; k < 4; k++) { place(win, k); place(win, 15 + k); }
  place(win, 4);
  assert.match(win.document.title, /흑돌 승리/);
  assert.strictEqual(win.document.querySelectorAll('.cell.win').length, 5);
  assert.ok(win.document.querySelector('.cell[data-i="200"]').disabled);
});

test('무르기는 마지막 돌을 빼고 차례를 되돌린다', (t) => {
  const { win } = loadPage(t);
  place(win, 112);
  press(win, '무르기');
  assert.strictEqual(win.document.querySelectorAll('.cell .stone').length, 0);
  assert.match(win.document.title, /흑돌 차례/);
});

test('기보에서 앞 수로 이동한 뒤 새로 두면 그 뒤 기록은 잘린다', (t) => {
  const { win } = loadPage(t);
  place(win, 0); place(win, 1); place(win, 2);
  win.document.querySelector('.move[data-to="1"]').click();
  place(win, 50);
  const moves = win.document.querySelectorAll('.moves li');
  assert.strictEqual(moves.length, 2);
  assert.ok(win.document.querySelector('.cell[data-i="50"] .stone.W'));
  assert.ok(!win.document.querySelector('.cell[data-i="2"] .stone'));
});

test('전체 초기화의 setter 다섯 개는 커밋 1회로 묶인다', (t) => {
  const { win, reports } = loadPage(t);
  place(win, 0);
  reports.length = 0;
  press(win, '전체 초기화');
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(win.document.querySelectorAll('.cell .stone').length, 0);
});

test('타이머 1초(엔진 이벤트 밖)의 setter 두 개는 지금 엔진에서 커밋 2회다 — 마이크로태스크 배칭의 비교 대상', (t) => {
  const { win, reports } = loadPage(t);
  win.Omok.tick();
  assert.strictEqual(reports.length, 2);
  assert.match(win.document.querySelector('.player.active .player-time').textContent, /00:01/);
});

test('착수 뒤 타이머는 바뀐 차례(백)의 시간을 올리고, 승부가 나면 멈춘다', (t) => {
  const { win } = loadPage(t);
  place(win, 112);
  win.Omok.tick();
  const times = Array.from(win.document.querySelectorAll('.player-time')).map((e) => e.textContent);
  assert.deepStrictEqual(times, ['00:00', '00:01']);
  for (let k = 0; k < 4; k++) { place(win, k); place(win, 15 + k); }
  place(win, 4);
  const before = win.document.querySelector('.info dd:last-child').textContent;
  win.Omok.tick();
  assert.strictEqual(win.document.querySelector('.info dd:last-child').textContent, before);
});

test('엔진 패널을 펼치면 게임 화면을 오른쪽으로 민다 (body.panel-open)', (t) => {
  const { win } = loadPage(t);
  win.document.getElementById('panel-toggle').click();
  assert.ok(win.document.body.classList.contains('panel-open'));
  win.document.querySelector('.panel-close').click();
  assert.ok(!win.document.body.classList.contains('panel-open'));
});

test('세부 목록을 열면 패널이 넓어지고, 착수의 diff 명령 · path 확인 · VDOM 트리가 보인다', (t) => {
  const { win } = loadPage(t);
  const doc = win.document;
  doc.getElementById('panel-toggle').click();
  doc.querySelector('.detail-toggle').click();
  assert.ok(doc.body.classList.contains('panel-detail'));
  place(win, 112);
  const rows = Array.from(doc.querySelectorAll('.patch-list li')).map((li) => li.textContent);
  assert.ok(rows.some((r) => r.startsWith('CREATE') && r.includes('[0,1,0,1,112,0]')));
  assert.ok(rows.every((r) => !/^PROPS .*— onClick\(함수\)$/.test(r)));
  doc.querySelector('.patch-list li.patch-create').click();
  assert.strictEqual(doc.querySelector('[data-cell="path-vdom"]').textContent, '<span.stone.B>');
  assert.strictEqual(doc.querySelector('[data-cell="path-dom"]').textContent, '<span.stone.B>');
  assert.ok(doc.querySelector('.vdom-tree details'));
});

test('왼쪽 위 엔진 버튼이 패널을 펼치고 접는다, 패널에 커밋 누계가 보인다', (t) => {
  const { win } = loadPage(t);
  const toggle = win.document.getElementById('panel-toggle');
  const panel = win.document.getElementById('engine-panel');
  toggle.click();
  assert.ok(panel.classList.contains('open'));
  assert.strictEqual(toggle.getAttribute('aria-expanded'), 'true');
  place(win, 112);
  assert.strictEqual(panel.querySelector('[data-cell="cause"]').textContent, '착수');
  assert.ok(Number(panel.querySelector('[data-cell="commits"]').textContent) >= 2);
  toggle.click();
  assert.ok(!panel.classList.contains('open'));
});
