/* rooms.js 기능 테스트: 미니 레디스 · 미니 DBMS 서버를 실제로 띄우고, 여러 사람이 한 방에서 판을 진행한다 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startGameStack, sleep } from './helper.js';
import { createRoomService, MAX_PLAYERS } from '../rooms.js';

const WORDS = [['기차'], ['차표'], ['표범'], ['범인'], ['요리'], ['이발'], ['발표'], ['차륜', true], ['소녀'], ['여름']];

/** 게임 한 벌 + 방 서비스. 시작 단어 없이, 첫 선공은 난수 0 → 첫 번째 사람 */
async function roomStack({ turnMs = 10_000, secondMs = 1000 } = {}) {
  const stack = await startGameStack({ words: WORDS });
  const rooms = createRoomService({ redis: stack.redis, db: stack.db, dictionary: stack.service.dictionary, turnMs, secondMs, random: () => 0, randomStart: false });
  return { ...stack, rooms };
}

/** 방장 + others 명이 들어간 방 → { room, tokens: [방장, …] } */
async function filledRoom(rooms, others, settings = {}) {
  const made = await rooms.create({ name: '테스트방', player: '방장', ...settings });
  const tokens = [made.token];
  for (let i = 0; i < others; i++) tokens.push((await rooms.join(made.room.id, { player: '손님' + (i + 1) })).token);
  return { id: made.room.id, tokens };
}

test('방: 만들기 · 들어가기 · 목록, 최대 4명, 다른 사람의 토큰은 보이지 않는다', async () => {
  const s = await roomStack();
  try {
    const made = await s.rooms.create({ name: '우리방', player: '철수', lives: 2, round: 30 });
    assert.deepEqual(made.room.settings, { lives: 2, round: 30 });
    assert.deepEqual([made.room.status, made.room.host, made.room.me], ['waiting', 1, 1]);
    for (let i = 0; i < MAX_PLAYERS - 1; i++) await s.rooms.join(made.room.id, { player: '영희' + i });
    await assert.rejects(() => s.rooms.join(made.room.id, { player: '다섯째' }), (err) => err.status === 409);
    const { rooms } = await s.rooms.list();
    assert.deepEqual(rooms.map((r) => [r.name, r.players.length, r.status]), [['우리방', 4, 'waiting']]);
    const seen = await s.rooms.get(made.room.id, null);
    assert.ok(seen.room.players.every((p) => p.token === undefined));
    assert.equal(seen.room.me, null);
    const bad = await s.rooms.create({ player: '설정', lives: 9, round: 45 });                           // 범위 밖이면 기본값
    assert.deepEqual(bad.room.settings, { lives: 3, round: 60 });
  } finally { await s.stop(); }
});

test('방: 방장만, 2명 이상일 때 시작할 수 있다', async () => {
  const s = await roomStack();
  try {
    const alone = await s.rooms.create({ player: '혼자' });
    await assert.rejects(() => s.rooms.start(alone.room.id, alone.token), (err) => err.status === 409);
    const { id, tokens } = await filledRoom(s.rooms, 1);
    await assert.rejects(() => s.rooms.start(id, tokens[1]), (err) => err.status === 403);
    const { room } = await s.rooms.start(id, tokens[0]);
    assert.deepEqual([room.status, room.roundNo, room.turn, room.firstMove], ['playing', 1, 1, true]);   // 난수 0 → 첫 번째 사람이 먼저
  } finally { await s.stop(); }
});

test('방: 차례대로 낸다. 내 차례가 아니면 거절, 첫 단어 한방 금지, 나온 단어 거절', async () => {
  const s = await roomStack();
  try {
    const { id, tokens } = await filledRoom(s.rooms, 2);
    await s.rooms.start(id, tokens[0]);
    assert.equal((await s.rooms.play(id, tokens[1], '기차')).reject.code, 'not-your-turn');
    assert.equal((await s.rooms.play(id, tokens[0], '범인')).reject.code, 'first-kill');
    const first = await s.rooms.play(id, tokens[0], '기차');
    assert.deepEqual([first.accepted, first.room.turn, first.room.need, first.room.firstMove], [true, 2, ['차'], false]);
    assert.equal(first.room.players[0].score, 1012);                                                    // 차 → 차표 · 차륜 2개 → 공격
    const second = await s.rooms.play(id, tokens[1], '차표');
    assert.equal(second.room.turn, 3);
    assert.equal((await s.rooms.play(id, tokens[2], '기차')).reject.code, 'start');
    const third = await s.rooms.play(id, tokens[2], '표범');
    assert.equal(third.room.turn, 1);                                                                   // 한 바퀴 돌아 방장
  } finally { await s.stop(); }
});

test('방: 시간이 다 되면 그 사람이 목숨을 잃고, 그 사람이 먼저 내는 새 라운드가 열린다 (나온 단어도 비움)', async () => {
  const s = await roomStack({ turnMs: 200 });
  try {
    const { id, tokens } = await filledRoom(s.rooms, 1, { lives: 2 });
    await s.rooms.start(id, tokens[0]);
    await s.rooms.play(id, tokens[0], '기차');                                                          // 이제 손님1 차례
    await sleep(300);
    const { room } = await s.rooms.get(id, tokens[1]);
    assert.deepEqual(room.history.at(-1), { by: 'life', pid: 2, reason: 'timeout', left: 1 });
    assert.deepEqual([room.roundNo, room.turn, room.need, room.firstMove], [2, 2, null, true]);
    assert.equal((await s.rooms.play(id, tokens[1], '기차')).accepted, true);                          // 1라운드의 '기차'를 다시 낼 수 있다
  } finally { await s.stop(); }
});

test('방: 목숨이 0 이 되면 빠지고, 한 사람만 남으면 판이 끝나 기록이 남는다', async () => {
  const s = await roomStack({ turnMs: 200 });
  try {
    const { id, tokens } = await filledRoom(s.rooms, 1, { lives: 1 });
    await s.rooms.start(id, tokens[0]);
    await sleep(300);
    const { room } = await s.rooms.get(id, tokens[0]);
    assert.deepEqual([room.status, room.reason, room.winners], ['over', 'last-one', [2]]);
    const rows = (await s.db.query("SELECT player, result, reason FROM games WHERE level = 'room'")).objects;
    assert.deepEqual(rows.map((r) => [r.player, r.result]).sort(), [['방장', 'lose'], ['손님1', 'win']]);
  } finally { await s.stop(); }
});

test('방: 이름을 안 쓰면 손님 + 번호, 쓰면 그 이름으로 들어간다', async () => {
  const s = await roomStack();
  try {
    const made = await s.rooms.create({ player: '' });
    const second = await s.rooms.join(made.room.id, { player: '  ' });
    const third = await s.rooms.join(made.room.id, { player: '영희' });
    assert.deepEqual(third.room.players.map((p) => p.name), ['손님1', '손님2', '영희']);
    assert.equal(second.room.me, 2);
  } finally { await s.stop(); }
});

test('방: 기다리는 중에 방장이 나가면 다음 사람이 방장, 판 중에 나가면 빠진 것으로 친다', async () => {
  const s = await roomStack();
  try {
    const { id, tokens } = await filledRoom(s.rooms, 2);
    const left = await s.rooms.leave(id, tokens[0]);
    assert.deepEqual([left.room.host, left.room.players.length], [2, 2]);
    await s.rooms.start(id, tokens[1]);
    const quit = await s.rooms.leave(id, tokens[2]);
    assert.deepEqual([quit.room.status, quit.room.winners], ['over', [2]]);                            // 한 사람만 남았다
    const empty = await s.rooms.create({ player: '혼자' });
    assert.deepEqual(await s.rooms.leave(empty.room.id, empty.token), { left: true, room: null });   // 아무도 없으면 방이 사라진다
    await assert.rejects(() => s.rooms.get(empty.room.id), (err) => err.status === 404);
  } finally { await s.stop(); }
});
