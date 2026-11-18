/* ======================================================================
 * import-words.js — 단어 파일(words/*.txt)을 읽어 미니 DBMS 의 words 테이블에 넣는다
 *
 *   ① words/words.txt (일반 단어), words/finishers.txt (끝내기 단어), words/remove.txt (삭제 목록) 를 읽는다
 *   ② 아직 테이블에 없는 단어만 골라 INSERT 문으로 된 SQL 파일(data/words.sql)을 만든다
 *   ③ 그 SQL 파일을 미니 DBMS 의 CLI(dbms/cli.js)에 넘겨 실행한다  ← 과제 Phase 1 의 방식 그대로
 *
 *   서버를 켤 때(server.js) 자동으로 실행된다. 직접 실행할 수도 있다. (게임 서버가 꺼져 있을 때만)
 *     node game/import-words.js            새 단어만 추가
 *     node game/import-words.js --reset    words 테이블을 비우고 단어 파일로 다시 채운다 (지운 단어를 반영할 때)
 *
 *   단어 파일 형식: 한 줄에 단어 하나. 빈 줄과 # 으로 시작하는 줄은 무시한다.
 *   두 파일에 모두 있는 단어는 끝내기 단어로 본다. remove.txt 에 있는 단어는 넣지 않는다.
 * ====================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../dbms/src/engine.js';
import { quote } from './db.js';
import { WORD_PATTERN, firstChar, lastChar } from './rules.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BATCH = 500;                       // INSERT 한 문장에 묶는 단어 수

/** 단어 파일 한 개를 읽는다 → { words: [단어…], invalid: [쓸 수 없는 줄…] }. 파일이 없으면 빈 결과 */
export function readWordFile(file) {
  const words = [], invalid = [];
  if (!fs.existsSync(file)) return { words, invalid };
  for (const line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const word = line.trim();
    if (word === '' || word.startsWith('#')) continue;
    if (WORD_PATTERN.test(word)) words.push(word); else invalid.push(word);
  }
  return { words, invalid };
}

/** [{ word, finisher, removed? }] → INSERT 문들 */
export function buildInsertSql(entries) {
  let sql = '';
  for (let i = 0; i < entries.length; i += BATCH) {
    const values = entries.slice(i, i + BATCH).map((e) =>
      '(' + [quote(e.word), quote(firstChar(e.word)), quote(lastChar(e.word)), e.finisher ? 1 : 0, e.removed ? 1 : 0].join(', ') + ')');
    sql += 'INSERT INTO words (word, first, last, finisher, removed) VALUES\n' + values.join(',\n') + ';\n';
  }
  return sql;
}

/**
 * 단어 파일의 단어 중 테이블에 없는 것을 넣고, 삭제 목록(remove.txt)의 단어는 지운 것으로 기록한다.
 * 반환: { added, promoted: 끝내기로 바뀐 수, removed: 지운 수, skipped: 이미 있던 수, invalid: [쓸 수 없는 줄…], total: 넣으려는 단어 수 }
 */
export function importWords({ dbDir, wordFiles, sqlFile, reset = false }) {
  if (reset) fs.rmSync(path.join(dbDir, 'words.jsonl'), { force: true });

  const normal = readWordFile(wordFiles.words), finish = readWordFile(wordFiles.finishers);
  const gone = new Set(wordFiles.removed ? readWordFile(wordFiles.removed).words : []);     // 삭제 목록
  const wanted = new Map();                                  // 단어 → 끝내기 여부 (끝내기 파일이 우선)
  for (const word of normal.words) if (!gone.has(word)) wanted.set(word, false);
  for (const word of finish.words) if (!gone.has(word)) wanted.set(word, true);

  // 지금 테이블에 있는 단어 (같은 단어는 가장 나중 등록을 따른다)
  const engine = createEngine(dbDir);
  const current = engine.execute('SELECT id, word, finisher, removed FROM words')[0];
  engine.close();
  const iWord = current.columns.indexOf('word'), iFin = current.columns.indexOf('finisher'), iGone = current.columns.indexOf('removed');
  const existing = new Map(current.rows.map((row) => [row[iWord], { finisher: row[iFin] === 1, removed: row[iGone] === 1 }]));

  const entries = [];
  let promoted = 0, skipped = 0, removed = 0;
  for (const [word, finisher] of wanted) {
    const now = existing.get(word);
    if (!now || now.removed) entries.push({ word, finisher });
    else if (finisher && !now.finisher) { entries.push({ word, finisher }); promoted++; }
    else skipped++;
  }
  for (const word of gone) {                                  // 삭제 목록에 있는데 테이블에 살아 있는 단어
    const now = existing.get(word);
    if (now && !now.removed) { entries.push({ word, finisher: false, removed: true }); removed++; }
  }

  if (entries.length > 0) {
    fs.mkdirSync(path.dirname(sqlFile), { recursive: true });
    fs.writeFileSync(sqlFile, buildInsertSql(entries));
    const cli = spawnSync(process.execPath, [path.join(ROOT, 'dbms', 'cli.js'), sqlFile, '--data', dbDir, '--quiet'], { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (cli.status !== 0) throw new Error('단어를 넣지 못했습니다: ' + (cli.stderr || cli.stdout));
  }
  return { added: entries.length - promoted - removed, promoted, removed, skipped, invalid: [...normal.invalid, ...finish.invalid], total: wanted.size };
}

/** 데이터 폴더와 단어 폴더에서 쓰는 경로들. 데이터 폴더의 스키마 파일은 game/schema.json 으로 맞춰 둔다 */
export function pathsFor(dataDir = path.join(ROOT, 'data'), wordsDir = path.join(ROOT, 'words')) {
  const dbDir = path.join(dataDir, 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'game', 'schema.json'), path.join(dbDir, 'schema.json'));
  return {
    dbDir,
    aofFile: path.join(dataDir, 'redis.aof'),
    sqlFile: path.join(dataDir, 'words.sql'),
    wordFiles: { words: path.join(wordsDir, 'words.txt'), finishers: path.join(wordsDir, 'finishers.txt'), removed: path.join(wordsDir, 'remove.txt') },
  };
}

/** 결과를 한 줄로 */
export function describeImport(r) {
  return '단어 파일 ' + r.total + '개 중 새로 넣음 ' + r.added + '개, 끝내기로 바꿈 ' + r.promoted + '개, 지움 ' + r.removed + '개, 이미 있음 ' + r.skipped + '개' +
    (r.invalid.length ? ', 쓸 수 없는 줄 ' + r.invalid.length + '개 (' + r.invalid.slice(0, 5).join(', ') + (r.invalid.length > 5 ? ' …' : '') + ')' : '');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(describeImport(importWords({ ...pathsFor(), reset: process.argv.includes('--reset') })));
}
