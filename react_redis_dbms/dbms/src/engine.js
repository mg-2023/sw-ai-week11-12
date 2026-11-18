/* ======================================================================
 * engine.js — DB 엔진: SQL 텍스트를 받아 실행하고 결과를 돌려준다
 *
 *   처리 흐름:  SQL 텍스트 → 문장 나누기(tokenizer) → 파싱(parser) → 실행(여기) → 파일 저장 / 읽기(table)
 *
 *   INSERT : 값 검사 → id 자동 부여 → 파일 끝에 이어 쓰기 → B+ 트리에 id 등록
 *   SELECT : WHERE 를 보고 읽는 방법(plan)을 고른다
 *     INDEX_POINT : WHERE id = 3            → B+ 트리에서 위치를 찾아 그 한 줄만 읽는다
 *     INDEX_RANGE : WHERE id >= 10 AND id < 20 → B+ 트리의 리프를 옆으로 따라가며 그 범위만 읽는다
 *     FULL_SCAN   : 그 밖의 조건 (name = '…')  → 파일을 처음부터 끝까지 읽는다 (선형 탐색)
 *
 *   스키마(테이블과 컬럼)는 이미 있다고 가정한다: <데이터 폴더>/schema.json
 *     { "users": { "id": "int", "name": "text", "age": "int", "city": "text" } }
 *   타입: int(정수) · float(실수) · text(문자열). 첫 컬럼은 반드시 id(int)이고 자동으로 부여된다.
 *
 *   여러 스레드가 함께 쓸 때 (API 서버)
 *     스레드마다 엔진이 하나씩 있고, 인덱스도 스레드마다 따로 있다. 함께 쓰는 것은 테이블 파일과 잠금뿐이다.
 *     문장을 실행하기 전에 테이블의 잠금(SELECT 는 읽기, INSERT 는 쓰기)을 잡고,
 *     다른 스레드가 파일에 이어 쓴 내용을 자기 인덱스에 반영(catchUp)한 뒤 실행한다.
 * ====================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { SqlError, splitStatements } from './tokenizer.js';
import { parse } from './parser.js';
import { openTable, repairTableFile } from './table.js';
import { createRwLock } from './rw-lock.js';

const TYPES = new Set(['int', 'float', 'text']);

/** schema.json 을 읽어 { 테이블 이름(소문자): [{ name, type }] } 로 돌려준다 */
export function loadSchema(dataDir) {
  const file = path.join(dataDir, 'schema.json');
  if (!fs.existsSync(file)) throw new Error('스키마 파일이 없습니다: ' + file);
  const schema = {};
  for (const [table, cols] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) {
    const columns = Object.entries(cols).map(([name, type]) => ({ name: name.toLowerCase(), type }));
    if (!columns.length || columns[0].name !== 'id' || columns[0].type !== 'int') throw new Error(table + ' 테이블의 첫 컬럼은 id(int) 여야 합니다');
    for (const c of columns) if (!TYPES.has(c.type)) throw new Error(table + '.' + c.name + ' 의 타입을 알 수 없습니다: ' + c.type);
    schema[table.toLowerCase()] = columns;
  }
  return schema;
}

/** 값이 컬럼 타입에 맞는가 */
function typeOk(type, value) {
  if (type === 'int') return Number.isSafeInteger(value);
  if (type === 'float') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === 'string';
}

const TYPE_NAME = { int: '정수', float: '숫자', text: '문자열' };
const showValue = (v) => (typeof v === 'string' ? "'" + v + "'" : String(v));

/** 조건 하나를 레코드에 적용한다. NULL 인 값은 IS NULL 말고는 어떤 비교도 참이 아니다 */
function matches(row, cond) {
  const v = row[cond.index];
  switch (cond.op) {
    case 'IS NULL': return v === null;
    case 'IS NOT NULL': return v !== null;
    case '=': return v === cond.value;
    case '!=': return v !== null && v !== cond.value;
    case '<': return v !== null && v < cond.value;
    case '<=': return v !== null && v <= cond.value;
    case '>': return v !== null && v > cond.value;
    case '>=': return v !== null && v >= cond.value;
    default: return false;
  }
}

/**
 * WHERE 조건들을 보고 읽는 방법을 고른다. (id 컬럼은 항상 0번이다)
 * 반환: { kind: 'INDEX_POINT', id } | { kind: 'INDEX_RANGE', from, to } | { kind: 'FULL_SCAN' }
 */
export function choosePlan(conds) {
  const onId = conds.filter((c) => c.index === 0);
  const point = onId.find((c) => c.op === '=');
  if (point) return { kind: 'INDEX_POINT', id: point.value };

  let from = -Infinity, to = Infinity;
  for (const c of onId) {                                    // id 는 정수이므로 id > 5 는 id >= 6 과 같다
    if (c.op === '>') from = Math.max(from, c.value + 1);
    else if (c.op === '>=') from = Math.max(from, c.value);
    else if (c.op === '<') to = Math.min(to, c.value - 1);
    else if (c.op === '<=') to = Math.min(to, c.value);
  }
  if (from !== -Infinity || to !== Infinity) return { kind: 'INDEX_RANGE', from, to };
  return { kind: 'FULL_SCAN' };
}

/**
 * 엔진을 만든다.
 *   lockBuffer : 스레드끼리 함께 쓰는 잠금 메모리 (rw-lock.js). 없으면 잠금 없이 실행한다 (CLI 처럼 혼자 쓸 때)
 *   maxRows    : SELECT 한 번이 돌려주는 최대 레코드 수. 넘으면 잘라 내고 truncated: true 로 알린다
 *   repair     : 테이블을 열 때 파일 끝의 잘린 줄을 정리할지 (여러 스레드가 열 때는 메인 스레드가 미리 해 둔다)
 */
export function createEngine(dataDir, { lockBuffer = null, maxRows = Infinity, repair = true } = {}) {
  const schema = loadSchema(dataDir);
  const tableNames = Object.keys(schema);
  const tables = new Map();          // 이름 → 열어 둔 테이블
  const locks = new Map();           // 이름 → 잠금

  function getTable(name) {
    const key = name.toLowerCase();
    if (!schema[key]) throw new SqlError("'" + name + "' 테이블이 없습니다 (있는 테이블: " + tableNames.join(', ') + ')');
    if (!tables.has(key)) {
      if (repair) repairTableFile(path.join(dataDir, key + '.jsonl'));
      tables.set(key, openTable(dataDir, key, schema[key]));
      if (lockBuffer) locks.set(key, createRwLock(lockBuffer, tableNames.indexOf(key)));
    }
    return tables.get(key);
  }

  function columnIndex(table, name) {
    const i = table.columns.findIndex((c) => c.name === name.toLowerCase());
    if (i === -1) throw new SqlError("'" + table.name + "' 테이블에 '" + name + "' 컬럼이 없습니다 (있는 컬럼: " + table.columns.map((c) => c.name).join(', ') + ')');
    return i;
  }

  /** 잠금을 잡고 fn 을 실행한다. 잠금을 잡은 뒤에는 다른 스레드가 쓴 내용을 먼저 따라잡는다 */
  function withLock(table, mode, fn) {
    const lock = locks.get(table.name);
    if (!lock) return fn();
    if (mode === 'write') lock.lockWrite(); else lock.lockRead();
    try {
      table.catchUp();
      return fn();
    } finally {
      if (mode === 'write') lock.unlockWrite(); else lock.unlockRead();
    }
  }

  /* ---------------------------------------------------------------- INSERT */
  function runInsert(ast) {
    const table = getTable(ast.table);
    const names = ast.columns ?? table.columns.slice(1).map((c) => c.name);   // 컬럼 목록을 생략하면 id 를 뺀 전체
    const indexes = names.map((n) => columnIndex(table, n));
    if (indexes.includes(0)) throw new SqlError('id 는 자동으로 부여되므로 직접 넣을 수 없습니다');
    if (new Set(indexes).size !== indexes.length) throw new SqlError('같은 컬럼을 두 번 적었습니다');

    const rows = ast.rows.map((values, r) => {
      if (values.length !== indexes.length) throw new SqlError((r + 1) + '번째 값 묶음: 컬럼은 ' + indexes.length + '개인데 값은 ' + values.length + '개입니다');
      const row = new Array(table.columns.length - 1).fill(null);             // 적지 않은 컬럼은 NULL
      values.forEach((value, k) => {
        const col = table.columns[indexes[k]];
        if (value !== null && !typeOk(col.type, value)) throw new SqlError("'" + col.name + "' 컬럼은 " + TYPE_NAME[col.type] + '인데 ' + showValue(value) + ' 을(를) 넣으려 했습니다');
        row[indexes[k] - 1] = value;
      });
      return row;
    });

    const ids = withLock(table, 'write', () => table.appendRows(rows));       // 검사를 모두 통과한 뒤에만 파일에 쓴다
    return { type: 'insert', table: table.name, rowCount: ids.length, firstId: ids[0], lastId: ids[ids.length - 1] };
  }

  /* ---------------------------------------------------------------- SELECT */
  function runSelect(ast) {
    const table = getTable(ast.table);
    const conds = ast.where.map((c) => {
      const index = columnIndex(table, c.column);
      const col = table.columns[index];
      if (c.value !== null && !typeOk(col.type === 'int' ? 'float' : col.type, c.value)) {
        throw new SqlError("'" + col.name + "' 컬럼은 " + TYPE_NAME[col.type] + '인데 ' + showValue(c.value) + ' 와(과) 비교하려 했습니다');
      }
      return { index, op: c.op, value: c.value };
    });
    const picked = ast.columns === '*' ? table.columns.map((_, i) => i) : ast.columns.map((n) => columnIndex(table, n));
    const orderIndex = ast.orderBy ? columnIndex(table, ast.orderBy.column) : -1;
    const plan = choosePlan(conds);

    // 정렬이 없으면 필요한 개수만 모으고 멈춘다. (maxRows + 1 개째가 나오면 "더 있다"는 것만 확인하고 멈춘다)
    const stopAt = ast.orderBy || ast.count ? Infinity : Math.min(ast.limit ?? Infinity, maxRows + 1);
    const found = [];
    let count = 0;
    const visit = (row) => {
      for (const cond of conds) if (!matches(row, cond)) return true;
      count++;
      if (!ast.count) found.push(row);
      return count < stopAt;
    };

    withLock(table, 'read', () => {
      if (stopAt === 0) return;
      if (plan.kind === 'INDEX_POINT') {
        const row = table.findById(plan.id);
        if (row) visit(row);
      } else if (plan.kind === 'INDEX_RANGE') {
        table.rangeById(plan.from, plan.to, visit);
      } else {
        table.scan(visit);
      }
    });

    const result = { type: 'select', table: table.name, plan: plan.kind };
    if (ast.count) return { ...result, columns: ['count'], rows: [[count]], rowCount: 1 };

    if (ast.orderBy) {
      const sign = ast.orderBy.desc ? -1 : 1;
      found.sort((a, b) => {                                 // NULL 은 맨 앞
        const x = a[orderIndex], y = b[orderIndex];
        if (x === y) return 0;
        if (x === null) return -sign;
        if (y === null) return sign;
        return x < y ? -sign : sign;
      });
    }
    let rows = ast.limit === null ? found : found.slice(0, ast.limit);
    const truncated = rows.length > maxRows;
    if (truncated) rows = rows.slice(0, maxRows);
    result.columns = picked.map((i) => table.columns[i].name);
    result.rows = rows.map((row) => picked.map((i) => row[i]));
    result.rowCount = result.rows.length;
    if (truncated) result.truncated = true;
    return result;
  }

  const engine = {
    schema,

    /** 파싱된 문장(AST) 하나를 실행한다 */
    run(ast) {
      const start = performance.now();
      const result = ast.type === 'insert' ? runInsert(ast) : runSelect(ast);
      result.elapsedMs = Math.round((performance.now() - start) * 1000) / 1000;
      return result;
    },

    /**
     * SQL 텍스트(문장 여러 개 가능)를 실행하고 결과 배열을 돌려준다. onResult 를 주면 문장마다 결과를 바로 넘긴다.
     * 오류가 나면 그 문장에서 멈춘다. 앞 문장들은 이미 실행된 상태다 (트랜잭션은 없다).
     */
    execute(text, onResult = null) {
      const results = [];
      let n = 0;
      for (const { sql, line } of splitStatements(text)) {
        n++;
        try {
          const result = engine.run(parse(sql));
          if (onResult) onResult(result); else results.push(result);
        } catch (err) {
          if (err instanceof SqlError) err.message = n + '번째 문장 (' + line + '번째 줄): ' + err.message;
          throw err;
        }
      }
      return results;
    },

    /** 테이블별 레코드 수와 인덱스 상태 */
    info() {
      return tableNames.map((name) => {
        const t = getTable(name);
        withLock(t, 'read', () => {});
        return { table: name, columns: t.columns, rows: t.rowCount, indexHeight: t.index.height };
      });
    },

    close() {
      for (const table of tables.values()) table.close();
      tables.clear();
    },
  };
  return engine;
}
