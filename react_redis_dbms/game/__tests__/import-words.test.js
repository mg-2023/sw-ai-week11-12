/* import-words.js 테스트: 단어 파일 → SQL 파일 → 미니 DBMS CLI 로 실행 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readWordFile, buildInsertSql, importWords, pathsFor } from '../import-words.js';
import { createEngine } from '../../dbms/src/engine.js';

function makeDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'word-import-'));
  fs.mkdirSync(path.join(root, 'words'));
  return { root, paths: pathsFor(path.join(root, 'data'), path.join(root, 'words')) };
}

function allWords(dbDir) {
  const engine = createEngine(dbDir);
  const result = engine.execute('SELECT word, first, last, finisher FROM words')[0];
  engine.close();
  return result.rows;
}

test('단어 파일: 빈 줄과 # 주석은 무시하고, 쓸 수 없는 줄은 따로 모은다', () => {
  const { root, paths } = makeDirs();
  try {
    fs.writeFileSync(paths.wordFiles.words, '﻿# 주석\r\n기차\r\n\r\n  차표  \nabc\n기\n# TODO\n표 범\n');
    assert.deepEqual(readWordFile(paths.wordFiles.words), { words: ['기차', '차표'], invalid: ['abc', '기', '표 범'] });
    assert.deepEqual(readWordFile(path.join(root, '없는파일.txt')), { words: [], invalid: [] });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SQL 만들기: 첫 글자와 끝 글자를 함께 넣고 500개씩 묶는다', () => {
  const sql = buildInsertSql([{ word: '기차', finisher: false }, { word: '나트륨', finisher: true }]);
  assert.equal(sql, "INSERT INTO words (word, first, last, finisher, removed) VALUES\n('기차', '기', '차', 0, 0),\n('나트륨', '나', '륨', 1, 0);\n");
  const many = buildInsertSql(Array.from({ length: 1001 }, () => ({ word: '기차', finisher: false })));
  assert.equal(many.match(/INSERT INTO/g).length, 3);
  assert.equal(buildInsertSql([]), '');
});

test('비어 있는 단어 파일(TODO 만 있는 상태)로도 오류 없이 끝난다', () => {
  const { root, paths } = makeDirs();
  try {
    fs.writeFileSync(paths.wordFiles.words, '# TODO: 여기에 단어를 채워 주세요.\n# 예)\n# 기차\n');
    assert.deepEqual(importWords(paths), { added: 0, promoted: 0, removed: 0, skipped: 0, invalid: [], total: 0 });
    assert.deepEqual(allWords(paths.dbDir), []);
    assert.equal(fs.existsSync(paths.sqlFile), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('가져오기: 새 단어만 넣고, 다시 실행하면 중복해서 넣지 않는다', () => {
  const { root, paths } = makeDirs();
  try {
    fs.writeFileSync(paths.wordFiles.words, '기차\n차표\n기차\n나트륨\n');
    fs.writeFileSync(paths.wordFiles.finishers, '나트륨\n기쁨\n');
    assert.deepEqual(importWords(paths), { added: 4, promoted: 0, removed: 0, skipped: 0, invalid: [], total: 4 });
    assert.deepEqual(allWords(paths.dbDir), [['기차', '기', '차', 0], ['차표', '차', '표', 0], ['나트륨', '나', '륨', 1], ['기쁨', '기', '쁨', 1]]);
    assert.match(fs.readFileSync(paths.sqlFile, 'utf8'), /^INSERT INTO words/);          // SQL 파일을 거쳐 들어갔다

    assert.deepEqual(importWords(paths), { added: 0, promoted: 0, removed: 0, skipped: 4, invalid: [], total: 4 });
    assert.equal(allWords(paths.dbDir).length, 4);

    fs.appendFileSync(paths.wordFiles.words, '표범\n');
    fs.appendFileSync(paths.wordFiles.finishers, '차표\n');                               // 일반 단어를 끝내기로 올린다
    assert.deepEqual(importWords(paths), { added: 1, promoted: 1, removed: 0, skipped: 3, invalid: [], total: 5 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('가져오기 reset: 테이블을 비우고 단어 파일로 다시 채운다 (지운 단어 반영)', () => {
  const { root, paths } = makeDirs();
  try {
    fs.writeFileSync(paths.wordFiles.words, '기차\n차표\n');
    importWords(paths);
    fs.writeFileSync(paths.wordFiles.words, '기차\n');
    assert.equal(importWords({ ...paths, reset: true }).added, 1);
    assert.deepEqual(allWords(paths.dbDir).map((r) => r[0]), ['기차']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('삭제 목록(remove.txt): 목록의 단어는 넣지 않고, 이미 들어 있으면 지운 것으로 기록한다', () => {
  const { root, paths } = makeDirs();
  const alive = () => {
    const engine = createEngine(paths.dbDir);
    const rows = engine.execute('SELECT id, word, removed FROM words')[0].rows;
    engine.close();
    const latest = new Map(rows.map((r) => [r[1], r[2]]));                          // 같은 단어는 가장 나중 줄을 따른다
    return [...latest].filter(([, removed]) => removed !== 1).map(([word]) => word);
  };
  try {
    fs.writeFileSync(paths.wordFiles.words, '기차\n차표\n표범\n');
    fs.writeFileSync(paths.wordFiles.removed, '# 삭제 목록\n차표\n');
    assert.deepEqual(importWords(paths), { added: 2, promoted: 0, removed: 0, skipped: 0, invalid: [], total: 2 });
    assert.deepEqual(alive(), ['기차', '표범']);

    fs.appendFileSync(paths.wordFiles.removed, '표범\n없던단어\n');                 // 이미 들어 있는 단어를 삭제 목록에 올린다
    assert.deepEqual(importWords(paths), { added: 0, promoted: 0, removed: 1, skipped: 1, invalid: [], total: 1 });
    assert.deepEqual(alive(), ['기차']);
    assert.equal(importWords(paths).removed, 0);                                    // 다시 실행해도 또 기록하지 않는다

    fs.writeFileSync(paths.wordFiles.removed, '');                                  // 삭제 목록에서 빼면 되살아난다
    assert.deepEqual(importWords(paths), { added: 2, promoted: 0, removed: 0, skipped: 1, invalid: [], total: 3 });
    assert.deepEqual(alive().sort(), ['기차', '차표', '표범']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
