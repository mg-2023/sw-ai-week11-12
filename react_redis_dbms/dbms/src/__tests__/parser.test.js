/* tokenizer.js / parser.js 단위 테스트 — SQL 문장을 분석해 구조화한다 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, splitStatements, SqlError } from '../tokenizer.js';
import { parse } from '../parser.js';

const statements = (text) => [...splitStatements(text)];

/* ---------------------------------------------------------------- tokenizer */

test('tokenize: 단어 · 숫자 · 문자열 · 기호로 자른다', () => {
  const tokens = tokenize("SELECT name FROM users WHERE id >= 3 AND city = '서울'");
  assert.deepEqual(tokens.map((t) => t.type + ':' + t.value), [
    'word:SELECT', 'word:name', 'word:FROM', 'word:users', 'word:WHERE', 'word:id', 'symbol:>=', 'number:3',
    'word:AND', 'word:city', 'symbol:=', 'string:서울',
  ]);
});

test("tokenize: 문자열 안의 '' 는 작은따옴표 한 글자, 기호와 키워드도 글자 그대로", () => {
  assert.equal(tokenize("'It''s; SELECT -- (x)'")[0].value, "It's; SELECT -- (x)");
  assert.equal(tokenize("''")[0].value, '');
});

test('tokenize: 소수, -- 주석, 대소문자', () => {
  assert.deepEqual(tokenize('3.14 -- 주석 SELECT\n 7').map((t) => t.value), [3.14, 7]);
  assert.equal(tokenize('select')[0].upper, 'SELECT');
});

test('tokenize 오류: 닫히지 않은 문자열, 쓸 수 없는 문자, 잘못된 숫자', () => {
  assert.throws(() => tokenize("SELECT 'abc"), SqlError);
  assert.throws(() => tokenize('SELECT @x'), SqlError);
  assert.throws(() => tokenize('SELECT 12abc'), SqlError);
});

test('splitStatements: ; 로 나누되 문자열·주석 안의 ; 는 무시하고, 시작 줄 번호를 알려 준다', () => {
  const list = statements("SELECT 1;\n-- 주석; 여기는 무시\nINSERT INTO t VALUES ('a;b');\n\n  SELECT 2");
  assert.deepEqual(list.map((s) => s.line), [1, 3, 5]);
  assert.equal(list.length, 3);
  assert.match(list[1].sql, /'a;b'/);
});

test('splitStatements: 빈 문장(공백, 주석, ;; )은 내보내지 않는다', () => {
  assert.equal(statements('').length, 0);
  assert.equal(statements('  \n ;; -- 주석만\n ; ').length, 0);
});

/* ---------------------------------------------------------------- INSERT */

test('INSERT: 컬럼 목록과 값 한 묶음', () => {
  assert.deepEqual(parse("INSERT INTO users (name, age) VALUES ('김철수', 23)"), {
    type: 'insert', table: 'users', columns: ['name', 'age'], rows: [['김철수', 23]],
  });
});

test('INSERT: 컬럼 목록 생략, 값 여러 묶음, 음수 · 소수 · NULL', () => {
  assert.deepEqual(parse("insert into t values ('a', -5, 1.5, NULL), ('b', +2, 0, null)"), {
    type: 'insert', table: 't', columns: null, rows: [['a', -5, 1.5, null], ['b', 2, 0, null]],
  });
});

/* ---------------------------------------------------------------- SELECT */

test('SELECT *: 조건 · 정렬 · 개수 제한이 없으면 기본값', () => {
  assert.deepEqual(parse('SELECT * FROM users'), {
    type: 'select', table: 'users', columns: '*', count: false, where: [], orderBy: null, limit: null,
  });
});

test('SELECT: 컬럼 목록, WHERE … AND …, ORDER BY, LIMIT', () => {
  assert.deepEqual(parse("SELECT id, name FROM users WHERE age >= 20 AND city = '서울' ORDER BY age DESC LIMIT 10"), {
    type: 'select', table: 'users', columns: ['id', 'name'], count: false,
    where: [{ column: 'age', op: '>=', value: 20 }, { column: 'city', op: '=', value: '서울' }],
    orderBy: { column: 'age', desc: true }, limit: 10,
  });
});

test('SELECT: 비교 연산자 전부, <> 는 != 와 같다', () => {
  const ops = (sql) => parse(sql).where.map((c) => c.op);
  assert.deepEqual(ops('SELECT * FROM t WHERE a = 1 AND b != 1 AND c <> 1 AND d < 1 AND e <= 1 AND f > 1 AND g >= 1'), ['=', '!=', '!=', '<', '<=', '>', '>=']);
});

test('SELECT: IS NULL / IS NOT NULL, COUNT(*), ORDER BY 기본은 오름차순', () => {
  const ast = parse('SELECT COUNT(*) FROM users WHERE age IS NULL AND city IS NOT NULL');
  assert.equal(ast.count, true);
  assert.deepEqual(ast.where, [{ column: 'age', op: 'IS NULL', value: null }, { column: 'city', op: 'IS NOT NULL', value: null }]);
  assert.deepEqual(parse('SELECT * FROM t ORDER BY a').orderBy, { column: 'a', desc: false });
  assert.deepEqual(parse('SELECT * FROM t ORDER BY a ASC').orderBy, { column: 'a', desc: false });
});

test('키워드는 대소문자를 가리지 않고, 줄바꿈과 끝의 ; 는 상관없다', () => {
  assert.deepEqual(parse('select *\n  from Users\n  where ID = 1;'), parse('SELECT * FROM Users WHERE ID = 1'));
});

/* ---------------------------------------------------------------- 문법 오류 */

test('문법 오류는 무엇이 와야 했는지 알려 준다', () => {
  const message = (sql) => { try { parse(sql); } catch (err) { assert.ok(err instanceof SqlError, sql); return err.message; } assert.fail('오류가 나야 한다: ' + sql); };
  assert.match(message('SELECT * users'), /FROM/);
  assert.match(message('SELECT FROM users'), /컬럼 이름/);
  assert.match(message('SELECT * FROM'), /테이블 이름.*문장의 끝/);
  assert.match(message('SELECT * FROM users WHERE'), /컬럼 이름/);
  assert.match(message('SELECT * FROM users WHERE age 20'), /비교 연산자/);
  assert.match(message('SELECT * FROM users WHERE age ='), /값/);
  assert.match(message('SELECT * FROM users WHERE age = NULL'), /IS NULL/);
  assert.match(message('SELECT * FROM users LIMIT -1'), /LIMIT/);
  assert.match(message('SELECT * FROM users LIMIT 1.5'), /LIMIT/);
  assert.match(message('SELECT * FROM users extra'), /남아 있습니다/);
  assert.match(message('INSERT users VALUES (1)'), /INTO/);
  assert.match(message('INSERT INTO users (name VALUES (1)'), /'\)'/);
  assert.match(message('INSERT INTO users VALUES ()'), /값/);
  assert.match(message('INSERT INTO users VALUES (1,)'), /값/);
  assert.match(message('INSERT INTO users'), /VALUES/);
  assert.match(message('DELETE FROM users'), /지원하지 않는 문장/);
  assert.match(message('CREATE TABLE t (id int)'), /지원하지 않는 문장/);
  assert.match(message(''), /빈 문장/);
});
