/* ======================================================================
 * db-worker.js — 워커 스레드 한 개가 실행하는 코드
 *
 *   스레드마다 엔진(파서 + 실행기 + B+ 트리 인덱스)을 하나씩 갖는다.
 *   메인 스레드가 SQL 을 보내면 실행하고 결과를 돌려준다. 스레드끼리는 테이블 파일과 잠금 메모리만 함께 쓴다.
 *
 *   workerData : { dataDir, lockBuffer, maxRows }
 * ====================================================================== */

import { parentPort, workerData, threadId } from 'node:worker_threads';
import { createEngine } from './engine.js';
import { SqlError } from './tokenizer.js';
import { LockTimeoutError } from './rw-lock.js';

const engine = createEngine(workerData.dataDir, { lockBuffer: workerData.lockBuffer, maxRows: workerData.maxRows, repair: false });
engine.info();                                               // 모든 테이블을 미리 열어 인덱스를 만들어 둔다
parentPort.postMessage({ type: 'ready' });

parentPort.on('message', ({ id, payload }) => {
  const startedAt = Date.now();
  try {
    const results = payload.op === 'info' ? engine.info() : engine.execute(payload.sql);
    parentPort.postMessage({ id, ok: true, result: { results, threadId, startedAt, finishedAt: Date.now() } });
  } catch (err) {
    const kind = err instanceof SqlError ? 'sql' : err instanceof LockTimeoutError ? 'busy' : 'internal';
    parentPort.postMessage({ id, ok: false, error: { message: err.message, kind } });
  }
});
