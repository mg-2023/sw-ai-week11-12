/* aof.js 단위 테스트 — 서버가 꺼졌다 켜져도 데이터가 남는가
 *
 *   "서버를 끈다" = 저장소 객체를 버린다. "다시 켠다" = 같은 파일로 openPersistentStore 를 다시 부른다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openPersistentStore, readRecords } from '../aof.js';

let dir, file;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-redis-')); file = path.join(dir, 'test.aof'); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const lineCount = () => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;

test('다시 켜면 저장했던 값이 그대로 있다', () => {
  const first = openPersistentStore(file, { fsync: 'always' });
  first.store.set('a', 1);
  first.store.set('user:1', { name: '철수' });
  first.store.incr('a');
  first.close();

  const second = openPersistentStore(file);
  assert.equal(second.recovered, 2);
  assert.equal(second.store.get('a'), 2);
  assert.deepEqual(second.store.get('user:1'), { name: '철수' });
  second.close();
});

test('삭제 · 전체 삭제도 복구된다 (지운 값이 되살아나지 않는다)', () => {
  const first = openPersistentStore(file);
  first.store.set('a', 1); first.store.set('b', 2); first.store.del('a');
  first.close();
  const second = openPersistentStore(file);
  assert.equal(second.store.get('a'), null);
  assert.equal(second.store.get('b'), 2);
  second.store.flushAll();
  second.close();
  const third = openPersistentStore(file);
  assert.equal(third.store.size, 0);
  third.close();
});

test('강제 종료: 다른 프로세스가 값을 쓰고 정리 없이 죽어도(SIGKILL) 이미 쓴 기록으로 복구된다', () => {
  const script = `
    import { openPersistentStore } from ${JSON.stringify(new URL('../aof.js', import.meta.url).href)};
    const { store } = openPersistentStore(${JSON.stringify(file)}, { fsync: 'always' });
    store.set('a', '살아남음');
    store.set('n', 41);
    store.incr('n');
    process.kill(process.pid, 'SIGKILL');          // close() 도, 종료 처리도 없이 즉시 죽는다
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script]);
  assert.notEqual(child.status, 0);                 // 정상 종료가 아니다

  const second = openPersistentStore(file);
  assert.equal(second.store.get('a'), '살아남음');
  assert.equal(second.store.get('n'), 42);
  second.close();
});

test('만료: 꺼져 있던 시간도 보관 기간에 포함된다', () => {
  const clock = { t: 1000 };
  const first = openPersistentStore(file, { now: () => clock.t });
  first.store.set('short', 1, { ttl: 500 });
  first.store.set('long', 2, { ttl: 5000 });
  first.close();

  clock.t += 1000;                                // 1초 동안 꺼져 있었다
  const second = openPersistentStore(file, { now: () => clock.t });
  assert.equal(second.store.get('short'), null);  // 꺼져 있는 동안 만료됨
  assert.equal(second.store.ttl('long'), 4000);   // 5000 이 아니라 4000 남음
  second.close();
});

test('마지막 줄이 쓰다가 잘려 있어도 그 앞까지는 복구한다', () => {
  const first = openPersistentStore(file);
  first.store.set('a', 1); first.store.set('b', 2);
  first.close();
  fs.appendFileSync(file, '{"op":"set","key":"c","val');   // 쓰는 도중 전원이 나간 상황

  const second = openPersistentStore(file);
  assert.equal(second.broken, true);
  assert.equal(second.store.get('a'), 1);
  assert.equal(second.store.get('b'), 2);
  assert.equal(second.store.get('c'), null);
  second.store.set('d', 4);                       // 그 뒤로도 정상적으로 기록된다
  second.close();
  const third = openPersistentStore(file);
  assert.equal(third.broken, false);
  assert.equal(third.store.get('d'), 4);
  third.close();
});

test('파일 줄이기: 같은 키를 1000번 바꿔도 다시 켜면 살아 있는 키만큼만 남는다', () => {
  const first = openPersistentStore(file);
  for (let i = 0; i < 1000; i++) first.store.set('counter', i);
  first.store.set('gone', 1); first.store.del('gone');
  first.close();
  assert.equal(lineCount(), 1002);

  const second = openPersistentStore(file);        // 복구 뒤 자동으로 줄인다
  assert.equal(lineCount(), 1);
  assert.equal(second.store.get('counter'), 999);
  second.store.set('counter', 1000); second.store.set('counter', 1001);
  second.compact();                                // 실행 중에도 줄일 수 있다
  assert.equal(lineCount(), 1);
  second.close();
  assert.deepEqual(readRecords(file).records, [{ op: 'set', key: 'counter', value: 1001, expireAt: null }]);
});

test('엣지: 파일이 없으면 빈 저장소로 시작하고 파일을 만든다', () => {
  const p = openPersistentStore(file);
  assert.equal(p.recovered, 0);
  assert.equal(p.broken, false);
  assert.equal(fs.existsSync(file), true);
  p.close();
});

test('엣지: 줄바꿈·따옴표·한글이 들어간 값도 한 줄로 기록되어 그대로 복구된다', () => {
  const value = { text: '첫 줄\n둘째 줄 "따옴표" \\ 역슬래시', emoji: '😀' };
  const first = openPersistentStore(file);
  first.store.set('키 "이름"\n', value);
  first.close();
  assert.equal(lineCount(), 1);
  const second = openPersistentStore(file);
  assert.deepEqual(second.store.get('키 "이름"\n'), value);
  second.close();
});
