// README 시연 GIF 녹화 스크립트 — 실제 페이지 · 실제 엔진을 Edge(화면 없음)로 열고, 진짜 버튼을 눌러 프레임을 찍는다
// 실행 : node docs/demo/record.mjs   →   python docs/demo/make_gif.py
// 결과를 미리 적어 두지 않는다. 자막의 숫자 · 노드 이름은 찍는 순간 페이지에서 읽은 값이다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9333;
const FRAMES = path.join(HERE, 'frames');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pageUrl = (file, query = '') => pathToFileURL(path.join(ROOT, file)).href + query;

/* Chrome DevTools Protocol 에 명령을 보내고 답을 기다리는 작은 클라이언트 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.wait = new Map();
    this.events = [];
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.wait.has(msg.id)) {
        const { ok, fail } = this.wait.get(msg.id);
        this.wait.delete(msg.id);
        if (msg.error) fail(new Error(msg.error.message)); else ok(msg.result);
      } else if (msg.method) {
        this.events.push(msg.method);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((ok, fail) => this.wait.set(id, { ok, fail }));
  }
}

/* Edge 를 화면 없이 띄우고 첫 탭에 연결하는 함수 */
async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-react-rec-'));
  const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' });
  let list;
  for (let i = 0; i < 50; i++) {
    try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (list.some((t) => t.type === 'page')) break; } catch { /* 아직 안 떴다 */ }
    await sleep(200);
  }
  const target = list.find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return { cdp, close: () => { ws.close(); proc.kill(); } };
}

/* 한 시연의 프레임을 모으는 도구 묶음 */
function recorder(cdp, name, width, height) {
  const dir = path.join(FRAMES, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const frames = [];
  return {
    async size() { await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); },
    async goto(url) { await cdp.send('Page.navigate', { url }); await sleep(900); },
    async js(expr) {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`페이지 스크립트 오류 : ${r.exceptionDetails.text} — ${expr.slice(0, 80)}`);
      return r.result.value;
    },
    async shot(ms, caption, extra = {}) {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = `${String(frames.length).padStart(2, '0')}.png`;
      fs.writeFileSync(path.join(dir, file), Buffer.from(data, 'base64'));
      frames.push({ file, ms, caption, ...extra });
    },
    save(meta = {}) { fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify({ ...meta, frames }, null, 2)); },
  };
}

// ───────── 시연 1 : Diff · TEXT Patch (phase1.html) ─────────
async function demoPatch(cdp) {
  const r = recorder(cdp, '1-diff-patch', 1280, 900);
  await r.size();
  await r.goto(pageUrl('phase1.html'));
  await r.shot(1600, '처음 : 실제 영역(왼쪽)을 Virtual DOM 으로 읽어 테스트 영역(오른쪽)에 그렸다');

  await r.js(`(() => { window.__b = document.querySelector('#actual b'); window.__t = __b.firstChild;
    const ta = document.getElementById('test'); ta.value = ta.value.replace('세 가지', '네 가지'); return true; })()`);
  await r.shot(1500, '테스트 영역에서 글자 하나만 고침 : "세 가지" → "네 가지"');

  await r.js(`document.getElementById('btn-patch').click()`);
  await sleep(120);
  const one = await r.js(`({ summary: document.getElementById('log-summary').textContent,
    first: document.querySelector('#patch-log li') ? document.querySelector('#patch-log li').textContent : '',
    same: document.querySelector('#actual b') === __b && __b.firstChild === __t })`);
  await r.shot(2000, `Patch → ${one.summary} · <b> 와 글자 노드는 같은 객체 그대로 (${one.same})`);
  await sleep(700);
  await r.shot(700, `변경 명령 : ${one.first}`);

  await r.js(`(() => { const ta = document.getElementById('test');
    ta.value = ta.value.replace('<li>Diff 알고리즘</li>', '<li class="done">Diff 알고리즘</li>')
                       .replace('<li>Patch 적용</li>', '<li>Patch 적용</li><li>Batching</li>'); return true; })()`);
  await r.shot(1500, '이번엔 "Diff 알고리즘" 에 class="done" 추가 + 맨 끝에 <li>Batching</li> 추가');

  await r.js(`document.getElementById('btn-patch').click()`);
  await sleep(120);
  const two = await r.js(`({ summary: document.getElementById('log-summary').textContent,
    types: [...document.querySelectorAll('#patch-log li')].map((li) => li.className.replace('p-', '').toUpperCase()).join(' · ') })`);
  await r.shot(2200, `Patch → ${two.summary} (${two.types}) — 나머지 노드는 그대로`);
  await sleep(900);
  await r.shot(1000, '바뀐 곳만 노랗게 깜빡인다 (Phase 1 페이지의 flash = 변경 명령이 가리킨 노드)');
  r.save({ width: 960, crop: [0, 0, 1280, 780] });
}

// ───────── 시연 2 : Hooks → 화면 갱신 (오목, v2) ─────────
async function demoHooks(cdp) {
  const r = recorder(cdp, '2-hooks-render', 1440, 900);
  await r.size();
  await r.goto(pageUrl('index.html', '?engine=v2-microtask'));
  await r.js(`(() => { document.getElementById('panel-toggle').click(); document.querySelector('.detail-toggle').click();
    document.getElementById('flash-dom').click(); return true; })()`);
  await sleep(500);
  const hooksText = `[...document.querySelectorAll('.hooks li')].slice(0, 2).map((li) => li.textContent).join(' · ')`;
  const before = await r.js(hooksText);
  await r.shot(1800, `착수 전 — ${before}`);

  const moves = `[...document.querySelectorAll('.log li')].filter((li) => li.textContent.includes('착수')).length`;
  for (const [n, cell] of [[1, 112], [2, 113]]) {
    const movesBefore = await r.js(moves);
    await r.js(`document.querySelector('.cell[data-i="${cell}"]').click()`);
    await sleep(60);
    const after = await r.js(`({ hooks: ${hooksText}, renders: ${moves} - ${movesBefore},
      count: document.querySelector('[data-cell="patch-count"]').textContent,
      create: [...document.querySelectorAll('.patch-list li.patch-create')].map((li) => li.textContent.split(' — ')[0]).join(', ') })`);
    await r.shot(2200, `${n}수째 착수 → setter 2개 → ${after.hooks} → 렌더 ${after.renders}번 (${after.count})`);
    await sleep(500);
    await r.shot(1300, `노란 칸 = 이번 커밋에서 실제로 고친 DOM · 새로 만든 노드 : ${after.create}`);
  }
  r.save({ width: 960 });
}

// ───────── 시연 3 : 배칭 v0 ↔ v2 (같은 오목, 엔진만 바꿈) ─────────
async function demoBatch(cdp) {
  const runs = {};
  for (const engine of ['v0', 'v2-microtask']) {
    const r = recorder(cdp, `3-batch-${engine}`, 1440, 900);
    await r.size();
    await r.goto(pageUrl('index.html', `?engine=${engine}`));
    await r.js(`document.getElementById('panel-toggle').click()`);
    await sleep(400);
    const log = `[...document.querySelectorAll('.log li')].map((li) => li.textContent)`;
    const count = (rows, word) => rows.filter((t) => t.includes(word)).length;
    await r.shot(1500, '');
    const base = await r.js(log);
    await r.js(`document.querySelector('.cell[data-i="112"]').click()`);
    await sleep(80);
    const afterMove = await r.js(log);
    await r.shot(2400, '', { move: count(afterMove, '착수') - count(base, '착수') });
    const ticks0 = count(afterMove, '타이머');
    let afterTick = afterMove;
    for (let i = 0; i < 30 && count(afterTick, '타이머') === ticks0; i++) { await sleep(50); afterTick = await r.js(log); }
    await sleep(60);
    afterTick = await r.js(log);
    await r.shot(2600, '', { tick: count(afterTick, '타이머') - ticks0 });
    r.save({ crop: [0, 0, 360, 730] });
    runs[engine] = true;
  }
  return runs;
}

const { cdp, close } = await launch();
try {
  await demoPatch(cdp);
  await demoHooks(cdp);
  await demoBatch(cdp);
  console.log('프레임 저장 :', FRAMES);
} finally {
  close();
}
