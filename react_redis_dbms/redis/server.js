/* ======================================================================
 * server.js — 미니 레디스 서버 실행 (진입점)
 *
 *   node server.js                         기본: 포트 6380, 기록 파일 data/mini-redis.aof, fsync everysec
 *   PORT=7000 AOF=./my.aof FSYNC=always node server.js
 *   AOF=off node server.js                 파일에 기록하지 않음 (메모리 전용)
 *
 *   저장소·만료·기록·API 로직은 src/ 아래 모듈에 있고, 여기서는 그것들을 연결해 서버를 띄우기만 한다.
 *     src/hash-table.js  직접 구현한 해시 테이블
 *     src/store.js       키-값 저장소 (만료, 무효화)
 *     src/aof.js         명령 기록 파일로 복구
 *     src/api.js         HTTP API
 * ====================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { createStore, startSweeper } from './src/store.js';
import { openPersistentStore } from './src/aof.js';
import { createApiServer, listen, close } from './src/api.js';

const port = Number(process.env.PORT || 6380);
const aofPath = process.env.AOF || 'data/mini-redis.aof';
const fsync = process.env.FSYNC || 'everysec';

let store, persistent = null;
if (aofPath === 'off') {
  store = createStore();
  console.log('기록 파일 없이 시작합니다 (서버를 끄면 데이터가 사라집니다)');
} else {
  fs.mkdirSync(path.dirname(aofPath), { recursive: true });
  persistent = openPersistentStore(aofPath, { fsync });
  store = persistent.store;
  console.log('기록 파일 ' + aofPath + ' 에서 키 ' + persistent.recovered + '개를 복구했습니다' + (persistent.broken ? ' (잘린 마지막 줄은 버림)' : ''));
}

const stopSweeper = startSweeper(store);                     // 만료된 키를 0.1초마다 조금씩 청소
const server = createApiServer(store);
const address = await listen(server, port);
console.log('미니 레디스 서버: ' + address + '  (fsync: ' + (persistent ? fsync : '-') + ')');

/** Ctrl+C: 남은 기록을 디스크에 쓰고 끝낸다 */
async function shutdown() {
  stopSweeper();
  await close(server);
  if (persistent) persistent.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
