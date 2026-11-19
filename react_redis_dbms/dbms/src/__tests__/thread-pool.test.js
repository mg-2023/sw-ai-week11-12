/* rw-lock.js / thread-pool.js 단위 테스트 — 실제 워커 스레드를 띄워 확인한다 */
import { Worker } from 'node:worker_threads';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLockBuffer, createRwLock, LockTimeoutError } from '../rw-lock.js';
import { createThreadPool, PoolBusyError } from '../thread-pool.js';

const ECHO = new URL('./fixtures/echo-worker.js', import.meta.url);
const COUNTER = new URL('./fixtures/counter-worker.js', import.meta.url);
const pool = (size, extra = {}) => createThreadPool({ size, workerFile: ECHO, ...extra });

/* ---------------------------------------------------------------- 읽기-쓰기 잠금 */

test('잠금: 읽기끼리는 함께 들어가고, 읽는 중에는 쓰기가 못 들어간다', () => {
  const lock = createRwLock(createLockBuffer(1), 0);
  assert.equal(lock.tryRead(), true);
  assert.equal(lock.tryRead(), true);
  assert.equal(lock.peek().state, 2);
  assert.equal(lock.tryWrite(), false);
  lock.unlockRead(); lock.unlockRead();
  assert.equal(lock.tryWrite(), true);
});

test('잠금: 쓰는 중에는 읽기도 다른 쓰기도 못 들어가고, 풀면 다시 들어간다', () => {
  const lock = createRwLock(createLockBuffer(1), 0);
  lock.lockWrite();
  assert.equal(lock.peek().state, -1);
  assert.equal(lock.tryRead(), false);
  assert.equal(lock.tryWrite(), false);
  lock.unlockWrite();
  assert.equal(lock.tryRead(), true);
});

test('잠금: 테이블마다 따로다 (한 테이블을 쓰는 중에도 다른 테이블은 쓸 수 있다)', () => {
  const buffer = createLockBuffer(2);
  const a = createRwLock(buffer, 0), b = createRwLock(buffer, 1);
  a.lockWrite();
  assert.equal(b.tryWrite(), true);
  assert.equal(a.tryRead(), false);
});

test('잠금: 정해진 시간 안에 못 잡으면 LockTimeoutError', () => {
  const buffer = createLockBuffer(1);
  createRwLock(buffer, 0).lockWrite();
  const other = createRwLock(buffer, 0, { timeout: 50 });
  assert.throws(() => other.lockRead(), LockTimeoutError);
  assert.throws(() => other.lockWrite(), LockTimeoutError);
  assert.equal(other.peek().waitingWriters, 0);                // 포기한 쓰기는 "기다리는 중" 표시를 지운다
});

test('잠금: 스레드 4개가 쓰기 잠금을 잡고 공유 카운터를 5,000번씩 올리면 정확히 20,000 이 된다', async () => {
  const lockBuffer = createLockBuffer(1), counterBuffer = new SharedArrayBuffer(4);
  const workers = Array.from({ length: 4 }, () => new Worker(COUNTER, { workerData: { lockBuffer, counterBuffer, times: 5000, useLock: true } }));
  await Promise.all(workers.map((w) => new Promise((resolve, reject) => { w.on('exit', resolve); w.on('error', reject); })));
  assert.equal(new Int32Array(counterBuffer)[0], 20000);
  assert.deepEqual(createRwLock(lockBuffer, 0).peek(), { state: 0, waitingWriters: 0 });
});

/* ---------------------------------------------------------------- 스레드 풀 */

test('풀: 일을 맡기면 워커 스레드가 실행하고 결과를 돌려준다', async () => {
  const p = pool(2);
  try {
    await p.ready;
    const result = await p.run({ op: 'echo', value: '안녕' });
    assert.equal(result.echo, '안녕');
    assert.ok(result.threadId > 0);                           // 메인 스레드(0)가 아닌 다른 스레드에서 실행됐다
  } finally { await p.close(); }
});

test('풀: 동시에 맡긴 일은 서로 다른 스레드에서 같은 시간에 실행된다 (병렬)', async () => {
  const p = pool(4);
  try {
    await p.ready;
    const start = Date.now();
    const results = await Promise.all(Array.from({ length: 4 }, () => p.run({ op: 'sleep', ms: 200 })));
    const elapsed = Date.now() - start;
    assert.equal(new Set(results.map((r) => r.threadId)).size, 4);
    assert.ok(elapsed < 600, '200ms 짜리 4개가 ' + elapsed + 'ms 걸렸다 (차례로 했다면 800ms)');
    const latestStart = Math.max(...results.map((r) => r.startedAt)), earliestEnd = Math.min(...results.map((r) => r.finishedAt));
    assert.ok(latestStart < earliestEnd, '네 일의 실행 시간이 겹친다');
  } finally { await p.close(); }
});

test('풀: 워커보다 일이 많으면 대기열에서 기다렸다가 차례로 실행된다', async () => {
  const p = pool(2);
  try {
    await p.ready;
    const jobs = Array.from({ length: 6 }, (_, i) => p.run({ op: 'sleep', ms: 60, value: i }));
    const during = p.stats();
    assert.deepEqual([during.busy, during.queued], [2, 4]);
    const results = await Promise.all(jobs);
    assert.deepEqual(results.map((r) => r.echo), [0, 1, 2, 3, 4, 5]);
    assert.equal(new Set(results.map((r) => r.threadId)).size, 2);    // 스레드는 2개뿐이고 재사용됐다
    const after = p.stats();
    assert.deepEqual([after.busy, after.queued, after.completed], [0, 0, 6]);
  } finally { await p.close(); }
});

test('풀: 대기열이 꽉 차면 PoolBusyError 로 거절한다', async () => {
  const p = pool(1, { maxQueue: 2 });
  try {
    await p.ready;
    const jobs = [p.run({ op: 'sleep', ms: 80 }), p.run({ op: 'echo' }), p.run({ op: 'echo' })];
    await assert.rejects(p.run({ op: 'echo' }), PoolBusyError);
    await Promise.all(jobs);
  } finally { await p.close(); }
});

test('풀: 워커가 오류를 돌려주면 그 일만 실패하고 워커는 계속 쓴다', async () => {
  const p = pool(1);
  try {
    await p.ready;
    await assert.rejects(p.run({ op: 'fail' }), (err) => err.message === '일부러 낸 오류' && err.kind === 'test');
    assert.equal((await p.run({ op: 'echo', value: 1 })).echo, 1);
  } finally { await p.close(); }
});

test('풀: 워커 스레드가 죽으면 그 일은 실패로 알리고, 새 워커를 만들어 다음 일을 처리한다', async () => {
  const p = pool(2);
  try {
    await p.ready;
    const before = p.stats().workers.map((w) => w.threadId);
    await assert.rejects(p.run({ op: 'crash' }), /종료됐습니다|죽었습니다/);
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => p.run({ op: 'echo', value: i })));
    assert.deepEqual(results.map((r) => r.echo), [0, 1, 2, 3]);
    const after = p.stats().workers.map((w) => w.threadId);
    assert.equal(after.length, 2);
    assert.notDeepEqual(after, before);                       // 죽은 자리에 새 스레드가 들어왔다
  } finally { await p.close(); }
});

test('풀: 워커가 시작하다 실패하면 ready 가 실패한다', async () => {
  const p = pool(1, { workerData: { failOnStart: true } });
  await assert.rejects(p.ready, /시작 실패/);
  await p.close();
});

test('풀: 닫은 뒤에는 일을 받지 않고, 기다리던 일은 실패로 알린다', async () => {
  const p = pool(1);
  await p.ready;
  const running = p.run({ op: 'sleep', ms: 30 }).catch(() => 'stopped');
  const waiting = p.run({ op: 'echo' });
  const closing = p.close();
  await assert.rejects(waiting, /닫혔습니다/);
  await closing;
  await running;
  await assert.rejects(p.run({ op: 'echo' }), /닫혔습니다/);
});
