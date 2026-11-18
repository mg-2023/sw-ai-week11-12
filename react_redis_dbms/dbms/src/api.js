/* ======================================================================
 * api.js — 미니 DBMS API 서버: 외부 클라이언트가 HTTP 로 SQL 을 실행한다
 *
 *   POST /query    SQL 실행. 본문은 { "sql": "…" } (JSON) 또는 SQL 글자 그대로 (text/plain)
 *                    → 200 { results: [문장별 결과…], worker: 실행한 스레드 번호, elapsedMs }
 *                    → 400 { error }   SQL 오류 (문법, 없는 테이블, 타입 불일치 등)
 *   GET  /tables   테이블 목록, 컬럼, 레코드 수
 *   GET  /stats    스레드 풀 상태 (일하는 워커 수, 대기 중인 요청 수, 워커별 처리 건수)
 *   GET  /health   서버가 살아 있는지
 *
 *   구조
 *     메인 스레드  : HTTP 요청을 받고 응답을 보내는 일만 한다. 데이터를 직접 건드리지 않는다
 *     스레드 풀    : 요청마다 워커 스레드 하나를 배정해 SQL 을 실행한다 (thread-pool.js + db-worker.js)
 *     내부 DB 엔진 : 워커마다 하나씩. Phase 1 의 SQL 처리기 + Phase 2 의 B+ 트리 인덱스 (engine.js)
 *
 *   여러 워커가 같은 테이블을 동시에 다뤄도 되도록 테이블마다 읽기-쓰기 잠금을 둔다 (rw-lock.js).
 * ====================================================================== */

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadSchema } from './engine.js';
import { repairTableFile } from './table.js';
import { createLockBuffer } from './rw-lock.js';
import { createThreadPool, PoolBusyError } from './thread-pool.js';

const MAX_BODY = 8 * 1024 * 1024;    // 요청 본문 최대 8MB

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new HttpError(413, '본문이 너무 큽니다 (최대 8MB)')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/** 요청 본문에서 SQL 을 꺼낸다 */
function extractSql(req, body) {
  let sql = body;
  if ((req.headers['content-type'] || '').includes('application/json')) {
    try { sql = JSON.parse(body).sql; } catch (e) { throw new HttpError(400, '본문이 올바른 JSON 이 아닙니다'); }
  }
  if (typeof sql !== 'string' || sql.trim() === '') throw new HttpError(400, '실행할 SQL 이 없습니다. { "sql": "SELECT …" } 형태로 보내세요');
  return sql;
}

/**
 * API 서버를 만든다. (listen 은 호출한 쪽이 한다)
 *   dataDir  : schema.json 과 테이블 파일이 있는 폴더
 *   poolSize : 워커 스레드 수
 *   maxRows  : SELECT 한 번이 돌려주는 최대 레코드 수
 * 반환: { server, pool, close() }
 */
export async function createDbServer({ dataDir, poolSize = Math.min(4, os.availableParallelism()), maxRows = 1000, maxQueue = 1000 }) {
  const schema = loadSchema(dataDir);
  for (const table of Object.keys(schema)) repairTableFile(path.join(dataDir, table + '.jsonl'));   // 워커들이 열기 전에 한 번만

  const pool = createThreadPool({
    size: poolSize,
    maxQueue,
    workerFile: new URL('./db-worker.js', import.meta.url),
    workerData: { dataDir, maxRows, lockBuffer: createLockBuffer(Object.keys(schema).length) },
  });
  await pool.ready;

  async function handle(req) {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/health') return [200, { ok: true }];
    if (pathname === '/stats') return [200, pool.stats()];
    if (pathname === '/tables') {
      if (req.method !== 'GET') throw new HttpError(405, '지원하지 않는 메서드입니다');
      return [200, { tables: (await pool.run({ op: 'info' })).results }];
    }
    if (pathname === '/query') {
      if (req.method !== 'POST') throw new HttpError(405, 'SQL 은 POST 로 보내세요');
      const sql = extractSql(req, await readBody(req));
      const done = await pool.run({ sql });                  // 여기서 워커 스레드 하나가 배정된다
      return [200, { results: done.results, worker: done.threadId, elapsedMs: done.finishedAt - done.startedAt, startedAt: done.startedAt, finishedAt: done.finishedAt }];
    }
    throw new HttpError(404, '없는 경로입니다');
  }

  const server = http.createServer(async (req, res) => {
    let status, result;
    try {
      [status, result] = await handle(req);
    } catch (err) {
      if (err instanceof HttpError) status = err.status;
      else if (err instanceof PoolBusyError || err.kind === 'busy') status = 503;
      else if (err.kind === 'sql') status = 400;
      else status = 500;
      result = { error: err.message };
    }
    const text = JSON.stringify(result);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  });

  return {
    server,
    pool,
    async close() {
      await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
      await pool.close();
    },
  };
}

/** 서버를 port 에서 듣게 한다 (0 이면 빈 포트). 실제 주소를 돌려준다 */
export function listen(server, port = 0, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host, backlog: 4096 }, () => resolve('http://' + host + ':' + server.address().port));
  });
}
