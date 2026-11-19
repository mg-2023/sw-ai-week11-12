/* ======================================================================
 * cli.js — SQL 처리기의 명령줄 인터페이스 (Phase 1 진입점)
 *
 *   node cli.js sql/sample.sql              SQL 파일을 읽어 문장을 차례로 실행한다
 *   node cli.js a.sql b.sql --data ./data   파일 여러 개, 데이터 폴더 지정 (기본: ./data)
 *   node cli.js -e "SELECT * FROM users"    SQL 을 직접 적어 실행한다
 *   node cli.js --quiet big.sql             SELECT 결과 표를 찍지 않고 요약만 찍는다 (대량 INSERT 용)
 *
 *   파싱·실행·저장은 src/engine.js 가 하고, 여기서는 인자를 읽고 결과를 표로 찍기만 한다.
 *   오류가 나면 그 문장에서 멈추고 종료 코드 1 로 끝난다.
 * ====================================================================== */

import fs from 'node:fs';
import { createEngine } from './src/engine.js';
import { SqlError } from './src/tokenizer.js';

const USAGE = '사용법: node cli.js <SQL 파일...> [-e "SQL"] [--data <데이터 폴더>] [--quiet]';
const PLAN_TEXT = { INDEX_POINT: 'B+ 트리 인덱스 (id 한 건)', INDEX_RANGE: 'B+ 트리 인덱스 (id 범위)', FULL_SCAN: '선형 탐색 (파일 전체)' };

/** 글자의 화면 폭: 한글 등은 2칸 */
const width = (s) => { let w = 0; for (const ch of s) w += ch.codePointAt(0) > 0x2e7f ? 2 : 1; return w; };
const pad = (s, w) => s + ' '.repeat(Math.max(0, w - width(s)));
const cell = (v) => (v === null ? 'NULL' : String(v));

/** SELECT 결과를 표로 만든다 */
export function formatTable(columns, rows) {
  const cells = rows.map((row) => row.map(cell));
  const widths = columns.map((c, i) => Math.max(width(c), ...cells.map((r) => width(r[i]))));
  const line = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  const format = (row) => '| ' + row.map((v, i) => pad(v, widths[i])).join(' | ') + ' |';
  return [line, format(columns), line, ...cells.map(format), line].join('\n');
}

/** 결과 하나를 사람이 읽을 글로 만든다 */
export function formatResult(result, quiet = false) {
  if (result.type === 'insert') {
    const ids = result.firstId === result.lastId ? 'id ' + result.firstId : 'id ' + result.firstId + ' ~ ' + result.lastId;
    return 'INSERT ' + result.rowCount + '건 (' + result.table + ', ' + ids + ', ' + result.elapsedMs + 'ms)';
  }
  const summary = '(' + result.rowCount + '건, ' + result.elapsedMs + 'ms, ' + PLAN_TEXT[result.plan] + ')';
  return quiet ? 'SELECT ' + summary : formatTable(result.columns, result.rows) + '\n' + summary;
}

function parseArgs(argv) {
  const options = { files: [], inline: [], dataDir: './data', quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--data') options.dataDir = argv[++i];
    else if (arg === '-e') options.inline.push(argv[++i]);
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg.startsWith('-')) throw new Error('알 수 없는 옵션: ' + arg);
    else options.files.push(arg);
  }
  if (options.dataDir === undefined || options.inline.includes(undefined)) throw new Error('옵션 뒤에 값이 없습니다');
  return options;
}

function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (err) { console.error(err.message + '\n' + USAGE); return 1; }
  if (options.help || (options.files.length === 0 && options.inline.length === 0)) { console.log(USAGE); return options.help ? 0 : 1; }

  let engine;
  try { engine = createEngine(options.dataDir); } catch (err) { console.error('오류: ' + err.message); return 1; }

  const inputs = [...options.files.map((file) => ({ label: file, file })), ...options.inline.map((sql) => ({ label: '-e', sql }))];
  try {
    for (const input of inputs) {
      let text = input.sql;
      if (input.file) {
        if (!fs.existsSync(input.file)) { console.error('오류: SQL 파일이 없습니다: ' + input.file); return 1; }
        text = fs.readFileSync(input.file, 'utf8');
      }
      try {
        engine.execute(text, (result) => console.log(formatResult(result, options.quiet) + '\n'));
      } catch (err) {
        if (!(err instanceof SqlError)) throw err;
        console.error('오류 [' + input.label + '] ' + err.message);
        return 1;
      }
    }
    return 0;
  } finally { engine.close(); }
}

// 이 파일을 직접 실행했을 때만 main 을 돌린다 (테스트에서 formatTable 만 가져다 쓸 수 있게)
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url))) {
  process.exitCode = main();
}
