/* 스레드 풀 테스트용 워커: 시키는 대로 답하거나, 잠깐 멈추거나, 죽는다 */
import { parentPort, threadId, workerData } from 'node:worker_threads';

if (workerData.failOnStart) throw new Error('시작 실패');
parentPort.postMessage({ type: 'ready' });

parentPort.on('message', ({ id, payload }) => {
  if (payload.op === 'crash') process.exit(1);
  if (payload.op === 'fail') { parentPort.postMessage({ id, ok: false, error: { message: '일부러 낸 오류', kind: 'test' } }); return; }
  const startedAt = Date.now();
  if (payload.op === 'sleep') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, payload.ms);   // 스레드를 ms 동안 붙잡아 둔다
  parentPort.postMessage({ id, ok: true, result: { echo: payload.value, threadId, startedAt, finishedAt: Date.now() } });
});
