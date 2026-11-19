/* ======================================================================
 * words/analyze.js — 게임 사전에서 한방 단어 · 공격 단어 · 방어 단어를 찾는다
 *
 *   node words/analyze.js                    words.txt 만으로 분석
 *   node words/analyze.js <사전.json>        쉬운 단어 표시도 함께 (국어 기초사전에 실린 단어에 * 를 붙인다)
 *
 *   기준 (게임 규칙 그대로: 두음법칙 인정, 이미 나온 단어는 못 냄)
 *     이을 수 있는 단어 수(c) = c 로 시작하는 단어 수 + 두음법칙으로 바뀐 글자로 시작하는 단어 수
 *
 *     한방 글자 : 이을 수 있는 단어가 0개인 끝 글자          → 한방 단어 = 그 글자로 끝나는 단어 (받은 쪽이 바로 진다)
 *     공격 글자 : 이을 수 있는 단어가 1 ~ ATTACK_MAX 개인 끝 글자 → 공격 단어 = 그 글자로 끝나는 단어 (받은 쪽의 선택지가 적다)
 *     방어 단어 : 공격 글자로 시작하는 단어 (공격을 받았을 때 낼 수 있는 단어)
 *                   역공 : 그 단어 자체가 한방 글자로 끝난다 → 받아치면서 끝낸다
 *                   반격 : 공격 글자로 끝난다               → 받아치면서 다시 몰아넣는다
 *                   안전 : 그 밖 (끝 글자로 이을 단어가 많다)
 *
 *   자기 자신만 이을 수 있는 경우(예: '○…○' 한 단어뿐)는 이미 나온 단어라 못 내므로 0개로 센다.
 *   결과는 words/report/ 에 쓴다. 사전(words.txt, remove.txt)이 바뀌면 다시 실행한다.
 * ====================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dueum, WORD_PATTERN } from '../game/rules.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OUT = path.join(HERE, 'report');
const ATTACK_MAX = 10;                   // 이을 단어가 이 개수 이하면 공격 글자로 본다
const SAMPLE = 40;                       // 글자마다 보여 주는 단어 수

const readList = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim().normalize('NFC')).filter((w) => WORD_PATTERN.test(w)) : []);
const gone = new Set(readList(path.join(HERE, 'remove.txt')));
const words = [...new Set([...readList(path.join(HERE, 'words.txt')), ...readList(path.join(HERE, 'finishers.txt'))])].filter((w) => !gone.has(w));

// 쉬운 단어: 국어 기초사전(krdict-basic) 이나 흔한 명사 목록(wordle-common-nouns)에 실린 단어
const easy = new Set();
if (process.argv[2]) {
  for (const entry of JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).words) {
    if (entry.sources.some((s) => s.startsWith('krdict-basic') || s === 'wordle-common-nouns')) easy.add(entry.word);
  }
}
const mark = (word) => (easy.has(word) ? word + '*' : word);
const easyFirst = (list) => [...list].sort((a, b) => (easy.has(b) - easy.has(a)) || a.length - b.length || a.localeCompare(b, 'ko'));

/* ---------------------------------------------------------------- 글자별 집계 */
const byFirst = new Map(), byLast = new Map();
const push = (map, key, word) => { if (!map.has(key)) map.set(key, []); map.get(key).push(word); };
for (const word of words) { push(byFirst, word[0], word); push(byLast, word[word.length - 1], word); }

/** c 로 끝난 단어 다음에 낼 수 있는 단어들 (두음법칙 포함) */
function repliesTo(char) {
  const changed = dueum(char);
  return [...(byFirst.get(char) || []), ...(changed ? byFirst.get(changed) || [] : [])];
}
/** word 를 낸 뒤 상대가 이을 수 있는 단어 수 (word 자신은 뺀다) */
const optionsAfter = (word) => { const r = repliesTo(word[word.length - 1]); return r.length - (r.includes(word) ? 1 : 0); };

const lastChars = [...byLast.keys()];
const count = new Map(lastChars.map((c) => [c, repliesTo(c).length]));
const kind = (word) => { const n = optionsAfter(word); return n === 0 ? '역공' : n <= ATTACK_MAX ? '반격' : '안전'; };

const oneShotChars = [], attackChars = [];
for (const char of lastChars) {
  const enders = byLast.get(char), n = count.get(char);
  const killers = enders.filter((w) => optionsAfter(w) === 0);      // 자기 자신만 이을 수 있는 단어 포함
  if (n === 0 || killers.length === enders.length) oneShotChars.push({ char, words: enders });
  else if (n <= ATTACK_MAX) attackChars.push({ char, n, words: enders, replies: repliesTo(char) });
}
oneShotChars.sort((a, b) => b.words.length - a.words.length);
attackChars.sort((a, b) => a.n - b.n || b.words.length - a.words.length);

/* ---------------------------------------------------------------- 파일 쓰기 */
fs.mkdirSync(OUT, { recursive: true });
const f = (n) => n.toLocaleString('ko-KR');
const note = easy.size ? ' (* 는 국어 기초사전에 실린 쉬운 단어)' : '';
const write = (name, lines) => fs.writeFileSync(path.join(OUT, name), lines.join('\n') + '\n');

const oneShotWords = oneShotChars.flatMap((g) => g.words);
write('한방-글자별.txt', [
  '# 한방 단어 — 끝 글자로 이을 수 있는 단어가 사전에 하나도 없는 단어' + note,
  '# 글자마다: 끝 글자 | 그 글자로 끝나는 단어 수 | 단어들 (쉬운 단어, 짧은 단어 먼저. 최대 ' + SAMPLE + '개)',
  '# 한방 글자 ' + f(oneShotChars.length) + '종류, 한방 단어 ' + f(oneShotWords.length) + '개 (사전 ' + f(words.length) + '개 기준)',
  '',
  ...oneShotChars.map((g) => g.char + ' | ' + g.words.length + '개 | ' + easyFirst(g.words).slice(0, SAMPLE).map(mark).join(' ') + (g.words.length > SAMPLE ? ' …' : '')),
]);
write('한방-쉬운단어.txt', [
  '# 한방 단어 중 국어 기초사전에 실린 쉬운 단어 — 한 줄에 하나',
  '# 끝내기 단어(words/finishers.txt)로 쓰기 좋은 후보다. 그대로 복사해 붙이면 된다.',
  '',
  ...easyFirst(oneShotWords.filter((w) => easy.has(w))),
]);
write('한방-전체.txt', ['# 한방 단어 전체 — 한 줄에 하나', '', ...oneShotWords.sort((a, b) => a.localeCompare(b, 'ko'))]);

write('공격-글자별.txt', [
  '# 공격 단어 — 끝 글자로 이을 수 있는 단어가 1 ~ ' + ATTACK_MAX + '개뿐인 단어' + note,
  '# 글자마다 두 줄:',
  '#   끝 글자 | 이을 수 있는 단어 수 | 이을 수 있는 단어 전부 (= 상대가 낼 수 있는 방어 단어)',
  '#     공격 단어 수 | 그 글자로 끝나는 단어들 (최대 ' + SAMPLE + '개)',
  '# 공격 글자 ' + f(attackChars.length) + '종류, 공격 단어 ' + f(attackChars.reduce((s, g) => s + g.words.length, 0)) + '개',
  '',
  ...attackChars.flatMap((g) => [
    g.char + ' | 이을 단어 ' + g.n + '개 | ' + easyFirst(g.replies).map(mark).join(' '),
    '    공격 단어 ' + g.words.length + '개 | ' + easyFirst(g.words).slice(0, SAMPLE).map(mark).join(' ') + (g.words.length > SAMPLE ? ' …' : ''),
  ]),
]);

const tagged = attackChars.map((g) => ({ ...g, replies: easyFirst(g.replies).map((w) => ({ word: w, kind: kind(w) })) }));
const order = { 역공: 0, 반격: 1, 안전: 2 };
write('방어-글자별.txt', [
  '# 방어 단어 — 공격 글자를 받았을 때 낼 수 있는 단어와 그 성격' + note,
  '#   역공: 받아치면서 끝낸다 (그 단어가 한방 글자로 끝남)',
  '#   반격: 받아치면서 다시 몰아넣는다 (공격 글자로 끝남)',
  '#   안전: 그냥 받아낸다 (끝 글자로 이을 단어가 많음)',
  '# 글자마다: 받은 글자 | 이을 단어 수 | 단어[성격] …   (공격을 많이 받는 글자부터)',
  '',
  ...[...tagged].sort((a, b) => b.words.length - a.words.length).map((g) =>
    g.char + ' | ' + g.n + '개 | ' + [...g.replies].sort((a, b) => order[a.kind] - order[b.kind]).map((r) => mark(r.word) + '[' + r.kind + ']').join(' ')),
]);

/* ---------------------------------------------------------------- 요약 출력 */
const easyKill = oneShotWords.filter((w) => easy.has(w));
const allReplies = tagged.flatMap((g) => g.replies);
console.log('사전 ' + f(words.length) + '개, 끝 글자 ' + f(lastChars.length) + '종류, 시작 글자 ' + f(byFirst.size) + '종류');
console.log('한방 글자 ' + f(oneShotChars.length) + '종류 / 한방 단어 ' + f(oneShotWords.length) + '개' + (easy.size ? ' (쉬운 단어 ' + f(easyKill.length) + '개)' : ''));
console.log('공격 글자 ' + f(attackChars.length) + '종류 / 공격 단어 ' + f(attackChars.reduce((s, g) => s + g.words.length, 0)) + '개');
for (const n of [1, 2, 3]) console.log('  이을 단어가 ' + n + '개뿐인 글자 ' + f(attackChars.filter((g) => g.n === n).length) + '종류');
console.log('방어 단어 ' + f(allReplies.length) + '개: 역공 ' + f(allReplies.filter((r) => r.kind === '역공').length) + ', 반격 ' + f(allReplies.filter((r) => r.kind === '반격').length) + ', 안전 ' + f(allReplies.filter((r) => r.kind === '안전').length));
console.log('\n한방 단어가 많은 글자 15개');
for (const g of oneShotChars.slice(0, 15)) console.log('  ' + g.char + ' ' + g.words.length + '개: ' + easyFirst(g.words).slice(0, 8).map(mark).join(' '));
console.log('\n공격 단어가 많은 글자 15개 (이을 단어 ' + ATTACK_MAX + '개 이하)');
for (const g of [...attackChars].sort((a, b) => b.words.length - a.words.length).slice(0, 15)) {
  console.log('  ' + g.char + ' 공격 단어 ' + g.words.length + '개, 이을 단어 ' + g.n + '개: ' + easyFirst(g.replies).slice(0, 6).map(mark).join(' '));
}
console.log('\n결과 파일: ' + OUT);
