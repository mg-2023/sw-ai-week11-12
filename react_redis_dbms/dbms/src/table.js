/* ======================================================================
 * table.js — 테이블 하나 = 파일 하나 + 그 파일을 가리키는 B+ 트리 인덱스
 *
 *   저장 포맷 (data/<테이블>.jsonl)
 *     레코드 하나가 한 줄이고, 한 줄은 컬럼 순서대로 값을 담은 JSON 배열이다. 첫 값은 항상 id 다.
 *       [1,"김철수",23,"서울"]
 *       [2,"이영희",31,"부산"]
 *     - 줄바꿈·따옴표가 든 문자열도 JSON 이 \n, \" 로 바꿔 주므로 레코드는 반드시 한 줄이다
 *     - 새 레코드는 파일 끝에 이어 쓰기만 한다 (기존 내용을 고치지 않는다)
 *
 *   인덱스 (메모리)
 *     B+ 트리에 id → "그 줄이 파일의 몇 번째 바이트에서 시작하는지"(offset) 를 넣어 둔다.
 *     id 로 찾을 때는 트리에서 offset 을 얻어 그 위치의 한 줄만 읽는다. 파일 전체를 읽지 않는다.
 *     인덱스는 파일에 저장하지 않는다. 테이블을 열 때 파일을 한 번 훑어 다시 만든다.
 *
 *   catchUp : 파일에서 "아직 인덱스에 넣지 않은 뒷부분"만 읽어 인덱스에 넣는다.
 *             테이블을 처음 열 때, 그리고 다른 스레드가 파일에 이어 쓴 내용을 따라잡을 때 쓴다.
 * ====================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { BPlusTree } from './bplus-tree.js';
import { SqlError } from './tokenizer.js';

const NEWLINE = 0x0a;
const CHUNK = 4 * 1024 * 1024;       // 파일을 훑을 때 한 번에 읽는 크기 (4MB)
export const MAX_ROW_BYTES = 64 * 1024;

/**
 * 파일 끝이 줄바꿈으로 끝나지 않으면(쓰다가 꺼진 흔적) 마지막 줄바꿈 뒤를 잘라 낸다.
 * 잘라 낸 바이트 수를 돌려준다. 여러 스레드가 파일을 열기 전에 한 번만 부른다.
 */
export function repairTableFile(file) {
  if (!fs.existsSync(file)) return 0;
  const fd = fs.openSync(file, 'r+');
  try {
    const size = fs.fstatSync(fd).size;
    let end = size;
    const buf = Buffer.allocUnsafe(1);
    while (end > 0) {                                        // 뒤에서부터 마지막 줄바꿈을 찾는다
      fs.readSync(fd, buf, 0, 1, end - 1);
      if (buf[0] === NEWLINE) break;
      end--;
    }
    if (end !== size) fs.ftruncateSync(fd, end);
    return size - end;
  } finally { fs.closeSync(fd); }
}

/** 테이블 파일을 열고 인덱스를 만든다. columns: [{ name, type }] (첫 컬럼은 id) */
export function openTable(dir, name, columns) {
  const file = path.join(dir, name + '.jsonl');
  const fd = fs.openSync(file, 'a+');                        // 없으면 만든다. 쓰기는 항상 파일 끝에 붙는다
  const index = new BPlusTree();
  let indexedBytes = 0;                                      // 파일의 앞에서부터 여기까지는 인덱스에 들어 있다

  const table = {
    name, columns, index, file,
    get rowCount() { return index.size; },

    /** 인덱스에 아직 없는 파일 뒷부분을 읽어 인덱스에 넣는다. 새로 넣은 레코드 수를 돌려준다 */
    catchUp() {
      const size = fs.fstatSync(fd).size;
      if (size === indexedBytes) return 0;
      const before = index.size;
      let chunkSize = CHUNK;
      while (indexedBytes < size) {
        const buf = Buffer.allocUnsafe(Math.min(chunkSize, size - indexedBytes));
        const n = fs.readSync(fd, buf, 0, buf.length, indexedBytes);
        let lineStart = 0;
        for (let i = 0; i < n; i++) {
          if (buf[i] !== NEWLINE) continue;
          // 줄은 "[123," 으로 시작한다. JSON 전체를 해석하지 않고 id 숫자만 바이트에서 직접 읽는다
          let id = 0;
          for (let j = lineStart + 1; buf[j] >= 0x30 && buf[j] <= 0x39; j++) id = id * 10 + (buf[j] - 0x30);
          index.insert(id, indexedBytes + lineStart);
          lineStart = i + 1;
        }
        if (lineStart === 0) {                               // 이 조각 안에 줄바꿈이 없다
          if (n < chunkSize) break;                          //   파일 끝의 잘린 줄 → 인덱스에 넣지 않는다
          chunkSize *= 2;                                    //   한 줄이 조각보다 길다 → 더 크게 읽는다
          continue;
        }
        indexedBytes += lineStart;
      }
      return index.size - before;
    },

    /**
     * 레코드들을 파일 끝에 이어 쓰고 인덱스에 등록한다. rows: id 를 뺀 값 배열들.
     * id 는 (지금까지의 가장 큰 id + 1) 부터 차례로 붙인다. 붙인 id 들을 돌려준다.
     */
    appendRows(rows) {
      let id = (index.maxKey() ?? 0) + 1;
      const lines = [], ids = [];
      for (const values of rows) {
        const line = JSON.stringify([id, ...values]);
        if (Buffer.byteLength(line) > MAX_ROW_BYTES) throw new SqlError('레코드 하나가 너무 큽니다 (최대 ' + MAX_ROW_BYTES + '바이트)');
        lines.push(line);
        ids.push(id++);
      }
      fs.writeSync(fd, lines.join('\n') + '\n');             // 문장 하나의 레코드들을 한 번에 쓴다 (전부 쓰이거나 전부 안 쓰이거나)
      let offset = indexedBytes;
      lines.forEach((line, i) => {
        index.insert(ids[i], offset);
        offset += Buffer.byteLength(line) + 1;
      });
      indexedBytes = offset;
      return ids;
    },

    /** 파일의 offset 위치에서 시작하는 한 줄을 읽어 레코드(배열)로 돌려준다 */
    readRow(offset) {
      for (let size = 256; ; size *= 4) {                    // 대부분 256바이트 안에 끝난다. 모자라면 4배씩 늘려 다시 읽는다
        const buf = Buffer.allocUnsafe(size);
        const n = fs.readSync(fd, buf, 0, size, offset);
        const end = buf.subarray(0, n).indexOf(NEWLINE);
        if (end !== -1) return JSON.parse(buf.toString('utf8', 0, end));
        if (n < size) throw new Error(name + ' 파일의 ' + offset + ' 위치에 레코드가 없습니다');
      }
    },

    /** 인덱스 검색: id 가 같은 레코드. 없으면 null */
    findById(id) {
      const offset = index.search(id);
      return offset === undefined ? null : table.readRow(offset);
    },

    /** 인덱스 범위 검색: from 이상 to 이하인 id 의 레코드를 id 순서대로 visit 에 넘긴다. visit 이 false 를 돌려주면 멈춘다 */
    rangeById(from, to, visit) {
      for (const [, offset] of index.range(from, to)) {
        if (visit(table.readRow(offset)) === false) return;
      }
    },

    /** 선형 탐색: 파일을 처음부터 끝까지 읽으며 모든 레코드를 visit 에 넘긴다. visit 이 false 를 돌려주면 멈춘다 */
    scan(visit) {
      let pos = 0, chunkSize = CHUNK;
      while (pos < indexedBytes) {
        const buf = Buffer.allocUnsafe(Math.min(chunkSize, indexedBytes - pos));
        const n = fs.readSync(fd, buf, 0, buf.length, pos);
        const lastNewline = buf.lastIndexOf(NEWLINE, n - 1);
        if (lastNewline === -1) { chunkSize *= 2; continue; }
        for (const line of buf.toString('utf8', 0, lastNewline).split('\n')) {
          if (visit(JSON.parse(line)) === false) return;
        }
        pos += lastNewline + 1;                              // 조각 끝에 걸린 줄은 다음 조각에서 처음부터 다시 읽는다
      }
    },

    close() { fs.closeSync(fd); },
  };

  table.catchUp();
  return table;
}
