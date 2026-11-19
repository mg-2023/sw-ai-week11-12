/* service.js 기능 테스트: 미니 레디스 서버와 미니 DBMS 서버를 실제로 띄우고 판을 진행한다 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startGameStack, sleep } from './helper.js';
import { GameError } from '../service.js';
import { POINTS, LIVES } from '../rules.js';

const WORDS = [['기차'], ['차표'], ['표범'], ['범인'], ['요리'], ['이발'], ['발표'], ['차륜', true], ['소녀'], ['여름']];

let stack, service, redis, db;
before(async () => { stack = await startGameStack({ words: WORDS }); ({ service, redis, db } = stack); });
after(async () => { await stack.stop(); });

const source = (trace, key) => trace.find((t) => t.key === key)?.source;

/* ---------------------------------------------------------------- 단어 등록 */

test('등록: 새 단어는 DBMS 에 들어가고 첫 글자·끝 글자가 함께 저장된다', async () => {
  const result = await service.register('나비');
  assert.equal(result.added, true);
  const row = (await db.query("SELECT * FROM words WHERE word = '나비'")).objects[0];
  assert.deepEqual({ first: row.first, last: row.last, finisher: row.finisher }, { first: '나', last: '비', finisher: 0 });
  assert.equal(row.id, result.id);
});

test('등록: 이미 있는 단어는 다시 넣지 않는다', async () => {
  const result = await service.register('기차');
  assert.equal(result.added, false);
  assert.equal((await db.query("SELECT COUNT(*) FROM words WHERE word = '기차'")).rows[0][0], 1);
});

test('등록: 형식이 틀린 단어는 400', async () => {
  for (const bad of ['', '기', 'abc', '기차 ', ' ', null, undefined, "기'차", '기차; DROP']) {
    if (typeof bad === 'string' && bad.trim() === '기차') continue;      // 앞뒤 공백은 잘라 내므로 정상 단어다
    await assert.rejects(() => service.register(bad), (err) => err instanceof GameError && err.status === 400, String(bad));
  }
});

test('등록: 일반 단어를 끝내기로 다시 등록하면 끝내기 단어가 된다', async () => {
  await service.register('비누');
  const result = await service.register('비누', true);
  assert.equal(result.added, true);
  const { words } = await service.words('비');
  assert.deepEqual(words.filter((w) => w.word === '비누'), [{ word: '비누', finisher: true }]);    // 목록에는 한 번만 나온다
  assert.equal((await service.register('비누')).added, false);                                     // 끝내기를 일반으로 되돌리지는 않는다
});

test('등록 → 무효화: "없는 단어"로 캐시된 결과가 등록 직후 사라진다', async () => {
  const { game } = await service.start({ player: '무효화' });
  const first = await service.play(game.id, '하늘');
  assert.equal(first.reject.code, 'unknown');
  assert.deepEqual(await redis.get('word:하늘'), { known: false, finisher: false });   // "없음"이 캐시됐다

  const registered = await service.register('하늘');
  assert.deepEqual(registered.invalidated, ['word:하늘', 'first:하']);
  assert.equal(await redis.get('word:하늘'), null);
  await service.register('늘보');                                      // '하늘'이 첫 단어로 쓰일 수 있게 이을 단어를 하나 둔다 (첫 턴 한방 금지)

  const second = await service.play(game.id, '하늘');
  assert.equal(second.accepted, true);
  await service.giveUp(game.id).catch(() => {});
});

test('등록: 같은 단어를 동시에 20번 등록해도 한 번만 들어간다', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => service.register('동시등록')));
  assert.equal(results.filter((r) => r.added).length, 1);
  assert.equal((await db.query("SELECT COUNT(*) FROM words WHERE word = '동시등록'")).rows[0][0], 1);
});

test('등록: wordFiles 를 주면 등록한 단어를 파일에도 이어 적는다', async () => {
  const files = { words: path.join(stack.dir, 'w.txt'), finishers: path.join(stack.dir, 'f.txt') };
  const other = await startGameStack({ wordFiles: files });
  try {
    await other.service.register('가방');
    await other.service.register('나트륨', true);
    assert.match(fs.readFileSync(files.words, 'utf8'), /가방/);
    assert.match(fs.readFileSync(files.finishers, 'utf8'), /나트륨/);
  } finally { await other.stop(); }
});

/* ---------------------------------------------------------------- 판 진행 */

test('판: 단어를 내면 상대가 끝 글자로 시작하는 단어로 받는다', async () => {
  const { game } = await service.start({ player: '철수', level: 'easy' });
  assert.equal(game.status, 'playing');
  assert.equal(game.need, null);

  const turn = await service.play(game.id, '기차');
  assert.equal(turn.accepted, true);
  assert.equal(turn.computer.word, '차표');                        // easy 라서 끝내기 단어 '차륜'은 쓰지 않는다
  assert.deepEqual(turn.game.need, ['표']);
  assert.deepEqual(turn.game.history.map((h) => h.word), ['기차', '차표']);
  assert.equal(turn.game.turns, 2);
  assert.ok(turn.game.remainingMs > 9000 && turn.game.remainingMs <= 10000);
  await service.giveUp(game.id);
});

test('판: 거절된 단어는 판을 바꾸지 않고 이유를 알려 준다', async () => {
  const { game } = await service.start({ player: '거절', level: 'easy' });
  await service.play(game.id, '기차');                              // 상대: 차표, 이어야 할 글자: 표

  const cases = [['기', 'format'], ['abc', 'format'], ['', 'format'], ['범인', 'start'], ['표현', 'unknown']];
  for (const [word, code] of cases) {
    const turn = await service.play(game.id, word);
    assert.equal(turn.accepted, false, word);
    assert.equal(turn.reject.code, code, word);
    assert.equal(turn.game.turns, 2);
    assert.equal(turn.game.status, 'playing');
  }
  await service.giveUp(game.id);
});

test('판: 이번 라운드에 이미 나온 단어는 다시 낼 수 없다 (상대가 낸 단어도 포함)', async () => {
  const other = await startGameStack({ words: [['기차'], ['차기'], ['기사'], ['사기']] });
  try {
    const { game } = await other.service.start({ player: '중복', level: 'easy' });
    const first = await other.service.play(game.id, '기차');       // 상대: 차기 → 이어야 할 글자: 기
    assert.equal(first.computer.word, '차기');
    assert.equal((await other.service.play(game.id, '기차')).reject.code, 'used');
    assert.equal(other.store.get('game:' + game.id + ':used:차기'), 1);          // 상대가 낸 단어도 표시돼 있다
    assert.equal((await other.service.play(game.id, '차기')).reject.code, 'start');
    assert.equal((await other.service.play(game.id, '기사')).accepted, true);   // 상대: 사기
  } finally { await other.stop(); }
});

test('판: 두음법칙으로 바뀐 글자로도 이을 수 있다', async () => {
  const { game } = await service.start({ player: '두음', level: 'easy' });
  const turn = await service.play(game.id, '요리');                 // '리' 로 시작하는 단어는 없고 '이발' 이 있다
  assert.equal(turn.computer.word, '이발');
  assert.deepEqual(turn.trace.filter((t) => t.key.startsWith('first:')).map((t) => t.key).slice(0, 2), ['first:리', 'first:이']);
  await service.giveUp(game.id);

  const second = await service.start({ player: '두음2', level: 'easy' });
  const girl = await service.play(second.game.id, '소녀');          // 녀 → 여
  assert.equal(girl.computer.word, '여름');
  assert.equal(girl.game.status, 'over');                           // '름'/'늠' 으로 시작하는 단어가 없어 플레이어가 진다
  assert.equal(girl.game.reason, 'no-word');
});

test('판: 상대가 이을 단어가 없으면 플레이어가 이긴다', async () => {
  const { game } = await service.start({ player: '승리', level: 'easy' });
  await service.play(game.id, '요리');                                // 상대: 이발
  await service.play(game.id, '발표');                                // 상대: 표범
  const turn = await service.play(game.id, '범인');                   // 첫 단어가 아니라 한방 단어를 낼 수 있다
  assert.equal(turn.accepted, true);
  assert.equal(turn.computer, null);
  assert.deepEqual([turn.game.status, turn.game.result, turn.game.reason], ['over', 'win', 'computer-stuck']);
  assert.equal(turn.game.remainingMs, 0);
});

test('판: 어려움 난이도는 끝내기 단어를 낸다', async () => {
  const { game } = await service.start({ player: '어려움', level: 'hard' });
  const turn = await service.play(game.id, '기차');
  assert.deepEqual(turn.computer, { word: '차륜', finisher: true, thinkMs: 0 });                // 테스트는 생각 시간 0
  assert.deepEqual([turn.game.result, turn.game.reason], ['lose', 'no-word']);
});

test('판: 상대는 등급 표로 후보의 등급을 매기고, 등록 · 삭제하면 표의 숫자가 바뀐다', async () => {
  // 차표 → '표'로 시작하는 단어 1개(표범) → 공격.  차도 → '도'로 시작하는 단어 0개 → 한방 (끝내기 표시는 없다)
  const other = await startGameStack({ words: [['기차'], ['차표'], ['표범'], ['차도']] });
  const reply = async (level) => {
    const { game } = await other.service.start({ player: level, level });
    const turn = await other.service.play(game.id, '기차');
    await other.service.giveUp(game.id).catch(() => {});
    return turn;
  };
  try {
    const first = await reply('hard');
    assert.equal(first.computer.word, '차도');                                             // 가장 센 등급 (등급 없이 고르면 첫 후보 '차표')
    assert.equal(first.game.history.find((h) => h.by === 'computer').grade, 'kill');     // 기록에 남는 등급도 같은 셈이다
    assert.ok(first.trace.some((t) => t.label.startsWith('등급 표 만들기')));             // 처음 한 번 사전을 센다
    assert.equal((await reply('easy')).computer.word, '차표');                            // 가장 약한 등급

    await other.service.register('도시');                                                  // '도' 1개 → 차도도 공격이 된다
    const second = await reply('hard');
    assert.equal(second.computer.word, '차표');                                            // 둘 다 공격 → 무작위(0) → 첫 후보
    assert.ok(!second.trace.some((t) => t.label.startsWith('등급 표 만들기')));            // 다시 세지 않고 숫자만 고쳤다

    await other.service.remove('도시');                                                    // 다시 0개 → 차도는 한방
    assert.equal((await reply('hard')).computer.word, '차도');
  } finally { await other.stop(); }
});

test('라운드 시간: 고르지 않으면 60초, 끄투 선택지(10 · 30 · 60 · 90 · 120 · 150초)만 받는다', async () => {
  const a = await service.start({ player: '기본' });
  const b = await service.start({ player: '삼십', round: 30 });
  const c = await service.start({ player: '이상', round: 45 });
  assert.deepEqual([a.game.round, b.game.round, c.game.round], [60, 30, 60]);
  assert.ok(b.game.roundRemainingMs > 29_000 && b.game.roundRemainingMs <= 30_000);
  for (const g of [a, b, c]) await service.giveUp(g.game.id);
});

test('라운드 시간: 차례 제한보다 라운드가 먼저 끝나면 그때 차례인 플레이어가 목숨을 잃는다 (round-time)', async () => {
  const quick = await startGameStack({ words: WORDS, turnMs: 10_000, secondMs: 20 });   // 라운드 10초 → 200ms
  try {
    const { game } = await quick.service.start({ player: '라운드', level: 'easy', round: 10 });
    assert.equal(game.remainingMs <= 200, true);                                          // 차례 제한 10초보다 라운드가 짧다
    await sleep(300);
    const after = await quick.service.get(game.id);
    assert.deepEqual([after.game.status, after.game.reason], ['over', 'round-time']);
  } finally { await quick.stop(); }
});

test('라운드 시간: 단어를 낼 때마다 그 차례에 쓴 시간만큼 줄고, 목숨을 잃으면 새 라운드에서 다시 채운다', async () => {
  const quick = await startGameStack({ words: WORDS, turnMs: 10_000, secondMs: 100, lives: 2 });   // 라운드 10초 → 1,000ms
  try {
    const { game } = await quick.service.start({ player: '소모', level: 'easy', round: 10 });
    await sleep(150);
    const turn = await quick.service.play(game.id, '기차');                                // 상대: 차표
    assert.ok(turn.game.roundRemainingMs <= 870 && turn.game.roundRemainingMs > 600, String(turn.game.roundRemainingMs));
    assert.ok(turn.game.turnRemainingMs > 9_900, String(turn.game.turnRemainingMs));        // 차례 막대는 라운드가 짧아도 10초로 다시 찬다
    assert.ok(turn.game.remainingMs <= turn.game.roundRemainingMs + 5);                     // 실제 시간 초과는 라운드가 먼저 끝나는 때
    await sleep(Math.ceil(turn.game.roundRemainingMs) + 100);
    const lost = await quick.service.get(game.id);
    assert.equal(lost.game.history.find((h) => h.by === 'life').reason, 'round-time');
    assert.equal(lost.game.status, 'playing');                                             // 목숨 하나가 남았다
    assert.ok(lost.game.roundRemainingMs > 900);                                           // 새 라운드: 다시 채워짐
    await quick.service.giveUp(game.id);
  } finally { await quick.stop(); }
});

test('생각 시간: 내 단어는 바로 들어가고, 상대는 생각 시간(차례 키 TTL)이 지난 뒤 둔다', async () => {
  const lefts = [];
  const slow = await startGameStack({ words: WORDS, think: (left) => { lefts.push(left); return 300; } });
  try {
    const { game } = await slow.service.start({ player: '생각', level: 'easy', round: 60 });
    const turn = await slow.service.play(game.id, '기차');
    assert.deepEqual([turn.accepted, turn.computer, turn.game.turn], [true, null, 'computer']);   // 상대는 아직 생각하는 중
    assert.equal(turn.game.history.at(-1).word, '기차');                                      // 내 단어는 바로 들어갔다
    assert.ok(turn.game.remainingMs <= 300 && turn.game.remainingMs > 150, String(turn.game.remainingMs));   // 차례 키 TTL = 생각 시간
    assert.equal(turn.game.turnRemainingMs, 10_000);                                          // 내 차례 막대는 줄지 않는다
    assert.ok(lefts[0] <= 60_000 && lefts[0] > 59_000, String(lefts[0]));                     // 생각 시간은 그때 남은 라운드 시간으로 정한다

    const early = await slow.service.play(game.id, '차표');                                   // 상대 차례에는 단어를 받지 않는다
    assert.equal(early.reject.code, 'not-your-turn');
    assert.equal((await slow.service.get(game.id)).game.turn, 'computer');

    await sleep(350);
    const after = await slow.service.get(game.id);                                            // 키가 사라진 뒤 처음 묻는 요청에서 상대가 둔다
    const reply = after.game.history.at(-1);
    assert.deepEqual([after.game.turn, reply.by, reply.word, reply.thinkMs], ['player', 'computer', '차표', 300]);
    assert.ok(after.game.roundRemainingMs <= 60_000 - 300 && after.game.roundRemainingMs > 58_000, String(after.game.roundRemainingMs));
    assert.ok(after.game.remainingMs > 9_900, String(after.game.remainingMs));                 // 이제 내 차례 10초
    assert.equal(after.trace.find((t) => t.source === 'think').ms, 300);
    await slow.service.giveUp(game.id);
  } finally { await slow.stop(); }
});

test('생각 시간: 상대가 생각하는 동안 라운드 시간이 다 되면 상대가 목숨을 잃는다 (round-time)', async () => {
  const slow = await startGameStack({ words: WORDS, secondMs: 20, think: () => 1_000 });      // 라운드 10초 → 200ms, 생각 1초
  try {
    const { game } = await slow.service.start({ player: '시간', level: 'easy', round: 10 });
    const turn = await slow.service.play(game.id, '기차');
    assert.equal(turn.game.turn, 'computer');
    assert.ok(turn.game.remainingMs <= 200, String(turn.game.remainingMs));                   // 키는 라운드가 끝나는 때 사라진다
    await sleep(300);
    const after = await slow.service.get(game.id);
    assert.deepEqual([after.game.status, after.game.result, after.game.reason], ['over', 'win', 'round-time']);
    assert.equal(after.game.history.at(-1).who, 'computer');
    assert.equal(after.game.history.filter((h) => h.by === 'computer').length, 0);           // 다 생각하지 못해 단어를 내지 못했다
  } finally { await slow.stop(); }
});

test('생각 시간: 상대가 라운드를 먼저 낼 때도 생각한 뒤 낸다', async () => {
  const slow = await startGameStack({ words: WORDS, coin: () => 0.9, randomStart: true, think: () => 300 });
  try {
    const { game } = await slow.service.start({ player: '선공', level: 'easy', round: 30 });
    assert.equal(game.turn, 'computer');
    assert.equal(game.history.some((h) => h.by === 'computer'), false);
    await sleep(350);
    const after = await slow.service.get(game.id);
    const opening = after.game.history.find((h) => h.by === 'computer');
    assert.ok(opening, JSON.stringify(after.game.history));
    assert.equal(opening.thinkMs, 300);
    assert.equal(after.game.turn, 'player');
    assert.ok(after.game.roundRemainingMs <= 30_000 - 300, String(after.game.roundRemainingMs));
    await slow.service.giveUp(game.id);
  } finally { await slow.stop(); }
});

test('판: 끝난 판에는 단어를 낼 수 없고, 없는 판은 404', async () => {
  const { game } = await service.start({ player: '끝' });
  await service.giveUp(game.id);
  await assert.rejects(() => service.play(game.id, '기차'), (err) => err.status === 409);
  await assert.rejects(() => service.play(999999, '기차'), (err) => err.status === 404);
  await assert.rejects(() => service.get(999999), (err) => err.status === 404);
  assert.equal((await service.giveUp(game.id)).game.reason, 'give-up');      // 두 번 포기해도 그대로다
});

test('판: 이름과 난이도가 이상하면 기본값을 쓴다', async () => {
  const a = await service.start({ player: '   ', level: 'god' });
  assert.deepEqual([a.game.player, a.game.level], ['손님', 'normal']);
  const b = await service.start({ player: "길고긴이름'을가진플레이어입니다" });
  assert.equal(b.game.player.length, 12);
  await service.giveUp(b.game.id);                                    // 작은따옴표가 든 이름도 기록으로 저장된다
  assert.equal((await service.record((await service.get(b.game.id)).game.recordId)).record.player, b.game.player);
  await service.giveUp(a.game.id);
  assert.equal((await service.start()).game.player, '손님');
});

/* ---------------------------------------------------------------- 만료 (제한 시간) */

test('만료: 제한 시간이 지나면 차례 키가 사라지고 시간 초과로 진다', async () => {
  const quick = await startGameStack({ words: [['기차'], ['차표'], ['표범']], turnMs: 120 });
  try {
    const { game } = await quick.service.start({ player: '느림', level: 'easy' });
    await sleep(200);
    const late = await quick.service.play(game.id, '기차');
    assert.equal(late.accepted, false);
    assert.deepEqual([late.game.status, late.game.result, late.game.reason], ['over', 'lose', 'timeout']);

    const second = await quick.service.start({ player: '조회', level: 'easy' });
    await quick.service.play(second.game.id, '기차');
    await sleep(200);
    const seen = await quick.service.get(second.game.id);           // 조회만 해도 시간 초과가 반영된다
    assert.equal(seen.game.reason, 'timeout');
    assert.equal((await quick.service.get(second.game.id)).game.recordId, seen.game.recordId);   // 두 번 끝나지 않는다
  } finally { await quick.stop(); }
});

test('만료: 제한 시간 안에 내면 다음 차례에 시간이 다시 채워진다', async () => {
  const quick = await startGameStack({ words: [['기차'], ['차표'], ['표범'], ['범인'], ['인사'], ['사과']], turnMs: 400 });
  try {
    const { game } = await quick.service.start({ player: '빠름', level: 'easy' });
    await sleep(250);
    const turn = await quick.service.play(game.id, '기차');
    assert.equal(turn.accepted, true);
    assert.ok(turn.game.remainingMs > 300, '남은 시간 ' + turn.game.remainingMs);
    await sleep(250);
    assert.equal((await quick.service.play(game.id, '표범')).accepted, true);
  } finally { await quick.stop(); }
});

/* ---------------------------------------------------------------- 캐시 · 무효화 · 기록 */

test('캐시: 처음에는 DBMS 를 선형 탐색하고, 다음부터는 레디스에서 꺼낸다', async () => {
  const other = await startGameStack({ words: [['기차'], ['차표'], ['표범']] });
  try {
    const a = await other.service.start({ player: '캐시1', level: 'easy' });
    const first = await other.service.play(a.game.id, '기차');
    assert.equal(source(first.trace, 'word:기차'), 'db');
    assert.equal(first.trace.find((t) => t.key === 'word:기차').plan, 'FULL_SCAN');
    assert.equal(source(first.trace, 'first:차'), 'db');

    const b = await other.service.start({ player: '캐시2', level: 'easy' });
    const second = await other.service.play(b.game.id, '기차');
    assert.equal(source(second.trace, 'word:기차'), 'cache');
    assert.equal(source(second.trace, 'first:차'), 'cache');
    assert.ok((await other.redis.ttl('word:기차')) > 50_000);         // 60초 만료가 걸려 있다
  } finally { await other.stop(); }
});

test('판이 끝나면: 기록이 저장되고, 그 판의 단어 표시가 지워지고, 순위 캐시가 무효화된다', async () => {
  const other = await startGameStack({ words: [['기차'], ['차표'], ['표범'], ['범인']] });
  try {
    const before = await other.service.ranking();
    assert.deepEqual(before.ranking, []);
    assert.equal((await other.service.ranking()).trace[0].source, 'cache');   // 빈 순위도 캐시된다

    const { game } = await other.service.start({ player: '기록', level: 'easy' });
    await other.service.play(game.id, '기차');                        // 상대: 차표
    assert.equal((await other.redis.keys('game:' + game.id + ':used:')).length, 2);
    const last = await other.service.play(game.id, '표범');           // 상대: 범인 → '인' 으로 시작하는 단어 없음
    assert.equal(last.game.reason, 'no-word');

    assert.deepEqual(await other.redis.keys('game:' + game.id + ':used:'), []);
    assert.equal(await other.redis.ttl('game:' + game.id + ':turn'), -2);
    assert.equal(await other.redis.get('ranking'), null);
    assert.equal(await other.redis.get('stats:games'), 1);

    const after = await other.service.ranking();
    assert.equal(after.trace[0].source, 'db');
    assert.deepEqual(after.ranking.map((r) => [r.player, r.turns, r.result]), [['기록', 4, 'lose']]);

    const found = await other.service.record(last.game.recordId);
    assert.equal(found.trace[0].plan, 'INDEX_POINT');                 // 기록 번호 조회는 B+ 트리 인덱스를 쓴다
    assert.equal(found.record.player, '기록');
    assert.equal((await other.service.record(12345)).record, null);
  } finally { await other.stop(); }
});

test('순위: 점수가 높은 판이 위로 온다', async () => {
  const other = await startGameStack({ words: [['기차'], ['차표'], ['표범'], ['범인']] });
  try {
    const low = await other.service.start({ player: '낮은점수', level: 'easy' });
    await other.service.giveUp(low.game.id);                             // 0점
    const high = await other.service.start({ player: '높은점수', level: 'easy' });
    await other.service.play(high.game.id, '기차');                       // 공격 1,012점, 상대: 차표
    await other.service.play(high.game.id, '표범');                       // 공격 1,012점, 상대: 범인 → 이을 단어 없음
    const { ranking } = await other.service.ranking();
    assert.deepEqual(ranking.map((r) => [r.player, r.score]), [['높은점수', 2024], ['낮은점수', 0]]);
  } finally { await other.stop(); }
});

/* ---------------------------------------------------------------- 동시성 */

test('동시성: 같은 판에 동시에 낸 단어는 하나만 처리된다', async () => {
  const other = await startGameStack({ words: [['기차'], ['차표'], ['표범'], ['범인'], ['기사'], ['사과'], ['과자']] });
  try {
    const { game } = await other.service.start({ player: '연타', level: 'easy' });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => other.service.play(game.id, '기차')));
    const accepted = results.filter((r) => r.status === 'fulfilled' && r.value.accepted);
    assert.equal(accepted.length, 1);
    for (const r of results) {
      if (r.status === 'rejected') assert.equal(r.reason.status, 409);
      else if (!r.value.accepted) assert.ok(['used', 'start'].includes(r.value.reject.code));
    }
    const state = (await other.service.get(game.id)).game;
    assert.deepEqual(state.history.map((h) => h.word), ['기차', '차표']);
    assert.equal(await other.redis.get('game:' + game.id + ':lock'), null);     // 잠금이 남아 있지 않다
  } finally { await other.stop(); }
});

test('동시성: 여러 판을 동시에 진행해도 서로 섞이지 않고 판 번호가 겹치지 않는다', async () => {
  const other = await startGameStack({ words: [['기차'], ['차표'], ['표범'], ['범인']] });
  try {
    const games = await Promise.all(Array.from({ length: 12 }, (_, i) => other.service.start({ player: 'p' + i, level: 'easy' })));
    assert.equal(new Set(games.map((g) => g.game.id)).size, 12);
    const turns = await Promise.all(games.map((g) => other.service.play(g.game.id, '기차')));
    for (const turn of turns) assert.deepEqual(turn.game.history.map((h) => h.word), ['기차', '차표']);
    const ends = await Promise.all(games.map((g) => other.service.play(g.game.id, '표범')));
    assert.equal(new Set(ends.map((e) => e.game.recordId)).size, 12);           // 기록 번호도 겹치지 않는다
    assert.equal(await other.redis.get('stats:games'), 12);
  } finally { await other.stop(); }
});

test('상태: 두 저장소의 상태를 함께 돌려준다', async () => {
  const status = await service.status();
  assert.ok(status.redis.keys >= 0 && status.redis.table.capacity >= 16);
  assert.deepEqual(status.tables.map((t) => t.table).sort(), ['games', 'words']);
  assert.equal(status.pool.size, 2);
  for (const bad of ['', ' ', 'ab', '기1', '가'.repeat(21), null]) await assert.rejects(() => service.words(bad), (err) => err.status === 400, String(bad));
  assert.deepEqual((await service.words('표')).words, [{ word: '표범', finisher: false }]);
});

/* ---------------------------------------------------------------- 단어 삭제 */

test('삭제: 지운 단어는 사전에 없는 단어가 되고, 상대도 그 단어를 내지 않는다', async () => {
  const other = await startGameStack({ words: [['기차'], ['차표'], ['차도'], ['표범']] });
  try {
    const before = await other.service.start({ player: '삭제전', level: 'easy' });
    assert.equal((await other.service.play(before.game.id, '기차')).computer.word, '차표');   // 캐시에 word:기차, first:차 가 들어간다
    await other.service.giveUp(before.game.id);

    const removed = await other.service.remove('차표');
    assert.equal(removed.removed, true);
    assert.deepEqual(removed.invalidated, ['word:차표', 'first:차']);
    assert.equal(await other.redis.get('first:차'), null);                                   // 캐시가 무효화됐다

    assert.deepEqual((await other.service.words('차')).words, [{ word: '차도', finisher: false }]);
    const after = await other.service.start({ player: '삭제후', level: 'easy' });
    assert.equal((await other.service.play(after.game.id, '차표')).reject.code, 'unknown');   // 내가 내도 거절된다
    assert.equal((await other.service.play(after.game.id, '기차')).computer.word, '차도');    // 상대는 남은 단어를 낸다

    // 미니 DBMS 에는 DELETE 가 없다: 줄을 지우지 않고 "지웠다"는 줄을 하나 더 넣었다
    const rows = (await other.db.query("SELECT id, removed FROM words WHERE word = '차표'")).objects;
    assert.deepEqual(rows.map((r) => r.removed), [null, 1]);
  } finally { await other.stop(); }
});

test('삭제: 없는 단어·이미 지운 단어는 그대로 두고, 형식이 틀리면 400', async () => {
  const other = await startGameStack({ words: [['기차']] });
  try {
    assert.equal((await other.service.remove('없는단어')).removed, false);
    assert.equal((await other.service.remove('기차')).removed, true);
    assert.equal((await other.service.remove('기차')).removed, false);
    assert.equal((await other.db.query("SELECT COUNT(*) FROM words WHERE word = '기차'")).rows[0][0], 2);
    for (const bad of ['', '기', 'abc', null]) await assert.rejects(() => other.service.remove(bad), (err) => err.status === 400);
  } finally { await other.stop(); }
});

test('삭제: 지운 단어를 다시 등록하면 되살아난다', async () => {
  const files = { words: path.join(stack.dir, 'w2.txt'), finishers: path.join(stack.dir, 'f2.txt'), removed: path.join(stack.dir, 'r2.txt') };
  const other = await startGameStack({ wordFiles: files });
  try {
    await other.service.register('가방');
    await other.service.remove('가방');
    assert.match(fs.readFileSync(files.removed, 'utf8'), /가방/);                   // 삭제 목록에 적힌다
    assert.deepEqual((await other.service.words('가')).words, []);

    assert.equal((await other.service.register('가방')).added, true);
    assert.deepEqual((await other.service.words('가')).words, [{ word: '가방', finisher: false }]);
    assert.doesNotMatch(fs.readFileSync(files.removed, 'utf8'), /가방/);            // 삭제 목록에서 빠진다
  } finally { await other.stop(); }
});

test('삭제: 등록과 삭제를 동시에 여러 번 보내도 한 줄로 서서 처리된다', async () => {
  const other = await startGameStack({ words: [['기차']] });
  try {
    const results = await Promise.all(Array.from({ length: 10 }, () => other.service.remove('기차')));
    assert.equal(results.filter((r) => r.removed).length, 1);
    assert.equal((await other.db.query("SELECT COUNT(*) FROM words WHERE word = '기차'")).rows[0][0], 2);
  } finally { await other.stop(); }
});

test('단어 찾기: 한 글자뿐 아니라 여러 글자로 시작하는 단어도 찾는다', async () => {
  const other = await startGameStack({ words: [['확인'], ['확인서'], ['확률'], ['확대'], ['환경']] });
  try {
    const find = async (prefix) => (await other.service.words(prefix)).words.map((w) => w.word);
    assert.deepEqual(await find('확'), ['확인', '확인서', '확률', '확대']);
    assert.deepEqual(await find('확인'), ['확인', '확인서']);
    assert.deepEqual(await find('확인서'), ['확인서']);
    assert.deepEqual(await find(' 확인 '), ['확인', '확인서']);                      // 앞뒤 공백은 잘라 낸다
    assert.deepEqual(await find('확실'), []);
    assert.deepEqual(await find('환'), ['환경']);

    // 여러 글자로 찾아도 DBMS 조회는 첫 글자 기준 한 번이고, 그다음부터는 캐시를 쓴다
    const again = await other.service.words('확률');
    assert.deepEqual([again.trace.length, again.trace[0].key, again.trace[0].source], [1, 'first:확', 'cache']);

    await other.service.remove('확인서');                                           // 삭제한 단어는 나오지 않는다
    assert.deepEqual(await find('확인'), ['확인']);
  } finally { await other.stop(); }
});

/* ---------------------------------------------------------------- 단어 등급 */

test('등급: 낸 단어마다 이을 수 있는 단어 수와 등급이 기록된다', async () => {
  // '차'로 시작: 차표·차도·차비 (3개 → 공격), '표'로 시작: 표범 (1개 → 공격), '범'으로 시작: 없음 (0개 → 한방)
  const other = await startGameStack({ words: [['기차'], ['차표'], ['차도'], ['차비'], ['표범']] });
  try {
    const { game } = await other.service.start({ player: '등급', level: 'easy' });
    const first = await other.service.play(game.id, '기차');
    assert.deepEqual(first.game.history, [
      { by: 'player', word: '기차', options: 3, grade: 'attack', points: 1012 },          // 공격 1000 + 2글자 12
      { by: 'computer', word: '차표', options: 1, grade: 'attack', points: 1012, finisher: false, thinkMs: 0 },
    ]);
    const second = await other.service.play(game.id, '표범');
    assert.deepEqual(second.game.history[2], { by: 'player', word: '표범', options: 0, grade: 'kill', points: 2012 });
    assert.equal(second.game.result, 'win');
  } finally { await other.stop(); }
});

test('등급: 이번 라운드에 써서 줄어든 것은 반영하지 않는다 (사전 전체 개수로 센다)', async () => {
  // 기차 → 차기 → 기사 → 사기 → 기차(이미 나옴). '기'로 시작하는 단어는 기차·기사 2개
  const other = await startGameStack({ words: [['기차'], ['차기'], ['기사'], ['사기']] });
  try {
    const { game } = await other.service.start({ player: '고정', level: 'easy' });
    const first = await other.service.play(game.id, '기차');                 // 상대: 차기
    assert.equal(first.game.history[1].word, '차기');
    assert.equal(first.game.history[1].options, 2);                        // 기차는 이미 나왔지만 그대로 2개로 센다
    const second = await other.service.play(game.id, '기사');               // 상대: 사기 → 남은 '기' 단어 없음
    assert.equal(second.game.history[3].word, '사기');
    assert.deepEqual([second.game.history[3].options, second.game.history[3].grade], [2, 'attack']);   // 실제로 낼 단어는 0개지만 등급은 2개 기준
    assert.equal(second.game.reason, 'no-word');
  } finally { await other.stop(); }
});

test('등급: 두음법칙으로 이을 수 있는 단어도 함께 센다', async () => {
  const other = await startGameStack({ words: [['요리'], ['이발'], ['이사'], ['리본'], ['발표']] });
  try {
    const { game } = await other.service.start({ player: '두음등급', level: 'easy' });
    const turn = await other.service.play(game.id, '요리');                 // '리' 1개 + '이' 2개
    assert.equal(turn.game.history[0].options, 3);
  } finally { await other.stop(); }
});

/* ---------------------------------------------------------------- 점수 */

test('점수: 등급에 따라 100 ~ 2,000점을 받고, 양쪽 점수가 따로 쌓인다', async () => {
  assert.deepEqual(POINTS, { easy: 100, normal: 250, tricky: 500, attack: 1000, kill: 2000 });
  assert.equal(Math.min(...Object.values(POINTS)), 100);
  assert.equal(Math.max(...Object.values(POINTS)), 2000);

  // '차'로 시작 12개 → 까다로움 500점, '표'로 시작 1개 → 공격 1,000점, '범'으로 시작 0개 → 한방 2,000점
  const many = Array.from({ length: 11 }, (_, i) => ['차' + '가나다라마바사아자카타'[i] + '기']);
  const other = await startGameStack({ words: [['기차'], ['차표'], ...many, ['표범']], lives: 3 });
  try {
    const { game } = await other.service.start({ player: '점수', level: 'easy' });
    assert.deepEqual(game.score, { player: 0, computer: 0 });

    const first = await other.service.play(game.id, '기차');              // 상대: 차표 (random 0 → 첫 후보)
    assert.deepEqual(first.game.history.map((h) => [h.word, h.grade, h.points]), [['기차', 'tricky', 512], ['차표', 'attack', 1012]]);     // 등급 점수 + 2글자 12
    assert.deepEqual(first.game.score, { player: 512, computer: 1012 });

    assert.equal((await other.service.play(game.id, '없는말')).game.score.player, 512);    // 거절된 단어는 점수가 없다
    const second = await other.service.play(game.id, '표범');             // 한방 → 상대 목숨 -1 → 새 라운드는 상대가 먼저 '기차'(까다로움 512점)
    assert.deepEqual(second.game.score, { player: 2524, computer: 1524 });
  } finally { await other.stop(); }
});

test('점수: 글자 수가 늘면 더해지는 점수도 는다 (3글자 단어)', async () => {
  const other = await startGameStack({ words: [['고구마'], ['마차']], lives: 3 });
  try {
    const { game } = await other.service.start({ player: '글자', level: 'easy' });
    const turn = await other.service.play(game.id, '고구마');               // '마'로 시작하는 단어 1개 → 공격 1000 + 3글자 27
    assert.equal(turn.game.history[0].points, 1027);
  } finally { await other.stop(); }
});

/* ---------------------------------------------------------------- 목숨 */

test('목숨: 양쪽 3개로 시작한다', async () => {
  assert.equal(LIVES, 3);
  const other = await startGameStack({ words: [['기차']], lives: LIVES });
  try {
    const { game } = await other.service.start({ player: '목숨' });
    assert.deepEqual(game.lives, { player: 3, computer: 3 });
  } finally { await other.stop(); }
});

test('목숨: 상대가 이을 단어가 없으면 상대가 하나를 잃고, 다음 라운드는 목숨을 잃은 상대가 먼저 낸다', async () => {
  // 단어 번호: 1 나비, 2 비누, 3 차표, 4 표범, 5 범인.  시작 단어 없음, 난수 0 → 상대가 먼저 낼 때는 1번 '나비'부터 본다
  const other = await startGameStack({ words: [['나비'], ['비누'], ['차표'], ['표범'], ['범인']], lives: 3 });
  try {
    const { game } = await other.service.start({ player: '승부', level: 'easy' });
    await other.service.play(game.id, '차표');                            // 상대: 표범

    const first = await other.service.play(game.id, '범인');              // 한방 → 상대 목숨 -1
    assert.deepEqual([first.accepted, first.computer, first.game.status], [true, null, 'playing']);
    assert.deepEqual(first.game.lives, { player: 3, computer: 2 });
    assert.deepEqual(first.game.history.slice(-2).map((h) => [h.by, h.word ?? h.reason]), [['life', 'computer-stuck'], ['computer', '나비']]);   // 진 상대가 먼저 냈다
    assert.deepEqual([first.game.need, first.game.firstMove], [['비'], false]);   // 상대가 첫 수를 뒀으니 나는 한방 단어를 내도 된다
    assert.ok(first.game.remainingMs > 9000);                             // 제한 시간도 다시 채워진다

    // 비누(한방) → 상대 목숨 -1 → 새 라운드는 나온 단어가 비워져서 상대가 '나비'를 다시 먼저 낸다
    const third = await other.service.play(game.id, '비누');
    assert.deepEqual([third.game.lives.computer, third.game.roundNo, third.game.history.at(-1).word], [1, 3, '나비']);
    const last = await other.service.play(game.id, '비누');               // 비누도 다시 낼 수 있다 → 상대 목숨 0
    assert.deepEqual(last.game.lives, { player: 3, computer: 0 });
    assert.deepEqual([last.game.status, last.game.result, last.game.reason], ['over', 'win', 'computer-stuck']);
    assert.equal(last.game.score.player, 7048);                           // 차표 1,012 + 범인 2,012 + 비누 2,012 × 2
    assert.equal((await other.service.record(last.game.recordId)).record.score, 7048);   // 점수가 판 기록에 저장된다
  } finally { await other.stop(); }
});

test('첫 턴 한방 금지: 라운드의 첫 단어로 한방 단어를 내면 받지 않는다', async () => {
  const { game } = await service.start({ player: '첫턴', level: 'easy' });
  assert.equal(game.firstMove, true);
  const rejected = await service.play(game.id, '범인');                 // '인'으로 시작하는 단어가 없다
  assert.deepEqual([rejected.accepted, rejected.reject.code], [false, 'first-kill']);
  assert.equal(await redis.get('game:' + game.id + ':used:범인'), null); // 받지 않았으니 나온 단어도 아니다
  assert.equal(rejected.game.lives.player, 1);                          // 목숨은 그대로, 시간만 흐른다
  assert.equal((await service.play(game.id, '기차')).accepted, true);
  await service.giveUp(game.id);
});

test('첫 턴 한방 금지 · 선공: 상대가 먼저면 첫 수로 한방 단어를 내지 않는다 (절대적이어도)', async () => {
  // 시작 단어 '기차' (1번). 후보: 차륜(끝내기) · 차표(공격). 절대적이면 원래 차륜을 낸다
  const other = await startGameStack({ words: [['기차'], ['차륜', true], ['차표'], ['표범']], randomStart: true, coin: () => 0.9 });
  try {
    const { game } = await other.service.start({ player: '후공', level: 'hard' });
    assert.equal(game.starter, 'computer');
    assert.deepEqual(game.history.map((h) => [h.by, h.word]), [['start', '기차'], ['computer', '차표']]);
    assert.deepEqual([game.need, game.firstMove], [['표'], false]);
  } finally { await other.stop(); }
});

test('라운드: 목숨을 잃을 때마다 라운드 번호가 오르고, 판의 길이는 목숨 수로 정해진다', async () => {
  const quick = await startGameStack({ words: WORDS, turnMs: 200, lives: 2 });
  try {
    const { game } = await quick.service.start({ player: '라운드', level: 'easy' });
    assert.equal(game.roundNo, 1);
    await sleep(300);
    const first = await quick.service.get(game.id);                       // 시간 초과 → 1라운드 끝
    assert.deepEqual([first.game.status, first.game.roundNo, first.game.lives.player], ['playing', 2, 1]);
    await sleep(300);
    const over = await quick.service.get(game.id);                        // 목숨 0 → 판이 끝난다
    assert.deepEqual([over.game.status, over.game.result, over.game.reason], ['over', 'lose', 'timeout']);
  } finally { await quick.stop(); }
});

test('목숨 수: 판마다 1~5개 중에서 고르고, 그 밖의 값이면 기본값을 쓴다', async () => {
  const picks = [];
  for (const lives of [1, 3, 5, 0, 6, 2.5, '4', undefined]) {
    const { game } = await service.start({ player: 'l', lives });
    picks.push(game.lives.player === game.lives.computer ? game.lives.player : 'x');
    await service.giveUp(game.id);
  }
  assert.deepEqual(picks, [1, 3, 5, 1, 1, 1, 4, 1]);                  // 이 테스트 묶음의 기본값은 1 (helper.js)
});

test('선공: 첫 라운드는 coin 으로 정한다 (0.5 미만이면 플레이어)', async () => {
  for (const [value, starter] of [[0, 'player'], [0.49, 'player'], [0.5, 'computer'], [0.99, 'computer']]) {
    const other = await startGameStack({ words: [['나비'], ['비누']], coin: () => value });
    try {
      const { game } = await other.service.start({ player: 'p', level: 'easy' });
      assert.equal(game.starter, starter, String(value));
      assert.equal(game.history.some((h) => h.by === 'computer'), starter === 'computer');
    } finally { await other.stop(); }
  }
});

test('목숨: 내가 이을 단어가 없으면 내가 하나를 잃고, 3번이면 진다', async () => {
  // 가방 → 방석 → '석' 없음,  나비 → 비누 → '누' 없음,  다리 → 이발('리'→'이') → '발' 없음
  const other = await startGameStack({ words: [['가방'], ['방석'], ['나비'], ['비누'], ['다리'], ['이발']], lives: 3 });
  try {
    const { game } = await other.service.start({ player: '패배', level: 'easy' });
    const first = await other.service.play(game.id, '가방');
    assert.equal(first.computer.word, '방석');
    assert.deepEqual([first.game.lives, first.game.status], [{ player: 2, computer: 3 }, 'playing']);
    assert.deepEqual(first.game.history.at(-1), { by: 'life', who: 'player', reason: 'no-word', left: 2 });

    assert.deepEqual((await other.service.play(game.id, '나비')).game.lives, { player: 1, computer: 3 });
    const last = await other.service.play(game.id, '다리');
    assert.deepEqual([last.game.lives, last.game.result, last.game.reason], [{ player: 0, computer: 3 }, 'lose', 'no-word']);
  } finally { await other.stop(); }
});

test('목숨: 시간 초과면 하나를 잃고 제한 시간이 다시 채워진다. 낸 단어는 받지 않는다', async () => {
  const quick = await startGameStack({ words: [['기차'], ['차표'], ['표범']], turnMs: 150, lives: 3 });
  try {
    const { game } = await quick.service.start({ player: '느림', level: 'easy' });
    await sleep(220);
    const late = await quick.service.play(game.id, '기차');
    assert.deepEqual([late.accepted, late.reject.code, late.game.status], [false, 'timeout', 'playing']);
    assert.deepEqual(late.game.lives, { player: 2, computer: 3 });
    assert.deepEqual(late.game.history, [{ by: 'life', who: 'player', reason: 'timeout', left: 2 }]);
    assert.ok(late.game.remainingMs > 100);

    await sleep(220);
    assert.deepEqual((await quick.service.get(game.id)).game.lives, { player: 1, computer: 3 });   // 조회만 해도 반영된다
    assert.deepEqual((await quick.service.get(game.id)).game.lives, { player: 1, computer: 3 });   // 같은 시간 초과로 두 번 잃지 않는다
    await sleep(220);
    const over = await quick.service.get(game.id);
    assert.deepEqual([over.game.lives.player, over.game.result, over.game.reason], [0, 'lose', 'timeout']);
  } finally { await quick.stop(); }
});

test('라운드: 새 라운드에서는 나온 단어가 비워진다 (끄투처럼 라운드마다)', async () => {
  // 단어 번호: 1 범인, 2 기차, 3 차표, 4 표범.  난수 0.3 → 2번 '기차'
  const other = await startGameStack({ words: [['범인'], ['기차'], ['차표'], ['표범']], lives: 3, randomStart: true, random: () => 0.3 });
  try {
    const { game } = await other.service.start({ player: '새시작', level: 'easy' });
    assert.equal(game.history[0].word, '기차');
    const first = await other.service.play(game.id, '차표');              // 상대: 표범 → '범인' 이 남아 있다
    assert.equal(first.computer.word, '표범');
    const second = await other.service.play(game.id, '범인');             // 상대가 이을 단어 없음 → 상대 목숨 -1
    // 새 라운드: 나온 단어가 비워져 '기차'가 다시 시작 단어가 되고, 진 상대가 먼저 '차표'를 낸다
    assert.deepEqual(second.game.history.slice(-3).map((h) => h.by + ':' + (h.word ?? h.who)), ['life:computer', 'start:기차', 'computer:차표']);
    assert.deepEqual([second.game.roundNo, second.game.need, second.game.status], [2, ['표'], 'playing']);
    assert.ok(second.trace.some((t) => t.label.startsWith('새 라운드 2:')));
    assert.equal((await other.service.play(game.id, '표범')).accepted, true);    // 1라운드에 나온 '표범'을 다시 낼 수 있다
  } finally { await other.stop(); }
});

test('목숨: 포기하면 남은 목숨과 상관없이 판이 끝난다', async () => {
  const other = await startGameStack({ words: [['기차']], lives: 3 });
  try {
    const { game } = await other.service.start({ player: '포기' });
    const over = await other.service.giveUp(game.id);
    assert.deepEqual([over.game.status, over.game.result, over.game.reason, over.game.lives.player], ['over', 'lose', 'give-up', 3]);
  } finally { await other.stop(); }
});
