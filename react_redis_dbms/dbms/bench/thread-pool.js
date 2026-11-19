/* ======================================================================
 * bench/thread-pool.js — 워커 스레드 수에 따른 API 서버 처리 시간 비교 (Phase 3)
 *
 *   npm run bench:pool        (먼저 npm run bench 로 bench-data/ 에 100만 건을 만들어 두어야 한다)
 *
 *   같은 데이터로 API 서버를 워커 1개 / 2개 / 4개로 띄우고,
 *   선형 탐색 요청(COUNT(*) WHERE city = …) 16개를 동시에 보내 전부 끝날 때까지 걸린 시간을 잰다.
 *   선형 탐색은 CPU 를 오래 쓰는 일이라, 스레드가 여러 개면 여러 코어에서 동시에 실행된다.
 * ====================================================================== */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createDbServer, listen } from '../src/api.js';

const DIR = path.join(fileURLToPath(new URL('..', import.meta.url)), 'bench-data');
const REQUESTS = 16;
if (!fs.existsSync(path.join(DIR, 'users.jsonl'))) { console.error('bench-data 가 없습니다. 먼저 npm run bench 를 실행하세요'); process.exit(1); }

function query(agent, url, sql) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ sql });
    const req = http.request(url + '/query', { method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve(JSON.parse(text)));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const f = (n, digits = 0) => n.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const rows = [];
for (const threads of [1, 2, 4]) {
  const startUp = performance.now();
  const db = await createDbServer({ dataDir: DIR, poolSize: threads });
  const url = await listen(db.server);
  const ready = performance.now() - startUp;
  const agent = new http.Agent({ keepAlive: true, maxSockets: REQUESTS });

  await query(agent, url, 'SELECT COUNT(*) FROM users WHERE id = 1');                // 연결 준비
  const start = performance.now();
  const results = await Promise.all(Array.from({ length: REQUESTS }, () => query(agent, url, "SELECT COUNT(*) FROM users WHERE city = '서울'")));
  const total = performance.now() - start;

  const startIndex = performance.now();
  await Promise.all(Array.from({ length: 2000 }, (_, i) => query(agent, url, 'SELECT * FROM users WHERE id = ' + (1 + i * 499))));
  const indexTotal = performance.now() - startIndex;

  rows.push({ threads, ready, total, indexTotal, workers: new Set(results.map((r) => r.worker)).size, count: results[0].results[0].rows[0][0] });
  agent.destroy();
  await db.close();
}

console.log('CPU 코어 ' + os.availableParallelism() + '개, 레코드 ' + f((await fs.promises.readFile(path.join(DIR, 'users.jsonl'))).filter((b) => b === 10).length) + '건\n');
console.log('| 워커 스레드 | 서버 준비 (스레드마다 인덱스 구성) | 선형 탐색 ' + REQUESTS + '개 동시 요청 | 1개일 때 대비 | 인덱스 조회 2,000개 동시 요청 |');
console.log('|---:|---:|---:|---:|---:|');
for (const r of rows) console.log('| ' + r.threads + '개 | ' + f(r.ready) + ' ms | ' + f(r.total) + ' ms | ' + f(rows[0].total / r.total, 2) + '배 빠름 | ' + f(r.indexTotal) + ' ms |');
console.log('\n선형 탐색 결과는 세 경우 모두 ' + f(rows[0].count) + '건으로 같았습니다.');
