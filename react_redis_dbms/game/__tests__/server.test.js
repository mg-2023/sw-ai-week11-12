/* server.js 기능 테스트: 게임 서버를 실제로 띄우고 HTTP 로 화면 파일과 API 를 호출한다 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGameStack } from './helper.js';
import { createGameServer } from '../server.js';
import { listen, close } from '../../redis/src/api.js';
import { createAuth, makeAccount } from '../auth.js';
import { createRoomService } from '../rooms.js';

const ID = 'maker', PASSWORD = 'test-password-1';

let stack, server, url;
before(async () => {
  stack = await startGameStack({ words: [['기차'], ['차표'], ['표범'], ['범인']] });
  const adminFile = path.join(stack.dir, 'admin.json');
  fs.writeFileSync(adminFile, JSON.stringify(makeAccount(ID, PASSWORD)));
  server = createGameServer({
    service: stack.service,
    auth: createAuth({ redis: stack.redis, adminFile }),
    rooms: createRoomService({ redis: stack.redis, db: stack.db, dictionary: stack.service.dictionary, random: () => 0, randomStart: false }),
    webDir: fileURLToPath(new URL('../../web', import.meta.url)),
    libDir: fileURLToPath(new URL('../../mini-react', import.meta.url)),
  });
  url = await listen(server);
});
after(async () => { await close(server); await stack.stop(); });

async function call(method, pathname, body, token, roomToken) {
  const res = await fetch(url + pathname, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: 'Bearer ' + token } : {}), ...(roomToken ? { 'x-room-token': roomToken } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return [res.status, await res.json()];
}

test('화면: index.html, 화면 스크립트, 미니 리액트 라이브러리를 내려 준다', async () => {
  const page = await fetch(url + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /<div id="app"><\/div>/);
  for (const file of ['/app.js', '/api.js', '/mini-react/hooks.js', '/mini-react/root.js']) {
    const res = await fetch(url + file);
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get('content-type'), /javascript/, file);
  }
  assert.match((await fetch(url + '/style.css')).headers.get('content-type'), /text\/css/);
});

test('화면: 폴더 밖의 파일이나 없는 파일은 내려 주지 않는다', async () => {
  const bads = ['/..%2Fserver.js', '/%2e%2e/%2e%2e/package.json', '/mini-react/..%2Fpackage.json',
    '/mini-react/..%2F..%2Fword-chain%2Fserver.js', '/nothing.js', '/web', '/%E0%A4%A'];
  for (const bad of bads) {
    const res = await fetch(url + bad);
    assert.equal(res.status, 404, bad);
  }
});

test('API: 판을 시작하고, 단어를 내고, 상태를 조회하고, 포기한다', async () => {
  const [s1, started] = await call('POST', '/api/games', { player: '영희', level: 'easy' });
  assert.equal(s1, 200);
  const id = started.game.id;

  const [s2, turn] = await call('POST', '/api/games/' + id + '/words', { word: '기차' });
  assert.equal(s2, 200);
  assert.deepEqual([turn.accepted, turn.computer.word, turn.game.need], [true, '차표', ['표']]);

  const [, rejected] = await call('POST', '/api/games/' + id + '/words', { word: '기차' });
  assert.equal(rejected.reject.code, 'start');

  const [s3, seen] = await call('GET', '/api/games/' + id);
  assert.equal(s3, 200);
  assert.equal(seen.game.history.length, 2);

  const [s4, over] = await call('POST', '/api/games/' + id + '/giveup');
  assert.equal(s4, 200);
  assert.deepEqual([over.game.status, over.game.reason], ['over', 'give-up']);

  const [s5, record] = await call('GET', '/api/records/' + over.game.recordId);
  assert.equal(s5, 200);
  assert.equal(record.record.player, '영희');
  const [, rank] = await call('GET', '/api/ranking');
  assert.equal(rank.ranking[0].player, '영희');
});

test('API: 단어 등록과 글자로 찾기', async () => {
  const [, login] = await call('POST', '/api/login', { id: ID, password: PASSWORD });
  const [s1, added] = await call('POST', '/api/words', { word: '인사', finisher: true }, login.token);
  assert.deepEqual([s1, added.added, added.finisher], [200, true, true]);
  const [s2, again] = await call('POST', '/api/words', { word: '인사', finisher: true }, login.token);
  assert.deepEqual([s2, again.added], [200, false]);
  const [s3, list] = await call('GET', '/api/words?first=' + encodeURIComponent('인'));
  assert.equal(s3, 200);
  assert.deepEqual(list.words, [{ word: '인사', finisher: true }]);
  const [s3b, longer] = await call('GET', '/api/words?first=' + encodeURIComponent('인사'));    // 여러 글자로도 찾는다
  assert.deepEqual([s3b, longer.first, longer.words.length], [200, '인사', 1]);
  const [s4, status] = await call('GET', '/api/status');
  assert.equal(s4, 200);
  assert.ok(status.redis.table.capacity >= 16);
});

test('API: 잘못된 요청은 4xx 와 이유를 돌려준다', async () => {
  const cases = [
    ['POST', '/api/words', { word: 'abc' }, 401],
    ['POST', '/api/login', '{깨진 JSON', 400],
    ['POST', '/api/login', '[1,2]', 400],
    ['GET', '/api/login', undefined, 405],
    ['GET', '/api/words', undefined, 400],
    ['GET', '/api/words?first=abc', undefined, 400],
    ['GET', '/api/games/999999', undefined, 404],
    ['POST', '/api/games/999999/words', { word: '기차' }, 404],
    ['GET', '/api/games/abc', undefined, 404],
    ['GET', '/api/nothing', undefined, 404],
    ['DELETE', '/api/games', undefined, 405],
    ['GET', '/api/games/1/words', undefined, 405],
    ['POST', '/api/ranking', {}, 405],
  ];
  for (const [method, pathname, body, expected] of cases) {
    const [status, data] = await call(method, pathname, body);
    assert.equal(status, expected, method + ' ' + pathname);
    assert.equal(typeof data.error, 'string');
  }
});

test('단어 등록은 제작자 로그인이 있어야 한다', async () => {
  const count = async () => (await call('GET', '/api/words?first=' + encodeURIComponent('모')))[1].words.length;

  // 로그인하지 않았거나 엉뚱한 토큰이면 401 이고 단어가 들어가지 않는다
  for (const token of [undefined, 'abc', 'f'.repeat(64)]) {
    const [status, data] = await call('POST', '/api/words', { word: '모자' }, token);
    assert.equal(status, 401, String(token));
    assert.match(data.error, /로그인/);
  }
  assert.equal(await count(), 0);

  // 비밀번호가 틀리면 401
  const [wrong] = await call('POST', '/api/login', { id: ID, password: 'wrong-password' });
  assert.equal(wrong, 401);

  // 로그인하면 등록된다
  const [ok, login] = await call('POST', '/api/login', { id: ID, password: PASSWORD });
  assert.equal(ok, 200);
  const [seen, session] = await call('GET', '/api/session', undefined, login.token);
  assert.deepEqual([seen, session.loggedIn, session.id, session.configured], [200, true, ID, true]);
  const [added, result] = await call('POST', '/api/words', { word: '모자' }, login.token);
  assert.deepEqual([added, result.added], [200, true]);
  assert.equal(await count(), 1);
  const [bad] = await call('POST', '/api/words', { word: 'abc' }, login.token);       // 로그인해도 형식 검사는 그대로다
  assert.equal(bad, 400);

  // 로그아웃하면 같은 토큰으로 더 등록할 수 없다
  await call('POST', '/api/logout', undefined, login.token);
  assert.equal((await call('GET', '/api/session', undefined, login.token))[1].loggedIn, false);
  assert.equal((await call('POST', '/api/words', { word: '모래' }, login.token))[0], 401);
  assert.equal(await count(), 1);

  // 게임은 로그인 없이 할 수 있다
  assert.equal((await call('POST', '/api/games', { player: '손님' }))[0], 200);
});

test('단어 삭제도 제작자 로그인이 있어야 한다', async () => {
  const [, login] = await call('POST', '/api/login', { id: ID, password: PASSWORD });
  await call('POST', '/api/words', { word: '삭제대상' }, login.token);
  const [denied, why] = await call('DELETE', '/api/words', { word: '삭제대상' });
  assert.equal(denied, 401);
  assert.match(why.error, /로그인/);
  const [ok, done] = await call('DELETE', '/api/words', { word: '삭제대상' }, login.token);
  assert.deepEqual([ok, done.removed], [200, true]);
  assert.deepEqual((await call('GET', '/api/words?first=' + encodeURIComponent('삭')))[1].words, []);
});

test('로그인을 5번 틀리면 429 로 막는다', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/login', { id: ID, password: 'wrong-' + i }))[0], 401);
  const [status, data] = await call('POST', '/api/login', { id: ID, password: PASSWORD });
  assert.equal(status, 429);
  assert.match(data.error, /1분/);
});

test('같이 하는 방: HTTP 로 만들고 · 들어가고 · 시작하고 · 차례대로 낸다 (토큰은 X-Room-Token 머리말)', async () => {
  const [made, a] = await call('POST', '/api/rooms', { name: 'HTTP방', player: '가', lives: 2 });
  assert.equal(made, 200);
  const [joined, b] = await call('POST', '/api/rooms/' + a.room.id + '/join', { player: '나' });
  assert.equal(joined, 200);
  const [, listed] = await call('GET', '/api/rooms');
  assert.ok(listed.rooms.some((r) => r.id === a.room.id && r.players.length === 2));
  assert.equal((await call('POST', '/api/rooms/' + a.room.id + '/start', undefined, null, b.token))[0], 403);   // 방장이 아니다
  const [started, s] = await call('POST', '/api/rooms/' + a.room.id + '/start', undefined, null, a.token);
  assert.deepEqual([started, s.room.status, s.room.turn], [200, 'playing', 1]);
  const [, turn] = await call('POST', '/api/rooms/' + a.room.id + '/words', { word: '기차' }, null, a.token);
  assert.deepEqual([turn.accepted, turn.room.turn], [true, 2]);
  const [, seen] = await call('GET', '/api/rooms/' + a.room.id, undefined, null, b.token);
  assert.deepEqual([seen.room.me, seen.room.need], [2, ['차']]);
  assert.equal((await call('POST', '/api/rooms/' + a.room.id + '/words', { word: '차표' }, null, 'wrong'))[0], 403);
  assert.equal((await call('GET', '/api/rooms/99999'))[0], 404);
  assert.equal((await call('DELETE', '/api/rooms'))[0], 405);
});
