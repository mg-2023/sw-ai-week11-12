/* 테스트 공통 도구: 임시 데이터 폴더에 미니 DBMS · 미니 레디스 서버를 실제로 띄우고 게임 서비스를 만든다 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../../redis/src/store.js';
import { createApiServer, listen, close } from '../../redis/src/api.js';
import { createClient } from '../../redis/src/client.js';
import { createDbServer, listen as listenDb } from '../../dbms/src/api.js';
import { createDb } from '../db.js';
import { createGameService } from '../service.js';

export const SCHEMA_FILE = fileURLToPath(new URL('../schema.json', import.meta.url));

/** schema.json 이 든 임시 데이터 폴더 */
export function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'word-chain-'));
  fs.copyFileSync(SCHEMA_FILE, path.join(dir, 'schema.json'));
  return dir;
}

/**
 * 게임 한 벌을 띄운다. words: 미리 등록할 단어 [['기차'], ['기쁨', true] …]  (두 번째 값이 true 면 끝내기 단어)
 * coin: 첫 라운드의 선공을 정하는 난수 (기본 0 → 플레이어가 먼저). secondMs: 라운드 시간 1초의 길이 (기본 1000. 줄이면 라운드 시간이 빨리 끝난다)
 * random: 상대가 단어를 고를 때 쓰는 난수 (기본 0 → 항상 후보의 첫 번째). randomStart: 시작 단어를 무작위로 제시할지 (기본 false). lives: 목숨 수 (기본 1 → 한 번 지면 판이 끝난다)
 * think: 남은 라운드 시간 → 상대가 생각할 시간 (기본 0 → 기다리지 않고 바로 받아친다)
 */
export async function startGameStack({ words = [], turnMs = 10_000, random = () => 0, wordFiles = null, randomStart = false, lives = 1, secondMs = 1000, coin = () => 0, think = () => 0 } = {}) {
  const dir = makeDataDir();
  const dbServer = await createDbServer({ dataDir: dir, poolSize: 2, maxRows: 100_000 });
  const dbUrl = await listenDb(dbServer.server);
  const store = createStore();
  const redisServer = createApiServer(store);
  const redisUrl = await listen(redisServer);
  const redis = createClient(redisUrl), db = createDb(dbUrl);
  const service = createGameService({ redis, db, turnMs, random, wordFiles, randomStart, lives, secondMs, coin, think });
  for (const [word, finisher] of words) await service.register(word, finisher === true);

  return {
    dir, service, redis, db, store,
    async stop() {
      redis.close();
      db.close();
      await close(redisServer);
      await dbServer.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
