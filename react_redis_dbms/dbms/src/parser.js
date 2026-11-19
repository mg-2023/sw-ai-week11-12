/* ======================================================================
 * parser.js — 토큰 배열을 읽어 "무엇을 하라는 문장인지"를 객체(AST)로 만든다
 *
 *   지원하는 문법
 *     INSERT INTO 테이블 [(컬럼, …)] VALUES (값, …) [, (값, …)] …
 *     SELECT * | 컬럼, … | COUNT(*)  FROM 테이블
 *       [WHERE 조건 [AND 조건] …]  [ORDER BY 컬럼 [ASC | DESC]]  [LIMIT 개수]
 *     조건 : 컬럼 (= | != | <> | < | <= | > | >=) 값   |   컬럼 IS [NOT] NULL
 *     값   : 숫자, '문자열', NULL
 *
 *   결과 (AST)
 *     { type: 'insert', table, columns: [이름…] | null, rows: [[값…] …] }
 *     { type: 'select', table, columns: [이름…] | '*', count: true | false,
 *       where: [{ column, op, value } …], orderBy: { column, desc } | null, limit: 숫자 | null }
 *
 *   여기서는 문법만 본다. 테이블·컬럼이 실제로 있는지, 타입이 맞는지는 engine.js 가 실행할 때 확인한다.
 * ====================================================================== */

import { SqlError, tokenize } from './tokenizer.js';

const KEYWORDS = new Set(['SELECT', 'FROM', 'WHERE', 'AND', 'ORDER', 'BY', 'ASC', 'DESC', 'LIMIT', 'INSERT', 'INTO', 'VALUES', 'NULL', 'IS', 'NOT', 'COUNT']);
const COMPARE_OPS = new Set(['=', '!=', '<>', '<', '<=', '>', '>=']);

const show = (token) => (token ? "'" + (token.type === 'string' ? "'" + token.value + "'" : token.value) + "'" : '문장의 끝');

/** SQL 문장 하나 → AST */
export function parse(sql) {
  const tokens = tokenize(sql);
  let i = 0;

  const peek = () => tokens[i];
  const isKeyword = (word) => tokens[i] && tokens[i].type === 'word' && tokens[i].upper === word;
  const isSymbol = (value) => tokens[i] && tokens[i].type === 'symbol' && tokens[i].value === value;
  const fail = (expected) => { throw new SqlError(expected + ' 이(가) 와야 하는데 ' + show(peek()) + ' 이(가) 왔습니다'); };

  /** 다음 토큰이 그 키워드면 넘어가고 true */
  const accept = (word) => { if (!isKeyword(word)) return false; i++; return true; };
  const acceptSymbol = (value) => { if (!isSymbol(value)) return false; i++; return true; };
  const expect = (word) => { if (!accept(word)) fail(word); };
  const expectSymbol = (value) => { if (!acceptSymbol(value)) fail("'" + value + "'"); };

  /** 테이블·컬럼 이름 */
  function name(what) {
    const token = peek();
    if (!token || token.type !== 'word' || KEYWORDS.has(token.upper)) fail(what);
    i++;
    return token.value;
  }

  /** 값: 숫자(부호 포함), 문자열, NULL */
  function literal() {
    const token = peek();
    if (token && token.type === 'string') { i++; return token.value; }
    if (accept('NULL')) return null;
    let sign = 1;
    if (acceptSymbol('-')) sign = -1; else acceptSymbol('+');
    const number = peek();
    if (!number || number.type !== 'number') fail('값(숫자, \'문자열\', NULL)');
    i++;
    return sign * number.value;
  }

  /** 괄호 안의 목록: ( 항목, 항목, … ) */
  function list(item) {
    expectSymbol('(');
    const items = [item()];
    while (acceptSymbol(',')) items.push(item());
    expectSymbol(')');
    return items;
  }

  function parseInsert() {
    expect('INTO');
    const table = name('테이블 이름');
    const columns = isSymbol('(') ? list(() => name('컬럼 이름')) : null;
    expect('VALUES');
    const rows = [list(literal)];
    while (acceptSymbol(',')) rows.push(list(literal));
    return { type: 'insert', table, columns, rows };
  }

  function parseCondition() {
    const column = name('컬럼 이름');
    if (accept('IS')) {
      const not = accept('NOT');
      expect('NULL');
      return { column, op: not ? 'IS NOT NULL' : 'IS NULL', value: null };
    }
    const token = peek();
    if (!token || token.type !== 'symbol' || !COMPARE_OPS.has(token.value)) fail('비교 연산자(=, !=, <, <=, >, >=)');
    i++;
    const value = literal();
    if (value === null) throw new SqlError('NULL 은 = 로 비교할 수 없습니다. IS NULL / IS NOT NULL 을 쓰세요');
    return { column, op: token.value === '<>' ? '!=' : token.value, value };
  }

  function parseSelect() {
    let columns = '*', count = false;
    if (accept('COUNT')) {
      expectSymbol('('); expectSymbol('*'); expectSymbol(')');
      count = true;
    } else if (!acceptSymbol('*')) {
      columns = [name('컬럼 이름')];
      while (acceptSymbol(',')) columns.push(name('컬럼 이름'));
    }
    expect('FROM');
    const table = name('테이블 이름');

    const where = [];
    if (accept('WHERE')) {
      where.push(parseCondition());
      while (accept('AND')) where.push(parseCondition());
    }

    let orderBy = null;
    if (accept('ORDER')) {
      expect('BY');
      const column = name('컬럼 이름');
      const desc = accept('DESC');
      if (!desc) accept('ASC');
      orderBy = { column, desc };
    }

    let limit = null;
    if (accept('LIMIT')) {
      const token = peek();
      if (!token || token.type !== 'number' || !Number.isInteger(token.value)) fail('LIMIT 뒤에 0 이상의 정수');
      i++;
      limit = token.value;
    }
    return { type: 'select', table, columns, count, where, orderBy, limit };
  }

  let ast;
  if (accept('INSERT')) ast = parseInsert();
  else if (accept('SELECT')) ast = parseSelect();
  else if (!peek()) throw new SqlError('빈 문장입니다');
  else throw new SqlError('지원하지 않는 문장입니다: ' + show(peek()) + ' (INSERT 와 SELECT 만 지원합니다)');

  if (peek()) throw new SqlError('문장이 끝나야 하는데 ' + show(peek()) + ' 이(가) 남아 있습니다');
  return ast;
}
