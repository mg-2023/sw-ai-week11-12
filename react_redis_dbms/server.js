/* ======================================================================
 * server.js — 끝말잇기를 한 번에 켠다 (npm start)
 *
 *   ① 단어 파일(words/*.txt)의 새 단어를 미니 DBMS 에 넣는다   (SQL 파일을 만들어 dbms/cli.js 로 실행)
 *   ② 미니 DBMS API 서버   http://127.0.0.1:4000   데이터: data/db/
 *   ③ 미니 레디스 서버     http://127.0.0.1:6380   기록 파일: data/redis.aof
 *   ④ 게임 서버            http://127.0.0.1:3000   ← 브라우저로 여는 주소
 *
 *   게임 서버는 ②와 ③을 HTTP 로 호출한다. 즉 두 서버를 "외부 프로그램"이 쓰는 방식 그대로 쓴다.
 *   포트 바꾸기   : PORT=3100 REDIS_PORT=6381 DB_PORT=4001 node server.js
 *   폴더 바꾸기   : node server.js --data <데이터 폴더> --words <단어 파일 폴더>   (시험용 사전으로 켤 때)
 * ====================================================================== */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSweeper } from './redis/src/store.js';
import { openPersistentStore } from './redis/src/aof.js';
import { createApiServer, listen, close } from './redis/src/api.js';
import { createClient } from './redis/src/client.js';
import { createDbServer, listen as listenDb } from './dbms/src/api.js';
import { createDb } from './game/db.js';
import { createGameService } from './game/service.js';
import { createRoomService } from './game/rooms.js';
import { createGameServer } from './game/server.js';
import { createAuth } from './game/auth.js';
import { ADMIN_FILE } from './game/set-admin.js';
import { importWords, describeImport, pathsFor } from './game/import-words.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 3000);
const redisPort = Number(process.env.REDIS_PORT || 6380);
const dbPort = Number(process.env.DB_PORT || 4000);

const option = (name) => { const i = process.argv.indexOf(name); return i === -1 ? undefined : process.argv[i + 1]; };
const paths = pathsFor(option('--data'), option('--words'));

// ① 단어 파일 → 미니 DBMS
const imported = importWords(paths);

// ② 미니 DBMS API 서버 (한 번에 돌려주는 레코드 수를 넉넉히: 한 글자로 시작하는 단어가 많을 수 있다)
const dbServer = await createDbServer({ dataDir: paths.dbDir, maxRows: 100_000 });
const dbUrl = await listenDb(dbServer.server, dbPort);

// ③ 미니 레디스 서버
const persistent = openPersistentStore(paths.aofFile);
const stopSweeper = startSweeper(persistent.store);
const redisServer = createApiServer(persistent.store);
const redisUrl = await listen(redisServer, redisPort);

// ④ 게임 서버
const redis = createClient(redisUrl), db = createDb(dbUrl);
const service = createGameService({ redis, db, wordFiles: paths.wordFiles });
const cleared = await service.clearWordCache();           // 단어 파일이 바뀌었을 수 있으니 단어 캐시는 새로 시작한다
const grading = service.prepareGrades();                  // 상대가 단어 등급을 알도록 사전을 한 번 세어 둔다 (첫 차례가 잠금 5초 안에 끝나게 미리)
const auth = createAuth({ redis, adminFile: ADMIN_FILE });   // 단어 등록은 제작자 로그인이 필요하다
const rooms = createRoomService({ redis, db, dictionary: service.dictionary });   // 같이 하는 방 (npm run room 으로 켜면 같은 와이파이에서 들어올 수 있다)
const gameServer = createGameServer({ service, auth, rooms, webDir: path.join(ROOT, 'web'), libDir: path.join(ROOT, 'mini-react') });
const gameUrl = await listen(gameServer, port, process.env.HOST || '127.0.0.1');   // HOST=0.0.0.0 이면 같은 와이파이의 다른 기기도 접속한다 (npm run room)

const wordCount = (await db.tables()).find((t) => t.table === 'words').rows;
console.log('끝말잇기      : ' + gameUrl + '   ← 브라우저로 여세요');
console.log('미니 레디스   : ' + redisUrl + '   (복구한 키 ' + persistent.recovered + '개, 단어 캐시 ' + cleared + '개 지움)');
console.log('미니 DBMS     : ' + dbUrl + '   (등록된 단어 기록 ' + wordCount + '건)');
console.log(describeImport(imported));
grading.then(
  (counts) => console.log('상대 등급 표  : 첫 글자 ' + counts.size + '종류 (사전을 한 번 세어 둠)'),
  (err) => console.log('상대 등급 표를 만들지 못했습니다 (' + err.message + '). 첫 차례에 다시 셉니다.'));
if (!auth.configured()) console.log('\n제작자 계정이 없어 화면에서 단어를 등록할 수 없습니다. npm run admin 으로 계정을 만드세요.');
if (wordCount === 0) console.log('\n사전이 비어 있습니다. words/words.txt 와 words/finishers.txt 에 단어를 채우고 다시 켜거나, 화면의 "단어 등록"에서 넣으세요.');

async function shutdown() {
  if (typeof stopSweeper === 'function') stopSweeper();
  redis.close();
  db.close();
  await close(gameServer);
  await close(redisServer);
  await dbServer.close();
  persistent.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
