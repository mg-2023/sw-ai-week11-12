/* ======================================================================
 * words/from-dictionary.js — 합쳐 둔 사전 JSON 에서 끝말잇기에 쓸 단어를 골라 words.txt 로 만든다
 *
 *   node words/from-dictionary.js <사전.json>                      일반 명사만
 *   node words/from-dictionary.js <사전.json> --mecab <폴더>       + 지명과 널리 알려진 이름 (아래 ④)
 *   node words/from-dictionary.js <사전.json> --proper             + 고유명사 전부 (일반인 이름 약 30만 개 포함)
 *
 *   사전 JSON 형식: { words: [{ word, syllables, pos: [품사…], nounCandidate }, …] }
 *
 *   고르는 기준
 *     ① 명사로 표시된 것 (nounCandidate)          동사·형용사·부사만인 항목은 뺀다
 *     ② 2글자 이상                               끝말잇기는 한 글자 단어를 쓰지 않는다
 *     ③ 품사가 '고유명사'뿐인 항목은 뺀다          서울·이순신·피카소처럼 국어사전에도 실린 고유명사는 ③에 걸리지 않고 들어간다
 *     ④ --mecab <mecab-ko-dic 원본 폴더> 를 주면, ③에서 빠진 것 중 아래 파일에 있는 단어를 다시 넣는다
 *          Place.csv · Place-address.csv · Place-station.csv   지명 (나라·도시·산·강, 읍면동리, 역)
 *          Wikipedia.csv · NNP.csv · Group.csv                  위키백과 표제어, 그 밖의 고유명사, 단체 이름
 *        사람 이름 파일(Person.csv, Person-actor.csv)은 넣지 않는다. 유명인과 일반인을 구분할 정보가 없기 때문이다.
 *     ⑤ words/extra.txt 가 있으면 그 단어들을 더한다   (유명인 이름처럼 손으로 고른 단어. 한 줄에 하나)
 *     ⑥ words/remove.txt 가 있으면 그 단어들을 뺀다    (화면에서 삭제한 단어가 여기에 적힌다)
 *
 *   words.txt 를 새로 쓴다. finishers.txt, extra.txt, remove.txt 는 건드리지 않는다.
 *   만든 뒤 서버를 끄고 `npm run words:reset` 을 실행하면 사전 테이블이 이 파일로 다시 채워진다.
 * ====================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OUT = path.join(HERE, 'words.txt'), EXTRA = path.join(HERE, 'extra.txt'), REMOVE = path.join(HERE, 'remove.txt');
const WORD = /^[가-힣]{2,}$/;
const PLACE_FILES = ['Place.csv', 'Place-address.csv', 'Place-station.csv'];
const NAME_FILES = ['Wikipedia.csv', 'NNP.csv', 'Group.csv'];

const option = (name) => { const i = process.argv.indexOf(name); return i === -1 ? null : process.argv[i + 1]; };
const source = process.argv[2];
const withProper = process.argv.includes('--proper');
const mecabDir = option('--mecab');
if (!source || source.startsWith('--')) { console.error('사용법: node words/from-dictionary.js <사전.json> [--mecab <mecab-ko-dic 폴더>] [--proper]'); process.exit(1); }

/** mecab-ko-dic 의 CSV 파일들에서 첫 칸(단어)만 모은다 */
function surfaces(files) {
  const set = new Set();
  for (const file of files) {
    for (const line of fs.readFileSync(path.join(mecabDir, file), 'utf8').split(/\r?\n/)) {
      const word = line.slice(0, line.indexOf(',')).normalize('NFC');
      if (WORD.test(word)) set.add(word);
    }
  }
  return set;
}
const places = mecabDir ? surfaces(PLACE_FILES) : new Set();
const names = mecabDir ? surfaces(NAME_FILES) : new Set();

const dictionary = JSON.parse(fs.readFileSync(source, 'utf8'));
const counts = { total: dictionary.words.length, notNoun: 0, oneSyllable: 0, properOnly: 0, badForm: 0, place: 0, name: 0, extra: 0, removed: 0 };
const picked = new Set();

for (const entry of dictionary.words) {
  if (!/^[가-힣]+$/.test(entry.word)) { counts.badForm++; continue; }
  if (!entry.nounCandidate) { counts.notNoun++; continue; }
  if (entry.word.length < 2) { counts.oneSyllable++; continue; }
  if (!withProper && entry.pos.length > 0 && entry.pos.every((p) => p === '고유명사')) {
    if (places.has(entry.word)) counts.place++;
    else if (names.has(entry.word)) counts.name++;
    else { counts.properOnly++; continue; }
  }
  picked.add(entry.word);
}

// ⑤ 손으로 고른 단어
if (fs.existsSync(EXTRA)) {
  for (const line of fs.readFileSync(EXTRA, 'utf8').split(/\r?\n/)) {
    const word = line.trim().normalize('NFC');
    if (WORD.test(word) && !picked.has(word)) { picked.add(word); counts.extra++; }
  }
}

// ⑥ 삭제 목록의 단어는 뺀다
if (fs.existsSync(REMOVE)) {
  for (const line of fs.readFileSync(REMOVE, 'utf8').split(/\r?\n/)) {
    if (picked.delete(line.trim().normalize('NFC'))) counts.removed++;
  }
}

const words = [...picked].sort((a, b) => a.localeCompare(b, 'ko'));
const header = [
  '# 일반 단어 — 한 줄에 단어 하나 (한글 2글자 이상)',
  '# 빈 줄과 # 으로 시작하는 줄은 무시합니다.',
  '# 이 파일은 words/from-dictionary.js 가 사전 JSON 에서 만들었습니다. (' + words.length + '개' + (withProper ? ', 고유명사 전부 포함' : mecabDir ? ', 지명과 널리 알려진 이름 포함' : ', 고유명사 제외') + ')',
  '# 다시 만들면 이 파일에 직접 더한 단어는 사라집니다. 오래 남길 단어는 words/extra.txt 에 적으세요.',
  '# 지운 단어를 반영하려면 서버를 끄고 npm run words:reset 을 실행하세요.',
  '',
].join('\n');

fs.writeFileSync(OUT, header + words.join('\n') + '\n');

const perFirst = new Map();
for (const word of words) perFirst.set(word[0], (perFirst.get(word[0]) || 0) + 1);
const top = [...perFirst].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([char, n]) => char + ' ' + n).join(', ');
const f = (n) => n.toLocaleString('ko-KR');
console.log('사전 항목 ' + f(counts.total) + '개 → words.txt 에 ' + f(words.length) + '개');
console.log('  뺀 것: 명사가 아님 ' + f(counts.notNoun) + ', 한 글자 ' + f(counts.oneSyllable) + ', 고유명사뿐 ' + f(counts.properOnly) + ', 한글이 아님 ' + f(counts.badForm));
console.log('  다시 넣은 고유명사: 지명 ' + f(counts.place) + ', 널리 알려진 이름 ' + f(counts.name) + ' / extra.txt 에서 더한 단어 ' + f(counts.extra) + ' / remove.txt 로 뺀 단어 ' + f(counts.removed));
console.log('  시작 글자 ' + f(perFirst.size) + '종류. 단어가 가장 많은 글자: ' + top);
