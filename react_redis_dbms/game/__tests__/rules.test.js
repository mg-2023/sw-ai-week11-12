/* rules.js 단위 테스트: 두음법칙, 단어 판정, 상대의 단어 선택 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORD_PATTERN, LEVELS, ROUND_TIMES, DEFAULT_ROUND, FINISHER_CHANCE, dueum, nextStartChars, rejectReason, pickWord, gradeOf, letterPoints, thinkTime, THINK } from '../rules.js';

test('단어 형식: 한글 음절 2글자 이상만', () => {
  for (const ok of ['기차', '끝말잇기', '뷁뷁']) assert.equal(WORD_PATTERN.test(ok), true, ok);
  for (const bad of ['', '기', 'ab', '기차1', '기 차', 'ㄱㄴ', '기차!', "기'차"]) assert.equal(WORD_PATTERN.test(bad), false, bad);
});

test('두음법칙: ㄹ → ㅇ', () => {
  assert.equal(dueum('리'), '이');
  assert.equal(dueum('력'), '역');
  assert.equal(dueum('례'), '예');
  assert.equal(dueum('룡'), '용');
  assert.equal(dueum('류'), '유');
  assert.equal(dueum('량'), '양');
});

test('두음법칙: ㄹ → ㄴ', () => {
  assert.equal(dueum('래'), '내');
  assert.equal(dueum('락'), '낙');
  assert.equal(dueum('로'), '노');
  assert.equal(dueum('뢰'), '뇌');
  assert.equal(dueum('루'), '누');
  assert.equal(dueum('름'), '늠');
});

test('두음법칙: ㄴ → ㅇ', () => {
  assert.equal(dueum('녀'), '여');
  assert.equal(dueum('뇨'), '요');
  assert.equal(dueum('뉴'), '유');
  assert.equal(dueum('니'), '이');
  assert.equal(dueum('념'), '염');
});

test('두음법칙: 해당하지 않는 글자는 null', () => {
  for (const char of ['차', '나', '너', '노', '러', '레', '이', '가', 'a', '1', 'ㄹ']) assert.equal(dueum(char), null, char);
});

test('다음 단어가 시작할 수 있는 글자', () => {
  assert.deepEqual(nextStartChars('기차'), ['차']);
  assert.deepEqual(nextStartChars('요리'), ['리', '이']);
  assert.deepEqual(nextStartChars('미래'), ['래', '내']);
  assert.deepEqual(nextStartChars('소녀'), ['녀', '여']);
});

test('단어 판정: 통과하면 null', () => {
  assert.equal(rejectReason('기차'), null);
  assert.equal(rejectReason('이발', { need: ['리', '이'] }), null);
  assert.equal(rejectReason('리본', { need: ['리', '이'] }), null);
});

test('단어 판정: 거절 이유는 형식 → 시작 글자 → 이미 나옴 → 미등록 순으로 본다', () => {
  assert.equal(rejectReason('기').code, 'format');
  assert.equal(rejectReason('abc').code, 'format');
  assert.equal(rejectReason('기차', { need: ['차'] }).code, 'start');
  assert.equal(rejectReason('차표', { need: ['차'], used: true, known: false }).code, 'used');
  assert.equal(rejectReason('차표', { need: ['차'], known: false }).code, 'unknown');
  assert.match(rejectReason('기차', { need: ['리', '이'] }).message, /'리' 또는 '이'/);
  assert.equal(rejectReason('범인', { firstKill: true }).code, 'first-kill');            // 라운드의 첫 단어로 한방 단어
  assert.equal(rejectReason('범인', { firstKill: false }), null);
});

const CANDIDATES = [{ word: '차표', finisher: false }, { word: '차도', finisher: false }, { word: '차륜', finisher: true }];

test('라운드 시간 선택지는 끄투와 같고, 기본은 60초다', () => {
  assert.deepEqual(ROUND_TIMES, [10, 30, 60, 90, 120, 150]);
  assert.equal(DEFAULT_ROUND, 60);
});

test('상대의 선택: 후보가 없으면 null', () => {
  for (const level of LEVELS) assert.equal(pickWord([], level), null);
});

test('상대의 선택: easy 는 끝내기 단어를 쓰지 않는다', () => {
  for (const r of [0, 0.5, 0.99]) assert.equal(pickWord(CANDIDATES, 'easy', () => r).finisher, false);
  assert.equal(pickWord([{ word: '차륜', finisher: true }], 'easy'), null);
});

test('상대의 선택: hard 는 끝내기 단어가 있으면 항상 낸다', () => {
  for (const r of [0, 0.5, 0.99]) assert.equal(pickWord(CANDIDATES, 'hard', () => r).word, '차륜');
  assert.equal(pickWord(CANDIDATES.slice(0, 2), 'hard', () => 0).word, '차표');
});

test('난이도는 5단계이고 끝내기 단어를 낼 확률이 0 · 25 · 50 · 75 · 100% 다', () => {
  assert.deepEqual(LEVELS, ['easy', 'mild', 'normal', 'tough', 'hard']);
  assert.deepEqual(LEVELS.map((level) => FINISHER_CHANCE[level]), [0, 0.25, 0.5, 0.75, 1]);
});

test('상대의 선택: mild · normal · tough 는 난수가 확률보다 작을 때만 끝내기 단어를 낸다', () => {
  for (const [level, chance] of [['mild', 0.25], ['normal', 0.5], ['tough', 0.75]]) {
    assert.equal(pickWord(CANDIDATES, level, () => chance - 0.01).word, '차륜', level);
    assert.equal(pickWord(CANDIDATES, level, () => chance).finisher, false, level);
    assert.equal(pickWord([{ word: '차륜', finisher: true }], level, () => 0.99).word, '차륜', level);   // 끝내기 단어뿐이면 그것을 낸다
    assert.equal(pickWord(CANDIDATES.slice(0, 2), level, () => 0).finisher, false, level);                // 끝내기 단어가 없으면 일반 단어를 낸다
  }
});

test('상대의 선택: 난이도가 높을수록 끝내기 단어를 더 자주 낸다 (1만 번씩 뽑아 확률 확인)', () => {
  const rates = LEVELS.map((level) => {
    let finishers = 0;
    for (let i = 0; i < 10000; i++) if (pickWord(CANDIDATES, level).finisher) finishers++;
    return finishers / 10000;
  });
  const expected = [0, 0.25, 0.5, 0.75, 1];
  rates.forEach((rate, i) => assert.ok(Math.abs(rate - expected[i]) < 0.03, LEVELS[i] + ' ' + rate));
});

test('상대의 선택: 모르는 난이도는 normal 로 본다', () => {
  assert.equal(pickWord(CANDIDATES, 'god', () => 0.49).word, '차륜');
  assert.equal(pickWord(CANDIDATES, 'god', () => 0.5).finisher, false);
});

test('상대의 선택: 난수에 따라 후보가 골고루 나온다', () => {
  const normals = CANDIDATES.slice(0, 2);
  assert.equal(pickWord(normals, 'easy', () => 0).word, '차표');
  assert.equal(pickWord(normals, 'easy', () => 0.5).word, '차도');
  assert.equal(pickWord(normals, 'easy', () => 0.999).word, '차도');
});

// 등급마다 후보를 하나씩 (넉넉은 두 개) 둔다. 단어 이름이 곧 등급이다 (pickWord 는 단어 뜻을 보지 않는다)
const GRADED = [{ word: '한방', finisher: true }, { word: '공격', finisher: false }, { word: '까다', finisher: false },
  { word: '보통', finisher: false }, { word: '넉넉일', finisher: false }, { word: '넉넉이', finisher: false }];
const GRADE_OF = { 공격: 'attack', 까다: 'tricky', 보통: 'normal', 넉넉일: 'easy', 넉넉이: 'easy' };
const gradeOfWord = (word) => GRADE_OF[word];
const only = (...words) => GRADED.filter((c) => words.includes(c.word));
/** 정해 둔 난수를 차례로 돌려주고, 몇 번 불렸는지 센다 */
function sequence(...values) {
  const next = () => values[next.calls++];
  next.calls = 0;
  return next;
}

test('상대의 선택: 센 등급부터 차례로 확률을 굴려, 처음 걸린 등급에서 낸다', () => {
  assert.equal(pickWord(GRADED, 'normal', sequence(0.4, 0), gradeOfWord).word, '한방');                 // 한방 굴림 성공
  assert.equal(pickWord(GRADED, 'normal', sequence(0.9, 0.4, 0), gradeOfWord).word, '공격');            // 한방 실패 → 공격 성공
  assert.equal(pickWord(GRADED, 'normal', sequence(0.9, 0.9, 0.9, 0.4, 0), gradeOfWord).word, '보통');  // 한방 · 공격 · 까다로움 실패 → 보통 성공
});

test('상대의 선택: 넉넉 앞까지 모두 실패하면 넉넉에서 낸다 (마지막 등급은 굴리지 않는다)', () => {
  const random = sequence(0.9, 0.9, 0.9, 0.9, 0.5);
  assert.equal(pickWord(GRADED, 'normal', random, gradeOfWord).word, '넉넉이');      // 넉넉 두 개 중 0.5 → 두 번째
  assert.equal(random.calls, 5);                                                      // 굴림 4번 + 넉넉 안에서 고르기 1번
});

test('상대의 선택: 후보가 없는 등급은 굴리지 않고 건너뛰고, 넉넉이 없으면 남은 가장 약한 등급에서 낸다', () => {
  assert.equal(pickWord(only('한방', '보통', '넉넉일'), 'normal', sequence(0.9, 0.4, 0), gradeOfWord).word, '보통');   // 공격 · 까다로움은 건너뜀
  const random = sequence(0.9, 0);
  assert.equal(pickWord(only('공격', '보통'), 'normal', random, gradeOfWord).word, '보통');                            // 공격 실패 → 남은 가장 약한 등급
  assert.equal(random.calls, 2);
});

test('상대의 선택: hard 는 있는 것 중 가장 센 등급, easy 는 끝내기 단어 없이 가장 약한 등급에서 낸다', () => {
  for (const r of [0, 0.5, 0.99]) {
    assert.equal(pickWord(GRADED, 'hard', () => r, gradeOfWord).word, '한방');
    assert.equal(pickWord(only('공격', '까다', '넉넉일'), 'hard', () => r, gradeOfWord).word, '공격');
    assert.equal(GRADE_OF[pickWord(GRADED, 'easy', () => r, gradeOfWord).word], 'easy');
    assert.equal(pickWord(only('한방', '공격', '보통'), 'easy', () => r, gradeOfWord).word, '보통');
  }
  assert.equal(pickWord(only('한방'), 'easy', () => 0, gradeOfWord), null);           // 끝내기 단어밖에 없으면 진다
});

test('상대의 선택: 다섯 등급이 다 있을 때 등급별 비율 (2만 번씩 뽑아 확인)', () => {
  const expected = {                                   // p, (1-p)p, (1-p)²p, (1-p)³p, (1-p)⁴
    mild: [0.25, 0.1875, 0.140625, 0.10546875, 0.31640625],
    normal: [0.5, 0.25, 0.125, 0.0625, 0.0625],
    tough: [0.75, 0.1875, 0.046875, 0.01171875, 0.00390625],
  };
  const order = ['kill', 'attack', 'tricky', 'normal', 'easy'];
  for (const [level, rates] of Object.entries(expected)) {
    const counts = Object.fromEntries(order.map((g) => [g, 0]));
    for (let i = 0; i < 20000; i++) {
      const c = pickWord(GRADED, level, Math.random, gradeOfWord);
      counts[c.finisher ? 'kill' : GRADE_OF[c.word]]++;
    }
    order.forEach((g, i) => assert.ok(Math.abs(counts[g] / 20000 - rates[i]) < 0.02, level + ' ' + g + ' ' + counts[g] / 20000));
  }
});

test('등급: 이을 수 있는 단어 수로 다섯 등급을 나눈다', () => {
  const cases = [[0, 'kill'], [1, 'attack'], [10, 'attack'], [11, 'tricky'], [100, 'tricky'], [101, 'normal'], [1000, 'normal'], [1001, 'easy'], [50000, 'easy']];
  for (const [options, grade] of cases) assert.equal(gradeOf(options), grade, String(options));
});

test('글자 수 점수: 9글자까지는 10글자(300)에 대한 비율의 제곱, 10글자는 300점, 그 뒤로 한 글자마다 60점이 더해진다', () => {
  const cases = [[2, 12], [3, 27], [4, 48], [5, 75], [9, 243], [10, 300], [11, 360], [12, 420], [20, 900]];
  for (const [length, points] of cases) assert.equal(letterPoints(length), points, String(length));
});

test('thinkTime: 남은 라운드 시간이 넉넉하면 0.5~1초, 0 에 가까울수록 0.1~0.2초 (그 사이는 비례)', () => {
  assert.deepEqual(THINK, { slow: [500, 1000], fast: [100, 200], easeMs: 10_000 });
  const range = (left) => [thinkTime(left, () => 0), thinkTime(left, () => 1)];
  assert.deepEqual(range(150_000), [500, 1000]);
  assert.deepEqual(range(10_000), [500, 1000]);
  assert.deepEqual(range(5_000), [300, 600]);
  assert.deepEqual(range(1_000), [140, 280]);
  assert.deepEqual(range(0), [100, 200]);
  assert.deepEqual(range(-5), [100, 200]);
  assert.equal(thinkTime(10_000, () => 0.5), 750);
});
