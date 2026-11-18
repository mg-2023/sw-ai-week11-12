/* ======================================================================
 * thread-pool.js — 스레드 풀 (worker_threads)
 *
 *   스레드를 요청마다 새로 만들면 만드는 비용이 크고, 요청이 몰리면 스레드가 끝없이 늘어난다.
 *   그래서 워커 스레드를 size 개만 미리 만들어 두고 계속 재사용한다.
 *
 *     run(payload)
 *       쉬는 워커가 있으면 → 그 워커에게 바로 맡긴다
 *       모두 일하는 중이면 → 대기열(queue)에 넣는다. 워커가 일을 끝내면 대기열 맨 앞의 일을 가져간다
 *       대기열도 꽉 찼으면 → PoolBusyError (서버는 503 으로 응답한다)
 *
 *   워커와 주고받는 메시지
 *     워커 → 메인 : { type: 'ready' }                      준비 완료 (한 번)
 *     메인 → 워커 : { id, payload }                        일 맡기기
 *     워커 → 메인 : { id, ok: true, result } | { id, ok: false, error }
 *
 *   워커가 죽으면: 맡고 있던 일은 실패로 알리고, 새 워커를 만들어 자리를 채운다.
 *   이 모듈은 DB 를 모른다. 어떤 일을 하는지는 workerFile 이 정한다.
 * ====================================================================== */

import { Worker } from 'node:worker_threads';

/** 대기열이 꽉 차서 일을 받을 수 없을 때 */
export class PoolBusyError extends Error {}

export function createThreadPool({ size, workerFile, workerData = {}, maxQueue = 1000 }) {
  const slots = [];                  // { worker, threadId, task: 지금 하는 일 | null, ready, completed }
  const queue = [];                  // 워커를 기다리는 일들 { id, payload, resolve, reject }
  let nextId = 1, closed = false;
  let readyCount = 0, resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });

  /** 쉬는 워커에게 대기열의 일을 맡긴다 */
  function dispatch() {
    for (const slot of slots) {
      if (queue.length === 0) return;
      if (!slot.ready || slot.task) continue;
      slot.task = queue.shift();
      slot.worker.postMessage({ id: slot.task.id, payload: slot.task.payload });
    }
  }

  /** slots[i] 자리에 워커 스레드를 만든다 */
  function spawn(i) {
    const worker = new Worker(workerFile, { workerData });
    const slot = { worker, threadId: worker.threadId, task: null, ready: false, completed: slots[i]?.completed ?? 0 };
    slots[i] = slot;

    worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        slot.ready = true;
        if (++readyCount === size) resolveReady();
        dispatch();
        return;
      }
      const task = slot.task;
      if (!task || task.id !== msg.id) return;
      slot.task = null;
      slot.completed++;
      if (msg.ok) task.resolve(msg.result); else task.reject(Object.assign(new Error(msg.error.message), msg.error));
      dispatch();                                            // 일이 끝났으니 다음 일을 가져간다
    });

    worker.on('error', (err) => {
      if (!slot.ready) rejectReady(err);                     // 시작하다 죽었다 (스키마 없음 등)
      if (slot.task) { slot.task.reject(new Error('워커 스레드가 죽었습니다: ' + err.message)); slot.task = null; }
    });

    worker.on('exit', () => {
      if (closed || slots[i] !== slot) return;
      if (slot.task) { slot.task.reject(new Error('워커 스레드가 일을 끝내지 못하고 종료됐습니다')); slot.task = null; }
      if (slot.ready) { readyCount--; spawn(i); }            // 자리를 새 워커로 채운다
    });
  }

  for (let i = 0; i < size; i++) spawn(i);

  return {
    size,
    /** 모든 워커가 준비되면 끝나는 Promise */
    ready,

    /** 일을 맡긴다. 워커가 돌려준 결과로 끝나는 Promise */
    run(payload) {
      return new Promise((resolve, reject) => {
        if (closed) { reject(new Error('스레드 풀이 닫혔습니다')); return; }
        if (queue.length >= maxQueue) { reject(new PoolBusyError('대기 중인 요청이 너무 많습니다 (' + maxQueue + '개)')); return; }
        queue.push({ id: nextId++, payload, resolve, reject });
        dispatch();
      });
    },

    /** 현재 상태 */
    stats() {
      return {
        size,
        busy: slots.filter((s) => s.task).length,
        queued: queue.length,
        completed: slots.reduce((sum, s) => sum + s.completed, 0),
        workers: slots.map((s) => ({ threadId: s.threadId, busy: s.task !== null, completed: s.completed })),
      };
    },

    /** 모든 워커를 끝낸다. 기다리던 일과 실행 중이던 일은 실패로 알린다 */
    async close() {
      closed = true;
      for (const task of queue.splice(0)) task.reject(new Error('스레드 풀이 닫혔습니다'));
      await Promise.all(slots.map((s) => s.worker.terminate()));
      for (const slot of slots) {                            // 실행 중이던 일도 끝내지 못했으니 실패로 알린다
        if (slot.task) { slot.task.reject(new Error('스레드 풀이 닫혔습니다')); slot.task = null; }
      }
    },
  };
}
