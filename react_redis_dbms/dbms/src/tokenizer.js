/* ======================================================================
 * tokenizer.js — SQL 문자열을 토큰(의미 있는 가장 작은 조각)으로 자른다
 *
 *   "SELECT name FROM users WHERE id = 3;"
 *     → word SELECT · word name · word FROM · word users · word WHERE · word id · symbol = · number 3
 *
 *   토큰 : { type, value, pos }
 *     word   : 키워드나 이름 (SELECT, users, name …). upper 에 대문자로 바꾼 값도 넣어 둔다
 *     number : 숫자 (value 는 숫자 값)
 *     string : '작은따옴표' 문자열. 안에서 작은따옴표는 '' 로 쓴다
 *     symbol : ( ) , * = != <> < <= > >= - +
 *
 *   splitStatements : SQL 파일 전체를 ; 기준으로 문장 단위로 자른다 (문자열·주석 안의 ; 는 무시)
 *
 *   이 모듈은 다른 모듈에 의존하지 않는다.
 * ====================================================================== */

/** SQL 을 해석하거나 실행할 수 없을 때. 사용자에게 그대로 보여 줄 메시지를 담는다 */
export class SqlError extends Error {}

const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const isDigit = (c) => c >= '0' && c <= '9';
const isWordStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c > '\u007f';   // 한글 이름도 허용
const isWordPart = (c) => isWordStart(c) || isDigit(c);
const TWO_CHAR_SYMBOLS = new Set(['!=', '<>', '<=', '>=']);
const ONE_CHAR_SYMBOLS = new Set(['(', ')', ',', '*', '=', '<', '>', '-', '+']);

/** SQL 문장 하나 → 토큰 배열 */
export function tokenize(sql) {
  const tokens = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (isSpace(c) || c === ';') { i++; continue; }
    if (c === '-' && sql[i + 1] === '-') {                       // -- 주석: 줄 끝까지 건너뛴다
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    const pos = i;
    if (isWordStart(c)) {
      while (i < sql.length && isWordPart(sql[i])) i++;
      const value = sql.slice(pos, i);
      tokens.push({ type: 'word', value, upper: value.toUpperCase(), pos });
    } else if (isDigit(c)) {
      while (i < sql.length && isDigit(sql[i])) i++;
      if (sql[i] === '.' && isDigit(sql[i + 1] ?? '')) { i++; while (i < sql.length && isDigit(sql[i])) i++; }
      if (i < sql.length && isWordStart(sql[i])) throw new SqlError('잘못된 숫자입니다: ' + sql.slice(pos, i + 1));
      tokens.push({ type: 'number', value: Number(sql.slice(pos, i)), pos });
    } else if (c === "'") {
      let value = '';
      i++;
      for (;;) {
        if (i >= sql.length) throw new SqlError('문자열이 닫히지 않았습니다 (작은따옴표가 하나 부족합니다)');
        if (sql[i] === "'" && sql[i + 1] === "'") { value += "'"; i += 2; continue; }   // '' → 작은따옴표 한 글자
        if (sql[i] === "'") { i++; break; }
        value += sql[i++];
      }
      tokens.push({ type: 'string', value, pos });
    } else if (TWO_CHAR_SYMBOLS.has(sql.slice(i, i + 2))) {
      tokens.push({ type: 'symbol', value: sql.slice(i, i + 2), pos });
      i += 2;
    } else if (ONE_CHAR_SYMBOLS.has(c)) {
      tokens.push({ type: 'symbol', value: c, pos });
      i++;
    } else {
      throw new SqlError('쓸 수 없는 문자입니다: ' + c);
    }
  }
  return tokens;
}

/**
 * SQL 텍스트 전체를 문장 단위로 자른다. 빈 문장(공백·주석만 있는 것)은 내보내지 않는다.
 * 내보내는 것: { sql, line }  (line: 그 문장이 시작하는 줄 번호. 오류를 알려 줄 때 쓴다)
 */
export function* splitStatements(text) {
  let start = 0, line = 1, startLine = 1, hasContent = false;
  let i = 0;
  const emit = function* (end) {
    if (hasContent) yield { sql: text.slice(start, end), line: startLine };
    start = end + 1;
    hasContent = false;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === "'") {                                             // 문자열: 닫는 따옴표까지 건너뛴다
      if (!hasContent) { hasContent = true; startLine = line; }
      i++;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") { i += 2; continue; }
        if (text[i] === "'") break;
        if (text[i] === '\n') line++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '-' && text[i + 1] === '-') {                      // 주석: 줄 끝까지 건너뛴다
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === ';') { yield* emit(i); i++; continue; }
    if (!isSpace(c) && !hasContent) { hasContent = true; startLine = line; }
    i++;
  }
  yield* emit(text.length);
}
