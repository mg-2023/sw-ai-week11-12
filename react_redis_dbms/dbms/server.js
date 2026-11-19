/* ======================================================================
 * server.js — 미니 DBMS API 서버 실행 (Phase 3 진입점)
 *
 *   node server.js                                   포트 4000, 데이터 폴더 ./data, 워커 스레드 4개(코어가 적으면 그만큼)
 *   PORT=5000 DATA=./bench-data THREADS=8 node server.js
 *
 *   서버 구성은 src/api.js 에 있고, 여기서는 설정을 읽어 띄우기만 한다.
 * ====================================================================== */

import os from 'node:os';
import { createDbServer, listen } from './src/api.js';

const port = Number(process.env.PORT || 4000);
const dataDir = process.env.DATA || './data';
const poolSize = Number(process.env.THREADS || Math.min(4, os.availableParallelism()));

const started = Date.now();
const db = await createDbServer({ dataDir, poolSize });
const address = await listen(db.server, port);
const tables = (await db.pool.run({ op: 'info' })).results;

console.log('미니 DBMS API 서버: ' + address);
console.log('워커 스레드 ' + poolSize + '개 준비 (' + (Date.now() - started) + 'ms, 스레드마다 인덱스를 만들었습니다)');
for (const t of tables) console.log('  ' + t.table + ': ' + t.rows.toLocaleString('ko-KR') + '건, B+ 트리 높이 ' + t.indexHeight);
console.log('');
console.log('예: curl -X POST ' + address + '/query -H "content-type: application/json" -d "{\\"sql\\":\\"SELECT * FROM users WHERE id = 1\\"}"');

async function shutdown() {
  await db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
