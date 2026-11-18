/* auth.js 테스트: 제작자 로그인, 세션 만료, 로그인 실패 제한 (미니 레디스 저장소를 직접 쓴다) */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../../redis/src/store.js';
import { createAuth, makeAccount, hashPassword, AuthError } from '../auth.js';

const ID = 'maker', PASSWORD = 'test-password-1';

/** 시각을 마음대로 돌릴 수 있는 저장소와, 계정 파일이 든 임시 폴더 */
function setup({ account = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'word-auth-'));
  const adminFile = path.join(dir, 'admin.json');
  if (account) fs.writeFileSync(adminFile, JSON.stringify(makeAccount(ID, PASSWORD)));
  const clock = { now: 1_000_000 };
  const store = createStore({ now: () => clock.now });
  return { auth: createAuth({ redis: store, adminFile }), store, clock, adminFile, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const status = (code) => (err) => err instanceof AuthError && err.status === code;

test('계정 만들기: 비밀번호는 저장하지 않고 해시만 저장한다', () => {
  const account = makeAccount(ID, PASSWORD);
  assert.deepEqual(Object.keys(account).sort(), ['hash', 'id', 'salt']);
  assert.equal(JSON.stringify(account).includes(PASSWORD), false);
  assert.equal(hashPassword(PASSWORD, account.salt).hash, account.hash);          // 같은 salt 면 같은 해시
  assert.notEqual(makeAccount(ID, PASSWORD).hash, account.hash);                   // salt 가 달라 해시도 다르다
});

test('계정 만들기: 규칙에 맞지 않는 아이디·비밀번호는 거절한다', () => {
  for (const [id, password] of [['ab', PASSWORD], ['한글아이디', PASSWORD], ['a b c', PASSWORD], ['', PASSWORD], [ID, '1234567'], [ID, '']]) {
    assert.throws(() => makeAccount(id, password), status(400), id + ' / ' + password);
  }
});

test('로그인: 아이디와 비밀번호가 맞으면 토큰을 받고, 세션이 30분 동안 유지된다', async () => {
  const { auth, store, clock, clean } = setup();
  try {
    const { token, id, expiresInMs } = await auth.login(ID, PASSWORD);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.deepEqual([id, expiresInMs], [ID, 30 * 60_000]);
    assert.deepEqual(store.get('session:' + token), { id: ID });
    assert.equal((await auth.session(token)).id, ID);
    assert.equal((await auth.require(token)).id, ID);

    clock.now += 29 * 60_000;
    assert.ok((await auth.session(token)).remainingMs <= 60_000);
    clock.now += 60_001;                                                           // 30분이 지나면 세션 키가 만료된다
    assert.equal(await auth.session(token), null);
    await assert.rejects(() => auth.require(token), status(401));
  } finally { clean(); }
});

test('로그인: 아이디나 비밀번호가 틀리면 401 이고 어느 쪽이 틀렸는지 알려 주지 않는다', async () => {
  const { auth, clean } = setup();
  try {
    const messages = new Set();
    for (const [id, password] of [[ID, 'wrong-password'], ['other', PASSWORD], ['', ''], [undefined, undefined], [ID, PASSWORD + ' ']]) {
      await assert.rejects(() => auth.login(id, password, String(id)), (err) => { messages.add(err.message); return status(401)(err); });
    }
    assert.equal(messages.size, 1);
  } finally { clean(); }
});

test('로그인 실패 제한: 5번 틀리면 1분 동안 맞는 비밀번호도 받지 않는다', async () => {
  const { auth, clock, clean } = setup();
  try {
    for (let i = 0; i < 5; i++) await assert.rejects(() => auth.login(ID, 'wrong', '1.2.3.4'), status(401));
    await assert.rejects(() => auth.login(ID, PASSWORD, '1.2.3.4'), status(429));
    assert.match((await auth.login(ID, PASSWORD, '5.6.7.8')).token, /^[0-9a-f]{64}$/);   // 다른 접속 주소는 영향받지 않는다

    clock.now += 60_001;                                                           // 실패 횟수 키가 만료된다
    assert.match((await auth.login(ID, PASSWORD, '1.2.3.4')).token, /^[0-9a-f]{64}$/);
  } finally { clean(); }
});

test('로그인 실패 제한: 성공하면 실패 횟수가 지워진다', async () => {
  const { auth, store, clean } = setup();
  try {
    for (let i = 0; i < 4; i++) await assert.rejects(() => auth.login(ID, 'wrong', 'c'), status(401));
    await auth.login(ID, PASSWORD, 'c');
    assert.equal(store.get('login:fail:c'), null);
    for (let i = 0; i < 4; i++) await assert.rejects(() => auth.login(ID, 'wrong', 'c'), status(401));
    await auth.login(ID, PASSWORD, 'c');
  } finally { clean(); }
});

test('로그아웃: 세션 키를 지워 토큰을 더 쓸 수 없다', async () => {
  const { auth, clean } = setup();
  try {
    const { token } = await auth.login(ID, PASSWORD);
    await auth.logout(token);
    assert.equal(await auth.session(token), null);
    assert.deepEqual(await auth.logout(token), { ok: true });                      // 두 번 해도 오류가 아니다
    assert.deepEqual(await auth.logout('엉뚱한 값'), { ok: true });
  } finally { clean(); }
});

test('세션: 형식이 다른 토큰이나 남의 키 이름은 받아들이지 않는다', async () => {
  const { auth, store, clean } = setup();
  try {
    store.set('session:abc', { id: ID });
    for (const bad of [null, undefined, '', 'abc', '../game:1', 'A'.repeat(64), 'g'.repeat(64), 12345]) {
      assert.equal(await auth.session(bad), null, String(bad));
    }
  } finally { clean(); }
});

test('계정 파일이 없거나 깨져 있으면 로그인할 수 없다 (503)', async () => {
  const { auth, adminFile, clean } = setup({ account: false });
  try {
    assert.equal(auth.configured(), false);
    await assert.rejects(() => auth.login(ID, PASSWORD), status(503));
    fs.writeFileSync(adminFile, '{깨진 파일');
    await assert.rejects(() => auth.login(ID, PASSWORD), status(503));
    fs.writeFileSync(adminFile, JSON.stringify({ id: ID }));
    assert.equal(auth.configured(), false);
    fs.writeFileSync(adminFile, JSON.stringify(makeAccount(ID, PASSWORD)));          // 계정을 만들면 서버를 다시 켜지 않아도 된다
    assert.equal(auth.configured(), true);
    assert.equal((await auth.login(ID, PASSWORD)).id, ID);
  } finally { clean(); }
});
