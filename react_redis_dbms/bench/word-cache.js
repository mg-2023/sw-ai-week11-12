/* ======================================================================
 * bench/word-cache.js — 단어 사전 확인: 미니 레디스를 쓸 때와 쓰지 않을 때의 차이
 *
 *   npm run bench                 단어 20만 개
 *   node bench/word-cache.js 500000
 *
 *   ① 가짜 단어 N 개를 SQL 파일로 만들어 미니 DBMS CLI 로 넣는다 (bench-data/ 에 남는다)
 *   ② 미니 DBMS 서버와 미니 레디스 서버를 띄운다
 *   ③ 단어 100개를 3번씩 (모두 300번) 확인한다 — 게임에서 같은 단어가 여러 판에 걸쳐 다시 나오는 상황
 *        캐시 없음 : 매번 DBMS 를 선형 탐색한다
 *        캐시 있음 : 처음 한 번만 DBMS 를 읽고, 다음부터는 미니 레디스에서 꺼낸다
 * ====================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createStore } from '../redis/src/store.js';
import { createApiServer, listen, close } from '../redis/src/api.js';
import { createClient } from '../redis/src/client.js';
import { createCache } from '../redis/src/cache.js';
import { createDbServer, listen as listenDb } from '../dbms/src/api.js';
import { createDb, quote } from '../game/db.js';
import { buildInsertSql } from '../game/import-words.js';

const COUNT = Number(process.argv[2] || 200_000);
const WORDS = 100, ROUNDS = 3;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = path.join(ROOT, 'bench-data'), SQL = path.join(DIR, 'words.sql');
const f = (n, digits = 0) => n.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/* ---------------------------------------------------------------- ① 가짜 단어 넣기 */
// n 번째 단어: n 을 한글 음절 3개로 바꾼다 (서로 다른 n 은 서로 다른 단어가 된다)
const SYLLABLES = 2000;
const wordOf = (n) => [n % SYLLABLES, Math.floor(n / SYLLABLES) % SYLLABLES, Math.floor(n / SYLLABLES / SYLLABLES) % SYLLABLES]
  .map((k) => String.fromCharCode(0xac00 + k * 5)).join('');

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'game', 'schema.json'), path.join(DIR, 'schema.json'));
fs.writeFileSync(SQL, buildInsertSql(Array.from({ length: COUNT }, (_, n) => ({ word: wordOf(n), finisher: false }))));
const insertStart = performance.now();
const cli = spawnSync(process.execPath, [path.join(ROOT, 'dbms', 'cli.js'), SQL, '--data', DIR, '--quiet'], { encoding: 'utf8', maxBuffer: 1 << 28 });
if (cli.status !== 0) { console.error(cli.stderr); process.exit(1); }
const insertMs = performance.now() - insertStart;

/* ---------------------------------------------------------------- ② 서버 띄우기 */
const dbServer = await createDbServer({ dataDir: DIR, poolSize: 4 });
const db = createDb(await listenDb(dbServer.server));
const redisServer = createApiServer(createStore());
const redis = createClient(await listen(redisServer));
const cache = createCache(redis, { ttl: 60_000 });

/* ---------------------------------------------------------------- ③ 비교 */
let dbReads = 0;
async function findInDb(word) {
  dbReads++;
  const result = await db.query('SELECT id FROM words WHERE word = ' + quote(word));
  return { known: result.rowCount > 0 };
}
const targets = Array.from({ length: WORDS }, (_, i) => wordOf(Math.floor((i + 0.5) * COUNT / WORDS)));

async function run(lookup) {
  dbReads = 0;
  const start = performance.now();
  for (let round = 0; round < ROUNDS; round++) {
    for (const word of targets) {
      const found = await lookup(word);
      if (!found.known) throw new Error('찾지 못했습니다: ' + word);
    }
  }
  return { ms: performance.now() - start, dbReads };
}

const without = await run((word) => findInDb(word));
const withCache = await run(async (word) => (await cache.getOrLoad('word:' + word, () => findInDb(word))).value);

const hitStart = performance.now();
for (const word of targets) await redis.get('word:' + word);
const hitMs = (performance.now() - hitStart) / WORDS;

redis.close();
db.close();
await close(redisServer);
await dbServer.close();

const total = WORDS * ROUNDS;
console.log('등록 단어 ' + f(COUNT) + '개 (SQL 파일을 CLI 로 넣는 데 ' + f(insertMs) + ' ms), 단어 확인 ' + total + '번 (단어 ' + WORDS + '개 × ' + ROUNDS + '번)\n');
console.log('| | 걸린 시간 | 확인 한 번 평균 | DBMS 를 읽은 횟수 |');
console.log('|---|---:|---:|---:|');
console.log('| 미니 레디스 없이 | ' + f(without.ms) + ' ms | ' + f(without.ms / total, 2) + ' ms | ' + without.dbReads + ' |');
console.log('| 미니 레디스를 캐시로 | ' + f(withCache.ms) + ' ms | ' + f(withCache.ms / total, 2) + ' ms | ' + withCache.dbReads + ' |');
console.log('\n전체 시간은 약 ' + f(without.ms / withCache.ms, 1) + '배 빨라졌습니다.');
console.log('캐시에 있는 단어 한 개를 꺼내는 데는 평균 ' + f(hitMs, 2) + ' ms, DBMS 선형 탐색 한 번은 평균 ' + f(without.ms / total, 2) + ' ms 입니다.');
