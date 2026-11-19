/* 기능 테스트 (Phase 1 + Phase 2) — SQL 처리기와 B+ 트리 인덱스
 *
 *   임시 폴더에 스키마만 두고, SQL 을 실행해 파일 내용과 결과를 확인한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, choosePlan } from '../engine.js';
import { SqlError } from '../tokenizer.js';
import { repairTableFile } from '../table.js';
import { makeDataDir, removeDir } from './helper.js';

let dir, db;
beforeEach(() => { dir = makeDataDir(); db = createEngine(dir); });
afterEach(() => { db.close(); removeDir(dir); });

const run = (sql) => db.execute(sql);
const rows = (sql) => run(sql).at(-1).rows;
const fileLines = (table) => fs.readFileSync(path.join(dir, table + '.jsonl'), 'utf8').split('\n').filter(Boolean);
const seed = () => run(`INSERT INTO users (name, age, city) VALUES
  ('김철수', 23, '서울'), ('이영희', 31, '부산'), ('박민수', 27, '서울'), ('최지우', 45, '대전'), ('무명', NULL, NULL)`);
const fails = (sql, pattern) => assert.throws(() => run(sql), (err) => err instanceof SqlError && pattern.test(err.message), sql);

/* ---------------------------------------------------------------- Phase 1: INSERT → 파일 저장 */

test('INSERT: 레코드가 테이블 파일에 한 줄씩 추가되고 id 가 1부터 자동으로 붙는다', () => {
  const [result] = run("INSERT INTO users (name, age, city) VALUES ('김철수', 23, '서울')");
  assert.deepEqual({ type: result.type, rowCount: result.rowCount, firstId: result.firstId }, { type: 'insert', rowCount: 1, firstId: 1 });
  run("INSERT INTO users (name, age, city) VALUES ('이영희', 31, '부산')");
  assert.deepEqual(fileLines('users'), ['[1,"김철수",23,"서울"]', '[2,"이영희",31,"부산"]']);
});

test('INSERT: 테이블마다 파일이 따로이고 id 도 따로 센다', () => {
  seed();
  run("INSERT INTO products (name, price, stock) VALUES ('키보드', 39000.5, 12)");
  assert.equal(fileLines('users').length, 5);
  assert.deepEqual(fileLines('products'), ['[1,"키보드",39000.5,12]']);
});

test('INSERT: 컬럼 목록을 생략하면 id 를 뺀 컬럼 순서, 일부만 적으면 나머지는 NULL, 순서를 바꿔 적어도 된다', () => {
  run("INSERT INTO users VALUES ('가', 1, 'x')");
  run("INSERT INTO users (name) VALUES ('나')");
  run("INSERT INTO users (city, name) VALUES ('z', '다')");
  assert.deepEqual(rows('SELECT * FROM users'), [[1, '가', 1, 'x'], [2, '나', null, null], [3, '다', null, 'z']]);
});

/* ---------------------------------------------------------------- Phase 1: SELECT → 파일에서 읽기 */

test('SELECT *: 파일의 모든 레코드를 넣은 순서대로 돌려준다', () => {
  seed();
  const [result] = run('SELECT * FROM users');
  assert.deepEqual(result.columns, ['id', 'name', 'age', 'city']);
  assert.equal(result.rowCount, 5);
  assert.deepEqual(result.rows[0], [1, '김철수', 23, '서울']);
  assert.deepEqual(result.rows[4], [5, '무명', null, null]);
});

test('SELECT: 컬럼 고르기, WHERE, AND', () => {
  seed();
  assert.deepEqual(rows("SELECT name, age FROM users WHERE city = '서울'"), [['김철수', 23], ['박민수', 27]]);
  assert.deepEqual(rows("SELECT name FROM users WHERE city = '서울' AND age > 25"), [['박민수']]);
  assert.deepEqual(rows('SELECT id FROM users WHERE age != 23'), [[2], [3], [4]]);          // NULL 은 != 에도 걸리지 않는다
  assert.deepEqual(rows("SELECT id FROM users WHERE name >= '박' AND name < '이'"), [[3]]);
  assert.deepEqual(rows("SELECT id FROM users WHERE city = '없는 도시'"), []);
});

test('SELECT: IS NULL / IS NOT NULL, COUNT(*)', () => {
  seed();
  assert.deepEqual(rows('SELECT name FROM users WHERE age IS NULL'), [['무명']]);
  assert.deepEqual(rows('SELECT COUNT(*) FROM users WHERE age IS NOT NULL'), [[4]]);
  assert.deepEqual(rows('SELECT COUNT(*) FROM users'), [[5]]);
  assert.deepEqual(rows('SELECT COUNT(*) FROM products'), [[0]]);
});

test('SELECT: ORDER BY (오름차순 / 내림차순, NULL 은 오름차순에서 맨 앞), LIMIT', () => {
  seed();
  assert.deepEqual(rows('SELECT name FROM users ORDER BY age'), [['무명'], ['김철수'], ['박민수'], ['이영희'], ['최지우']]);
  assert.deepEqual(rows('SELECT name FROM users ORDER BY age DESC LIMIT 2'), [['최지우'], ['이영희']]);
  assert.deepEqual(rows('SELECT id FROM users LIMIT 2'), [[1], [2]]);
  assert.deepEqual(rows('SELECT id FROM users LIMIT 0'), []);
});

test('테이블·컬럼 이름과 키워드는 대소문자를 가리지 않는다', () => {
  seed();
  assert.deepEqual(rows('select NAME from USERS where ID = 2'), [['이영희']]);
});

test('한 번에 여러 문장을 실행하면 문장마다 결과가 나온다', () => {
  const results = run("INSERT INTO users (name) VALUES ('a'); INSERT INTO users (name) VALUES ('b'); SELECT COUNT(*) FROM users;");
  assert.deepEqual(results.map((r) => r.type), ['insert', 'insert', 'select']);
  assert.deepEqual(results[2].rows, [[2]]);
});

/* ---------------------------------------------------------------- Phase 2: B+ 트리 인덱스 */

test('choosePlan: id = 은 인덱스 한 건, id 범위는 인덱스 범위, 그 밖은 선형 탐색', () => {
  const cond = (index, op, value) => ({ index, op, value });
  assert.deepEqual(choosePlan([cond(0, '=', 7)]), { kind: 'INDEX_POINT', id: 7 });
  assert.deepEqual(choosePlan([cond(2, '>', 20), cond(0, '=', 7)]), { kind: 'INDEX_POINT', id: 7 });
  assert.deepEqual(choosePlan([cond(0, '>', 5), cond(0, '<=', 9)]), { kind: 'INDEX_RANGE', from: 6, to: 9 });
  assert.deepEqual(choosePlan([cond(0, '>=', 5)]), { kind: 'INDEX_RANGE', from: 5, to: Infinity });
  assert.deepEqual(choosePlan([cond(1, '=', 'x')]), { kind: 'FULL_SCAN' });
  assert.deepEqual(choosePlan([cond(0, '!=', 5)]), { kind: 'FULL_SCAN' });
  assert.deepEqual(choosePlan([]), { kind: 'FULL_SCAN' });
});

test('WHERE id = ? 는 B+ 트리 인덱스를 쓰고, 다른 컬럼 조건은 선형 탐색을 한다', () => {
  seed();
  const [byId] = run('SELECT * FROM users WHERE id = 3');
  assert.equal(byId.plan, 'INDEX_POINT');
  assert.deepEqual(byId.rows, [[3, '박민수', 27, '서울']]);
  const [byName] = run("SELECT * FROM users WHERE name = '박민수'");
  assert.equal(byName.plan, 'FULL_SCAN');
  assert.deepEqual(byName.rows, byId.rows);                                // 읽는 방법이 달라도 결과는 같다
});

test('INSERT 할 때마다 자동 부여된 id 가 B+ 트리에 등록된다', () => {
  seed();
  const table = db.info().find((t) => t.table === 'users');
  assert.equal(table.rows, 5);
  for (let id = 1; id <= 5; id++) assert.equal(rows('SELECT id FROM users WHERE id = ' + id)[0][0], id);
  assert.deepEqual(rows('SELECT id FROM users WHERE id = 6'), []);
  assert.deepEqual(rows('SELECT id FROM users WHERE id = 0'), []);
  assert.deepEqual(rows('SELECT id FROM users WHERE id = -1'), []);
});

test('인덱스로 찾은 뒤에도 나머지 조건을 확인한다', () => {
  seed();
  assert.deepEqual(rows("SELECT name FROM users WHERE id = 3 AND city = '부산'"), []);
  assert.deepEqual(rows("SELECT name FROM users WHERE id = 3 AND city = '서울'"), [['박민수']]);
  assert.deepEqual(rows('SELECT name FROM users WHERE id = 3 AND id = 4'), []);
});

test('id 범위 조건은 인덱스 범위 검색을 쓴다', () => {
  seed();
  const [result] = run('SELECT id FROM users WHERE id > 1 AND id <= 4');
  assert.equal(result.plan, 'INDEX_RANGE');
  assert.deepEqual(result.rows, [[2], [3], [4]]);
  assert.deepEqual(rows('SELECT id FROM users WHERE id >= 4'), [[4], [5]]);
  assert.deepEqual(rows('SELECT id FROM users WHERE id < 3 LIMIT 1'), [[1]]);
  assert.deepEqual(rows('SELECT id FROM users WHERE id > 100'), []);
});

test('레코드 3,000건: 모든 id 에 대해 인덱스 검색과 선형 탐색의 결과가 같다', () => {
  const values = Array.from({ length: 3000 }, (_, i) => "('user" + (i + 1) + "', " + (i % 60) + ", 'city" + (i % 7) + "')").join(',');
  run('INSERT INTO users (name, age, city) VALUES ' + values);
  assert.ok(db.info()[0].indexHeight >= 2);
  for (const id of [1, 2, 63, 64, 65, 1500, 2999, 3000]) {
    const [indexed] = run('SELECT * FROM users WHERE id = ' + id);
    const [scanned] = run("SELECT * FROM users WHERE name = 'user" + id + "'");
    assert.equal(indexed.plan, 'INDEX_POINT');
    assert.equal(scanned.plan, 'FULL_SCAN');
    assert.deepEqual(indexed.rows, scanned.rows);
    assert.equal(indexed.rows[0][0], id);
  }
  assert.deepEqual(rows('SELECT COUNT(*) FROM users WHERE age = 59'), [[50]]);
});

test('다시 열기: 파일에서 인덱스를 다시 만들고, id 는 이어서 붙는다', () => {
  seed();
  db.close();
  db = createEngine(dir);
  assert.deepEqual(rows('SELECT name FROM users WHERE id = 4'), [['최지우']]);
  const [result] = run("INSERT INTO users (name) VALUES ('새 사람')");
  assert.equal(result.firstId, 6);
  assert.equal(fileLines('users').length, 6);
});

/* ---------------------------------------------------------------- 엣지 케이스 */

test('엣지: 특수문자가 든 문자열(따옴표, 쉼표, 줄바꿈, 역슬래시, 이모지)도 한 줄로 저장되고 그대로 읽힌다', () => {
  const tricky = ["It's", 'a,b,c', '첫 줄\n둘째 줄', '"큰따옴표"', 'C:\\path\\', '😀', '', '[1,2]', '; DROP TABLE users; --'];
  for (const text of tricky) run("INSERT INTO users (name) VALUES ('" + text.replaceAll("'", "''") + "')");
  assert.equal(fileLines('users').length, tricky.length);
  tricky.forEach((text, i) => {
    assert.deepEqual(rows('SELECT name FROM users WHERE id = ' + (i + 1)), [[text]]);
    assert.deepEqual(rows("SELECT id FROM users WHERE name = '" + text.replaceAll("'", "''") + "'"), [[i + 1]]);
  });
});

test('엣지: 음수, 0, 소수, 아주 큰 정수', () => {
  run("INSERT INTO products (name, price, stock) VALUES ('a', -1.5, -3), ('b', 0, 0), ('c', 9007199254740991, 2147483648)");
  assert.deepEqual(rows('SELECT name FROM products WHERE price < 0'), [['a']]);
  assert.deepEqual(rows('SELECT name FROM products WHERE stock = 0'), [['b']]);
  assert.deepEqual(rows('SELECT stock FROM products WHERE id = 3'), [[2147483648]]);
});

test('오류: 없는 테이블 / 없는 컬럼은 있는 이름을 함께 알려 준다', () => {
  fails('SELECT * FROM nothing', /'nothing' 테이블이 없습니다.*users/);
  fails("INSERT INTO nothing VALUES ('a')", /테이블이 없습니다/);
  fails('SELECT nickname FROM users', /'nickname' 컬럼이 없습니다.*name/);
  fails('SELECT * FROM users WHERE nickname = 1', /컬럼이 없습니다/);
  fails('SELECT * FROM users ORDER BY nickname', /컬럼이 없습니다/);
  fails("INSERT INTO users (nickname) VALUES ('a')", /컬럼이 없습니다/);
});

test('오류: 타입이 맞지 않는 값', () => {
  fails("INSERT INTO users (name, age) VALUES ('a', '스물')", /'age' 컬럼은 정수/);
  fails("INSERT INTO users (name, age) VALUES ('a', 1.5)", /정수/);
  fails('INSERT INTO users (name) VALUES (123)', /'name' 컬럼은 문자열/);
  fails("SELECT * FROM users WHERE age = '스물'", /비교하려 했습니다/);
  fails('SELECT * FROM users WHERE name = 3', /비교하려 했습니다/);
});

test('오류: 값의 개수가 다름, id 를 직접 넣음, 같은 컬럼을 두 번 적음', () => {
  fails("INSERT INTO users (name, age) VALUES ('a')", /컬럼은 2개인데 값은 1개/);
  fails("INSERT INTO users VALUES ('a', 1)", /컬럼은 3개인데 값은 2개/);
  fails("INSERT INTO users (id, name) VALUES (9, 'a')", /id 는 자동으로 부여/);
  fails("INSERT INTO users (name, name) VALUES ('a', 'b')", /두 번/);
});

test('오류가 난 INSERT 는 아무것도 저장하지 않는다 (여러 묶음 중 하나만 틀려도)', () => {
  fails("INSERT INTO users (name, age) VALUES ('a', 1), ('b', '틀림'), ('c', 3)", /2번째 값 묶음|정수/);
  assert.deepEqual(rows('SELECT COUNT(*) FROM users'), [[0]]);
  assert.equal(fileLines('users').length, 0);
});

test('오류: 몇 번째 문장, 몇 번째 줄인지 알려 주고 그 앞 문장까지는 실행돼 있다', () => {
  fails("INSERT INTO users (name) VALUES ('a');\n\nSELECT * FORM users;\nINSERT INTO users (name) VALUES ('b');", /2번째 문장 \(3번째 줄\)/);
  assert.deepEqual(rows('SELECT name FROM users'), [['a']]);
});

test('오류: 레코드 하나가 너무 크면 거절한다', () => {
  fails("INSERT INTO users (name) VALUES ('" + 'x'.repeat(70000) + "')", /너무 큽니다/);
  run("INSERT INTO users (name) VALUES ('" + 'x'.repeat(60000) + "')");       // 한도 안의 큰 레코드는 된다
  assert.equal(rows('SELECT name FROM users WHERE id = 1')[0][0].length, 60000);
});

test('엣지: 빈 테이블 조회, 아직 파일이 없는 테이블 조회', () => {
  assert.deepEqual(rows('SELECT * FROM users'), []);
  assert.deepEqual(rows('SELECT * FROM products WHERE id = 1'), []);
  assert.deepEqual(rows('SELECT * FROM products ORDER BY price'), []);
});

test('엣지: 쓰다가 꺼져 마지막 줄이 잘린 파일은 잘린 부분을 버리고 연다', () => {
  seed();
  db.close();
  const file = path.join(dir, 'users.jsonl');
  fs.appendFileSync(file, '[6,"쓰다가 꺼');
  assert.equal(repairTableFile(file) > 0, true);
  db = createEngine(dir);
  assert.deepEqual(rows('SELECT COUNT(*) FROM users'), [[5]]);
  assert.equal(run("INSERT INTO users (name) VALUES ('복구 뒤')")[0].firstId, 6);
  assert.deepEqual(rows('SELECT name FROM users WHERE id = 6'), [['복구 뒤']]);
});

test('엣지: maxRows 를 넘는 결과는 잘라 내고 truncated 로 알린다', () => {
  db.close();
  db = createEngine(dir, { maxRows: 3 });
  seed();
  const [cut] = run('SELECT id FROM users');
  assert.deepEqual([cut.rowCount, cut.truncated], [3, true]);
  const [sorted] = run('SELECT id FROM users ORDER BY id DESC');
  assert.deepEqual([sorted.rows, sorted.truncated], [[[5], [4], [3]], true]);
  const [small] = run('SELECT id FROM users LIMIT 2');
  assert.equal(small.truncated, undefined);
  assert.deepEqual(rows('SELECT COUNT(*) FROM users'), [[5]]);
});

test('엣지: 스키마 파일이 없거나 첫 컬럼이 id 가 아니면 엔진을 만들 수 없다', () => {
  const empty = fs.mkdtempSync(path.join(dir, 'empty-'));
  assert.throws(() => createEngine(empty), /스키마 파일이 없습니다/);
  const bad = makeDataDir({ t: { name: 'text' } });
  try { assert.throws(() => createEngine(bad), /첫 컬럼은 id/); } finally { removeDir(bad); }
});
