/* ======================================================================
 * bench/generate.js — 대용량 테스트 데이터를 "SQL 파일"로 만든다
 *
 *   node bench/generate.js 1000000 bench-data/insert.sql
 *
 *   레코드를 직접 파일에 쓰지 않고 INSERT 문을 만든다. 이 SQL 파일을 cli.js 에 넘기면
 *   Phase 1 의 SQL 처리기가 그대로 파싱·실행·저장하고, 자동 부여된 id 가 B+ 트리에 등록된다.
 *   INSERT 한 문장에 1,000건씩 묶는다 (문장 하나가 파일 쓰기 한 번이다).
 *
 *   만드는 레코드: users (name: 'user<번호>', age: 18 ~ 77, city: 10개 도시 중 하나)
 * ====================================================================== */

import fs from 'node:fs';

const CITIES = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '수원', '창원', '제주'];
const BATCH = 1000;

/** users 테이블에 count 건을 넣는 SQL 파일을 만든다 */
export function generateSql(file, count) {
  const fd = fs.openSync(file, 'w');
  for (let start = 1; start <= count; start += BATCH) {
    const values = [];
    for (let n = start; n < start + BATCH && n <= count; n++) {
      values.push("('user" + n + "', " + (18 + (n * 7) % 60) + ", '" + CITIES[(n * 13) % CITIES.length] + "')");
    }
    fs.writeSync(fd, 'INSERT INTO users (name, age, city) VALUES\n' + values.join(',\n') + ';\n');
  }
  fs.closeSync(fd);
}

if (process.argv[1] && process.argv[1].endsWith('generate.js')) {
  const count = Number(process.argv[2] || 1_000_000), file = process.argv[3] || 'bench-data/insert.sql';
  generateSql(file, count);
  console.log(file + ' 에 INSERT ' + count.toLocaleString('ko-KR') + '건 분량의 SQL 을 만들었습니다');
}
