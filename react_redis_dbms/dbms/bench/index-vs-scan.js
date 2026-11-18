/* ======================================================================
 * bench/index-vs-scan.js — 100만 건을 넣고 인덱스 검색과 선형 탐색의 속도를 비교한다 (Phase 2)
 *
 *   npm run bench                 100만 건
 *   node bench/index-vs-scan.js 2000000
 *
 *   ① INSERT 문 SQL 파일을 만든다 (bench/generate.js)
 *   ② 그 파일을 cli.js 에 넘겨 실행한다 — Phase 1 의 SQL 처리기를 그대로 쓴다
 *   ③ 엔진을 다시 열어(파일에서 인덱스 재구성) 같은 레코드를 두 가지 방법으로 찾는다
 *        WHERE id = ?      B+ 트리 인덱스
 *        WHERE name = ?    선형 탐색 (name 은 id 마다 하나뿐이라 같은 레코드를 찾는다)
 *
 *   데이터는 bench-data/ 에 남는다. (bench/thread-pool.js 와 server.js 가 다시 쓴다)
 * ====================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../src/engine.js';
import { generateSql } from './generate.js';

const COUNT = Number(process.argv[2] || 1_000_000);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = path.join(ROOT, 'bench-data'), SQL = path.join(DIR, 'insert.sql'), TABLE = path.join(DIR, 'users.jsonl');
const f = (n, digits = 0) => n.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const time = (fn) => { const start = performance.now(); const value = fn(); return [performance.now() - start, value]; };

/* ---------------------------------------------------------------- ① ② 데이터 넣기 */
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(path.join(DIR, 'schema.json'), JSON.stringify({ users: { id: 'int', name: 'text', age: 'int', city: 'text' } }, null, 2));
fs.rmSync(TABLE, { force: true });

const [tGenerate] = time(() => generateSql(SQL, COUNT));
const [tInsert, cli] = time(() => spawnSync(process.execPath, [path.join(ROOT, 'cli.js'), SQL, '--data', DIR, '--quiet'], { encoding: 'utf8', maxBuffer: 1 << 28 }));
if (cli.status !== 0) { console.error(cli.stderr); process.exit(1); }

/* ---------------------------------------------------------------- ③ 조회 비교 */
const [tOpen, db] = time(() => { const engine = createEngine(DIR); engine.info(); return engine; });
const info = db.info()[0];
const one = (sql) => db.execute(sql)[0];

// 찾을 id: 앞, 가운데, 끝, 그리고 무작위
const ids = [1, Math.floor(COUNT / 2), COUNT, ...Array.from({ length: 997 }, () => 1 + Math.floor(Math.random() * COUNT))];
const scanIds = [1, Math.floor(COUNT / 4), Math.floor(COUNT / 2), Math.floor(COUNT * 3 / 4), COUNT];

for (const id of scanIds) {                                   // 두 방법이 같은 레코드를 돌려주는지 먼저 확인
  const a = one('SELECT * FROM users WHERE id = ' + id), b = one("SELECT * FROM users WHERE name = 'user" + id + "'");
  if (a.plan !== 'INDEX_POINT' || b.plan !== 'FULL_SCAN' || JSON.stringify(a.rows) !== JSON.stringify(b.rows) || a.rows.length !== 1) throw new Error('결과가 다릅니다: id ' + id);
}

const [tIndexAll] = time(() => { for (const id of ids) one('SELECT * FROM users WHERE id = ' + id); });
const scanTimes = scanIds.map((id) => time(() => one("SELECT * FROM users WHERE name = 'user" + id + "'"))[0]);
const tIndex = tIndexAll / ids.length, tScan = scanTimes.reduce((a, b) => a + b, 0) / scanTimes.length;

const from = Math.floor(COUNT / 2);
const [tRange, range] = time(() => one('SELECT * FROM users WHERE id >= ' + from + ' AND id < ' + (from + 100)));
const [tCount, counted] = time(() => one('SELECT COUNT(*) FROM users WHERE age = 30'));
db.close();

console.log('레코드 ' + f(COUNT) + '건 (테이블 파일 ' + f(fs.statSync(TABLE).size / 1024 / 1024, 1) + ' MB, B+ 트리 높이 ' + info.indexHeight + ')\n');
console.log('| 단계 | 걸린 시간 |');
console.log('|---|---:|');
console.log('| INSERT 문 SQL 파일 만들기 (' + f(fs.statSync(SQL).size / 1024 / 1024, 1) + ' MB) | ' + f(tGenerate) + ' ms |');
console.log('| `node cli.js insert.sql` 로 ' + f(COUNT) + '건 INSERT (파싱 + 파일 저장 + 인덱스 등록) | ' + f(tInsert) + ' ms |');
console.log('| 엔진을 다시 열 때 파일에서 인덱스 재구성 | ' + f(tOpen) + ' ms |');
console.log('');
console.log('| 조회 | 읽는 방법 | 평균 걸린 시간 |');
console.log('|---|---|---:|');
console.log('| `WHERE id = ?` (' + f(ids.length) + '번 평균) | B+ 트리 인덱스 | ' + f(tIndex, 4) + ' ms |');
console.log("| `WHERE name = 'user?'` (" + scanIds.length + '번 평균) | 선형 탐색 | ' + f(tScan, 1) + ' ms |');
console.log('| `WHERE id >= ? AND id < ?` (' + range.rowCount + '건) | B+ 트리 범위 검색 | ' + f(tRange, 3) + ' ms |');
console.log('| `COUNT(*) WHERE age = 30` (' + f(counted.rows[0][0]) + '건) | 선형 탐색 | ' + f(tCount, 1) + ' ms |');
console.log('');
console.log('같은 레코드 한 건을 찾을 때 인덱스 검색이 선형 탐색보다 약 ' + f(tScan / tIndex) + '배 빠릅니다.');
console.log('선형 탐색은 조건에 맞는 레코드가 더 있는지 알 수 없어서, 찾는 레코드가 어디에 있든 파일을 끝까지 읽습니다.');
