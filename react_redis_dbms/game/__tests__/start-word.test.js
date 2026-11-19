/* 시작 단어 테스트: 판을 열 때 2~3글자 단어를 무작위로 제시한다 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startGameStack } from './helper.js';

/** 정해 둔 값을 차례로 돌려주고, 다 쓰면 0 을 돌려주는 난수 함수 */
const sequence = (...values) => () => (values.length ? values.shift() : 0);

// 단어 번호: 1 끝말잇기, 2 기차, 3 차표, 4 범인, 5 표범
const WORDS = [['끝말잇기'], ['기차'], ['차표'], ['범인'], ['표범']];

test('시작 단어: 4글자 이상과 이을 수 없는 단어는 건너뛰고, 2~3글자 단어를 제시한다', async () => {
  // 0 → 1번 '끝말잇기' (4글자라 건너뜀), 0.7 → 4번 '범인' ('인'으로 시작하는 단어가 없어 건너뜀), 0.3 → 2번 '기차'
  const stack = await startGameStack({ words: WORDS, randomStart: true, random: sequence(0, 0.7, 0.3) });
  try {
    const { game, trace } = await stack.service.start({ player: '시작', level: 'easy' });
    assert.deepEqual(game.history, [{ by: 'start', word: '기차', options: 1, grade: 'attack', points: 0 }]);   // '차'로 시작하는 단어는 '차표' 하나
    assert.deepEqual(game.need, ['차']);
    assert.equal(game.turns, 0);
    assert.equal(game.status, 'playing');

    const picks = trace.filter((t) => t.label.startsWith('시작 단어 뽑기'));
    assert.equal(picks.length, 3);
    for (const pick of picks) assert.equal(pick.plan, 'INDEX_POINT');             // 단어 번호로 찾으므로 B+ 트리 인덱스를 쓴다
    assert.equal(stack.store.get('game:' + game.id + ':used:기차'), 1);            // 시작 단어도 이번 라운드에 나온 단어다
  } finally { await stack.stop(); }
});

test('시작 단어: 플레이어는 시작 단어의 끝 글자로 이어야 한다', async () => {
  const stack = await startGameStack({ words: WORDS, randomStart: true, random: sequence(0.3) });
  try {
    const { game } = await stack.service.start({ player: '잇기', level: 'easy' });
    assert.equal(game.history[0].word, '기차');

    assert.equal((await stack.service.play(game.id, '표범')).reject.code, 'start');
    assert.equal((await stack.service.play(game.id, '기차')).reject.code, 'start');

    const turn = await stack.service.play(game.id, '차표');
    assert.equal(turn.accepted, true);
    assert.equal(turn.computer.word, '표범');
    assert.deepEqual(turn.game.history.map((h) => h.by), ['start', 'player', 'computer']);
    assert.equal(turn.game.turns, 2);                                               // 시작 단어는 이은 횟수에 넣지 않는다
  } finally { await stack.stop(); }
});

test('시작 단어: 사전이 비어 있으면 제시하지 않고, 플레이어가 아무 단어로 시작한다', async () => {
  const stack = await startGameStack({ randomStart: true });
  try {
    const { game, trace } = await stack.service.start({ player: '빈사전' });
    assert.deepEqual([game.history, game.need], [[], null]);
    assert.deepEqual(trace, []);
  } finally { await stack.stop(); }
});

test('시작 단어: 쓸 수 있는 단어가 없으면 30번 뽑아 보고 포기한다', async () => {
  const stack = await startGameStack({ words: [['끝말잇기'], ['범인'], ['기러기']], randomStart: true, random: Math.random });
  try {
    const { game, trace } = await stack.service.start({ player: '없음' });
    assert.deepEqual([game.history, game.need], [[], null]);
    assert.equal(trace.filter((t) => t.label.startsWith('시작 단어 뽑기')).length, 30);
    assert.equal((await stack.service.play(game.id, '끝말잇기')).accepted, true);   // 아무 등록 단어로 시작할 수 있다 (한방 단어는 빼고)
  } finally { await stack.stop(); }
});

test('시작 단어: 실제 난수로 여러 판을 열어도 항상 2~3글자이고 이을 단어가 있다', async () => {
  const words = [['끝말잇기'], ['기차'], ['차표'], ['표범'], ['범인'], ['요리'], ['이발'], ['발표'], ['나트륨'], ['기러기'], ['기름']];
  const stack = await startGameStack({ words, randomStart: true, random: Math.random });
  try {
    const all = new Set(words.map((w) => w[0]));
    for (let i = 0; i < 25; i++) {
      const { game } = await stack.service.start({ player: 'p' + i });
      const word = game.history[0].word;
      assert.ok(word.length === 2 || word.length === 3, word);
      assert.ok([...all].some((next) => next !== word && game.need.includes(next[0])), word + ' 다음에 이을 단어가 있어야 한다');
    }
  } finally { await stack.stop(); }
});
