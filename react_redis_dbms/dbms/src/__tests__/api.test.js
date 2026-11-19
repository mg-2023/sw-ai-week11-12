/* 기능 테스트 (Phase 3) — API 서버를 실제로 띄우고 HTTP 로 SQL 을 실행한다
 *
 *   워커 스레드 4개짜리 서버를 빈 포트에 띄운다. 외부 클라이언트 역할은 node:http 요청이 한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDbServer, listen } from '../api.js';
import { makeDataDir, removeDir } from './helper.js';

const THREADS = 4;
let dir, db, url;
const agent = new http.Agent({ keepAlive: true, maxSockets: 32 });       // 연결 32개를 재사용한다

before(async () => {
  dir = makeDataDir();
  db = await createDbServer({ dataDir: dir, poolSize: THREADS, maxRows: 500 });
  url = await listen(db.server);
});
after(async () => { agent.destroy(); await db.close(); removeDir(dir); });

/** 요청을 보내고 { status, body } 를 돌려준다 */
function request(method, pathname, body, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const req = http.request(url + pathname, { method, agent, headers: body === undefined ? {} : { 'content-type': contentType, 'content-length': Buffer.byteLength(body) } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const query = (sql) => request('POST', '/query', JSON.stringify({ sql }));
const rows = async (sql) => { const r = await query(sql); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.results.at(-1).rows; };

test('POST /query: INSERT 와 SELECT 가 동작하고, 실행한 워커 스레드 번호를 알려 준다', async () => {
  const inserted = await query("INSERT INTO products (name, price, stock) VALUES ('키보드', 39000.5, 12), ('마우스', 15000, 0)");
  assert.equal(inserted.status, 200);
  assert.deepEqual([inserted.body.results[0].rowCount, inserted.body.results[0].firstId], [2, 1]);
  assert.ok(inserted.body.worker > 0);

  const selected = await query('SELECT name, price FROM products WHERE id = 1');
  assert.equal(selected.body.results[0].plan, 'INDEX_POINT');
  assert.deepEqual(selected.body.results[0].rows, [['키보드', 39000.5]]);
  assert.equal(fs.readFileSync(path.join(dir, 'products.jsonl'), 'utf8'), '[1,"키보드",39000.5,12]\n[2,"마우스",15000,0]\n');
});

test('POST /query: 본문을 SQL 글자 그대로 보내도 되고, 여러 문장을 한 번에 보낼 수 있다', async () => {
  const r = await request('POST', '/query', "SELECT COUNT(*) FROM products; SELECT name FROM products WHERE stock = 0", 'text/plain');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((x) => x.rows), [[[2]], [['마우스']]]);
});

test('동시성: 클라이언트 300개가 동시에 INSERT 해도 id 가 겹치거나 빠지지 않는다', async () => {
  const responses = await Promise.all(Array.from({ length: 300 }, (_, i) => query("INSERT INTO users (name, age, city) VALUES ('동시" + i + "', " + (i % 50) + ", '서울')")));
  assert.ok(responses.every((r) => r.status === 200));
  const ids = responses.map((r) => r.body.results[0].firstId).sort((a, b) => a - b);
  assert.deepEqual(ids, Array.from({ length: 300 }, (_, i) => i + 1));    // 1 ~ 300 이 정확히 한 번씩

  const lines = fs.readFileSync(path.join(dir, 'users.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 300);
  lines.forEach((line) => JSON.parse(line));                              // 줄이 섞이거나 깨지지 않았다
  assert.equal(new Set(responses.map((r) => r.body.worker)).size, THREADS);   // 워커 4개가 모두 일했다
});

test('동시성: 어느 워커가 쓴 레코드든 모든 워커가 자기 인덱스로 찾는다', async () => {
  const seen = new Map();                                                 // 워커 번호 → 그 워커가 찾은 이름
  for (let round = 0; round < 10 && seen.size < THREADS; round++) {
    const responses = await Promise.all(Array.from({ length: 16 }, () => query('SELECT name FROM users WHERE id = 300')));
    for (const r of responses) seen.set(r.body.worker, r.body.results[0]);
  }
  assert.equal(seen.size, THREADS);
  for (const result of seen.values()) {
    assert.equal(result.plan, 'INDEX_POINT');
    assert.equal(result.rows.length, 1);
  }
});

test('동시성: 읽기와 쓰기를 섞어 동시에 보내도 읽기는 항상 온전한 레코드만 본다', async () => {
  const before = (await rows('SELECT COUNT(*) FROM users'))[0][0];
  const jobs = [];
  for (let i = 0; i < 60; i++) {
    jobs.push(query("INSERT INTO users (name, age, city) VALUES ('섞기" + i + "', 99, '부산'), ('섞기" + i + "b', 99, '부산')"));
    jobs.push(query('SELECT COUNT(*) FROM users WHERE age = 99'));
    jobs.push(query('SELECT id, name, age, city FROM users ORDER BY id DESC LIMIT 5'));
  }
  const responses = await Promise.all(jobs);
  assert.ok(responses.every((r) => r.status === 200), JSON.stringify(responses.find((r) => r.status !== 200)?.body));
  for (const r of responses) {
    const result = r.body.results[0];
    if (result.type !== 'select') continue;
    if (result.columns[0] === 'count') assert.equal(result.rows[0][0] % 2, 0);     // 두 건짜리 INSERT 의 절반만 보이는 일은 없다
    else for (const row of result.rows) assert.equal(row.length, 4);
  }
  assert.deepEqual(await rows('SELECT COUNT(*) FROM users'), [[before + 120]]);
});

test('병렬 처리: 동시에 보낸 선형 탐색들이 여러 워커에서 겹쳐 실행된다', async () => {
  const values = Array.from({ length: 2000 }, (_, i) => "('대량" + i + "', " + (i % 80) + ", 'city" + (i % 9) + "')").join(',');
  for (let i = 0; i < 20; i++) assert.equal((await query('INSERT INTO users (name, age, city) VALUES ' + values)).status, 200);   // 4만 건

  const responses = await Promise.all(Array.from({ length: 12 }, () => query("SELECT COUNT(*) FROM users WHERE city = 'city3'")));
  assert.ok(responses.every((r) => r.body.results[0].plan === 'FULL_SCAN'));
  assert.ok(new Set(responses.map((r) => r.body.results[0].rows[0][0])).size === 1);
  assert.ok(new Set(responses.map((r) => r.body.worker)).size >= 2);
  const overlaps = responses.some((a) => responses.some((b) => a.body.worker !== b.body.worker && a.body.startedAt < b.body.finishedAt && b.body.startedAt < a.body.finishedAt));
  assert.ok(overlaps, '서로 다른 워커의 실행 시간이 겹쳐야 한다');
});

test('GET /tables, /stats, /health', async () => {
  const tables = await request('GET', '/tables');
  const users = tables.body.tables.find((t) => t.table === 'users');
  assert.equal(users.rows, (await rows('SELECT COUNT(*) FROM users'))[0][0]);
  assert.deepEqual(users.columns.map((c) => c.name), ['id', 'name', 'age', 'city']);

  const stats = await request('GET', '/stats');
  assert.equal(stats.body.size, THREADS);
  assert.equal(stats.body.workers.length, THREADS);
  assert.ok(stats.body.completed > 300);
  assert.deepEqual((await request('GET', '/health')).body, { ok: true });
});

test('결과가 너무 많으면 maxRows 까지만 보내고 truncated 로 알린다', async () => {
  const r = await query('SELECT id FROM users');
  assert.deepEqual([r.body.results[0].rowCount, r.body.results[0].truncated], [500, true]);
});

test('오류: SQL 이 틀리면 400 과 이유를 돌려주고, 서버는 계속 동작한다', async () => {
  const cases = [
    ['SELECT * FORM users', /FROM/],
    ['SELECT * FROM nothing', /테이블이 없습니다/],
    ["INSERT INTO users (name, age) VALUES ('a', '스물')", /정수/],
    ['DROP TABLE users', /지원하지 않는 문장/],
    ["SELECT 'abc", /닫히지 않았습니다/],
  ];
  for (const [sql, pattern] of cases) {
    const r = await query(sql);
    assert.equal(r.status, 400, sql);
    assert.match(r.body.error, pattern);
  }
  assert.equal((await query('SELECT COUNT(*) FROM users')).status, 200);
});

test('오류: 잘못된 요청 (JSON 오류, SQL 없음, 없는 경로, 다른 메서드)', async () => {
  assert.equal((await request('POST', '/query', '{"sql": ')).status, 400);
  assert.equal((await request('POST', '/query', '{}')).status, 400);
  assert.equal((await request('POST', '/query', '{"sql": "   "}')).status, 400);
  assert.equal((await request('POST', '/query', '{"sql": 123}')).status, 400);
  assert.equal((await request('GET', '/query')).status, 405);
  assert.equal((await request('GET', '/nothing')).status, 404);
});

test('엣지: SQL 주입처럼 보이는 문자열도 값으로만 저장된다', async () => {
  const evil = "x'); INSERT INTO users (name) VALUES ('해킹";
  const before = (await rows('SELECT COUNT(*) FROM users'))[0][0];
  const r = await query("INSERT INTO users (name) VALUES ('" + evil.replaceAll("'", "''") + "')");
  assert.equal(r.status, 200);
  assert.deepEqual(await rows('SELECT COUNT(*) FROM users'), [[before + 1]]);
  assert.deepEqual(await rows('SELECT name FROM users WHERE id = ' + r.body.results[0].firstId), [[evil]]);
});

test('재시작: 서버를 닫고 다시 띄워도 데이터와 자동 id 가 이어진다', async () => {
  const count = (await rows('SELECT COUNT(*) FROM users'))[0][0];
  await db.close();
  db = await createDbServer({ dataDir: dir, poolSize: 2, maxRows: 500 });
  url = await listen(db.server);
  assert.deepEqual(await rows('SELECT COUNT(*) FROM users'), [[count]]);
  const r = await query("INSERT INTO users (name) VALUES ('재시작 뒤')");
  assert.equal(r.body.results[0].firstId, count + 1);
});
