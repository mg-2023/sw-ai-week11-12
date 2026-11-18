/* 기능 테스트 — 외부에서 HTTP API 로 미니 레디스를 쓰는 데 문제가 없는가
 *
 *   실제로 서버를 띄우고(빈 포트), client.js 와 fetch 로 요청을 보낸다.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createStore, startSweeper } from '../store.js';
import { createApiServer, listen, close } from '../api.js';
import { createClient, RedisError } from '../client.js';

let server, url, redis, store, stopSweeper;
before(async () => {
  store = createStore();
  stopSweeper = startSweeper(store, 10);
  server = createApiServer(store);
  url = await listen(server);
  redis = createClient(url);
});
after(async () => { stopSweeper(); await close(server); });

const raw = (method, path, body) => fetch(url + path, { method, body, headers: body ? { 'content-type': 'application/json' } : undefined });

test('저장 → 조회 → 삭제', async () => {
  assert.equal(await redis.set('greeting', '안녕'), true);
  assert.equal(await redis.get('greeting'), '안녕');
  assert.equal(await redis.del('greeting'), 1);
  assert.equal(await redis.get('greeting'), null);
  assert.equal(await redis.del('greeting'), 0);
});

test('객체·배열·숫자 값이 JSON 으로 오가도 그대로다', async () => {
  const value = { id: 1, name: '철수', tags: ['a', 'b'], nested: { score: 1000 } };
  await redis.set('obj', value);
  await redis.set('num', 0);
  assert.deepEqual(await redis.get('obj'), value);
  assert.equal(await redis.get('num'), 0);
});

test('HTTP 응답 모양: 조회는 200 { key, value, ttl }, 없는 키는 404', async () => {
  await redis.set('shape', 1);
  const ok = await raw('GET', '/keys/shape');
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await ok.json(), { key: 'shape', value: 1, ttl: -1 });
  const missing = await raw('GET', '/keys/no-such-key');
  assert.equal(missing.status, 404);
  assert.ok((await missing.json()).error);
});

test('만료: 보관 기간이 지난 값을 요청하면 404 (null) 이고, 저장소에서도 지워진다', async () => {
  await redis.set('temp', 'x', { ttl: 60 });
  assert.equal(await redis.get('temp'), 'x');
  const ttl = await redis.ttl('temp');
  assert.ok(ttl > 0 && ttl <= 60);
  await sleep(120);
  assert.equal(await redis.get('temp'), null);
  assert.equal(await redis.ttl('temp'), -2);
});

test('만료: 아무도 조회하지 않아도 주기 삭제가 지운다', async () => {
  for (let i = 0; i < 30; i++) await redis.set('sweep:' + i, i, { ttl: 30 });
  await sleep(200);
  assert.equal(store.keys('sweep:').length, 0);
  assert.equal(store.info().keysWithTtl, 0);
});

test('expire / persist', async () => {
  await redis.set('e', 1);
  assert.equal(await redis.expire('e', 10_000), true);
  assert.ok(await redis.ttl('e') > 9000);
  assert.equal(await redis.persist('e'), true);
  assert.equal(await redis.ttl('e'), -1);
  assert.equal(await redis.expire('없는 키', 1000), false);
});

test('nx: 이미 있는 키면 409 이고 값이 바뀌지 않는다', async () => {
  assert.equal(await redis.set('lock', 'A', { nx: true }), true);
  assert.equal(await redis.set('lock', 'B', { nx: true }), false);
  assert.equal(await redis.get('lock'), 'A');
});

test('무효화: 접두사로 묶어 지우기, 전체 지우기', async () => {
  await redis.flushAll();
  await redis.set('post:1', 1); await redis.set('post:2', 2); await redis.set('user:1', 3);
  assert.deepEqual((await redis.keys('post:')).sort(), ['post:1', 'post:2']);
  assert.equal(await redis.delByPrefix('post:'), 2);
  assert.deepEqual(await redis.keys(), ['user:1']);
  assert.equal(await redis.flushAll(), 1);
  assert.deepEqual(await redis.keys(), []);
});

test('동시성: 요청 500개가 한꺼번에 같은 키를 증가시켜도 정확히 500 이 된다', async () => {
  await redis.del('counter');
  const results = await Promise.all(Array.from({ length: 500 }, () => redis.incr('counter')));
  assert.equal(await redis.get('counter'), 500);
  assert.equal(new Set(results).size, 500);        // 같은 숫자를 받은 요청이 없다
});

test('동시성: 요청 100개가 한꺼번에 nx 로 잠금을 잡아도 성공하는 것은 하나뿐이다', async () => {
  await redis.del('mutex');
  const results = await Promise.all(Array.from({ length: 100 }, (_, i) => redis.set('mutex', 'owner-' + i, { nx: true })));
  assert.equal(results.filter(Boolean).length, 1);
});

test('엣지: 한글·공백·슬래시·물음표가 들어간 키도 주소에 넣어 쓸 수 있다', async () => {
  for (const key of ['사용자:1', 'a b', 'a/b/c', 'q?x=1&y=2', '100%', '#hash']) {
    await redis.set(key, key);
    assert.equal(await redis.get(key), key, key);
    assert.equal(await redis.del(key), 1);
  }
});

test('엣지: 잘못된 요청은 400 과 이유를 돌려준다', async () => {
  const badJson = await raw('PUT', '/keys/a', '{"value": ');
  assert.equal(badJson.status, 400);
  const notObject = await raw('PUT', '/keys/a', '[1,2]');
  assert.equal(notObject.status, 400);
  const noValue = await raw('PUT', '/keys/a', '{}');
  assert.equal(noValue.status, 400);
  const badTtl = await raw('PUT', '/keys/a', '{"value":1,"ttl":-5}');
  assert.equal(badTtl.status, 400);
  assert.match((await badTtl.json()).error, /ttl/);
  const badEncoding = await raw('GET', '/keys/%E0%A4%A');
  assert.equal(badEncoding.status, 400);
  await redis.set('text', '글자');
  await assert.rejects(redis.incr('text'), (err) => err instanceof RedisError && err.status === 400);
  const noPrefix = await raw('DELETE', '/keys');
  assert.equal(noPrefix.status, 400);              // 접두사 없이 전체를 지우려면 /flush 를 써야 한다
  assert.equal(await redis.get('a'), null);        // 실패한 요청은 아무것도 저장하지 않았다
});

test('엣지: 없는 경로는 404, 지원하지 않는 메서드는 405', async () => {
  assert.equal((await raw('GET', '/nothing')).status, 404);
  assert.equal((await raw('GET', '/keys/a/b/c')).status, 404);
  assert.equal((await raw('PATCH', '/keys/a', '{}')).status, 405);
  assert.equal((await raw('GET', '/flush')).status, 405);
});

test('엣지: 1MB 가 넘는 본문은 거절하고, 그보다 작은 큰 값은 저장된다', async () => {
  const big = 'x'.repeat(500_000);
  assert.equal(await redis.set('big', big), true);
  assert.equal((await redis.get('big')).length, 500_000);
  const tooBig = await raw('PUT', '/keys/huge', JSON.stringify({ value: 'x'.repeat(1_100_000) })).catch(() => ({ status: 413 }));
  assert.equal(tooBig.status, 413);
  assert.equal(await redis.get('huge'), null);
});

test('info: 키 수와 해시 테이블 상태를 알려 준다', async () => {
  await redis.flushAll();
  for (let i = 0; i < 100; i++) await redis.set('k' + i, i);
  const info = await redis.info();
  assert.equal(info.keys, 100);
  assert.equal(info.table.size, 100);
  assert.ok(info.table.capacity >= 128);
});
