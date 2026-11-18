/* 기능 테스트 (Phase 1) — 텍스트 파일로 작성한 SQL 을 명령줄로 SQL 처리기에 전달한다
 *
 *   실제로 `node cli.js <파일>` 을 별도 프로세스로 실행하고, 화면 출력과 종료 코드를 확인한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { formatTable } from '../../cli.js';
import { makeDataDir, removeDir } from './helper.js';

const CLI = fileURLToPath(new URL('../../cli.js', import.meta.url));
let dir;
beforeEach(() => { dir = makeDataDir(); });
afterEach(() => removeDir(dir));

/** SQL 파일을 만들고 cli.js 로 실행한다 */
function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--data', dir], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const sqlFile = (name, text) => { const file = path.join(dir, name); fs.writeFileSync(file, text); return file; };

test('SQL 파일을 넘기면 INSERT 는 파일에 저장하고 SELECT 는 표로 출력한다', () => {
  const file = sqlFile('a.sql', `
    -- 사용자 추가
    INSERT INTO users (name, age, city) VALUES ('김철수', 23, '서울'), ('이영희', 31, '부산');
    SELECT * FROM users;
    SELECT name FROM users WHERE id = 2;
  `);
  const r = cli(file);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /INSERT 2건 \(users, id 1 ~ 2/);
  assert.match(r.out, /\| 1 {2}\| 김철수 \| 23 {2}\| 서울 \|/);
  assert.match(r.out, /\(2건, .*선형 탐색/);
  assert.match(r.out, /\(1건, .*B\+ 트리 인덱스 \(id 한 건\)\)/);
  assert.equal(fs.readFileSync(path.join(dir, 'users.jsonl'), 'utf8'), '[1,"김철수",23,"서울"]\n[2,"이영희",31,"부산"]\n');
});

test('다시 실행하면 이전에 저장한 데이터가 남아 있다 (파일 기반 저장)', () => {
  cli(sqlFile('a.sql', "INSERT INTO users (name) VALUES ('첫 실행');"));
  const r = cli(sqlFile('b.sql', "INSERT INTO users (name) VALUES ('둘째 실행'); SELECT id, name FROM users;"));
  assert.match(r.out, /id 2,/);
  assert.match(r.out, /첫 실행/);
  assert.match(r.out, /둘째 실행/);
});

test('파일 여러 개와 -e 를 차례로 실행한다', () => {
  const r = cli(sqlFile('a.sql', "INSERT INTO users (name) VALUES ('a');"), sqlFile('b.sql', "INSERT INTO users (name) VALUES ('b');"), '-e', 'SELECT COUNT(*) FROM users');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\| 2 {5}\|/);
});

test('--quiet: SELECT 결과 표를 찍지 않고 요약만 찍는다', () => {
  const r = cli('--quiet', '-e', "INSERT INTO users (name) VALUES ('a'); SELECT * FROM users");
  assert.doesNotMatch(r.out, /\+---/);
  assert.match(r.out, /SELECT \(1건/);
});

test('오류: SQL 이 틀리면 파일 이름·문장 번호·줄 번호를 알리고 종료 코드 1 로 끝난다', () => {
  const file = sqlFile('bad.sql', "INSERT INTO users (name) VALUES ('a');\nSELECT * FORM users;\nINSERT INTO users (name) VALUES ('b');");
  const r = cli(file);
  assert.equal(r.code, 1);
  assert.match(r.err, /bad\.sql.*2번째 문장 \(2번째 줄\).*FROM/);
  assert.match(r.out, /INSERT 1건/);                                     // 앞 문장은 실행됐다
  assert.equal(fs.readFileSync(path.join(dir, 'users.jsonl'), 'utf8').trim().split('\n').length, 1);   // 뒤 문장은 실행되지 않았다
});

test('오류: 없는 파일, 인자 없음, 알 수 없는 옵션, 없는 데이터 폴더', () => {
  const missing = cli(path.join(dir, 'no-such.sql'));
  assert.equal(missing.code, 1);
  assert.match(missing.err, /SQL 파일이 없습니다/);

  const noArgs = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.equal(noArgs.status, 1);
  assert.match(noArgs.stdout, /사용법/);

  const badOption = cli('--wrong');
  assert.equal(badOption.code, 1);
  assert.match(badOption.err, /알 수 없는 옵션/);

  const noData = spawnSync(process.execPath, [CLI, '-e', 'SELECT 1', '--data', path.join(dir, 'nope')], { encoding: 'utf8' });
  assert.equal(noData.status, 1);
  assert.match(noData.stderr, /스키마 파일이 없습니다/);
});

test('엣지: 빈 파일과 주석만 있는 파일은 아무것도 하지 않고 정상 종료한다', () => {
  assert.equal(cli(sqlFile('empty.sql', '')).code, 0);
  const r = cli(sqlFile('comments.sql', '-- 주석뿐\n\n  ;;\n'));
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), '');
});

test('formatTable: 한글은 2칸으로 계산해 줄을 맞추고 NULL 을 표시한다', () => {
  assert.equal(formatTable(['id', 'name'], [[1, '김철수'], [22, null]]), [
    '+----+--------+',
    '| id | name   |',
    '+----+--------+',
    '| 1  | 김철수 |',
    '| 22 | NULL   |',
    '+----+--------+',
  ].join('\n'));
});
