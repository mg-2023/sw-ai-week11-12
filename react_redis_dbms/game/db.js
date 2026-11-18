/* ======================================================================
 * db.js — 게임 서버가 미니 DBMS API 서버를 쓰기 위한 클라이언트
 *
 *   const db = createDb('http://127.0.0.1:4000');
 *   const result = await db.query("SELECT word, finisher FROM words WHERE first = '기'");
 *   result.plan     'FULL_SCAN' | 'INDEX_POINT' | 'INDEX_RANGE'
 *   result.objects  [{ word: '기차', finisher: 0 }, …]      (rows 를 컬럼 이름으로 묶은 것)
 *
 *   게임 서버는 DBMS 를 "외부 클라이언트"로 쓴다. SQL 을 HTTP 로 보낼 뿐, 엔진을 직접 부르지 않는다.
 * ====================================================================== */

import http from 'node:http';

/** SQL 문자열 값으로 쓸 수 있게 작은따옴표로 감싼다 (안의 작은따옴표는 '' 로) */
export const quote = (text) => "'" + String(text).replace(/'/g, "''") + "'";

export function createDb(baseUrl) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });

  function request(method, pathname, body) {
    return new Promise((resolve, reject) => {
      const text = body === undefined ? null : JSON.stringify(body);
      const headers = text === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) };
      const req = http.request(baseUrl + pathname, { method, agent, headers }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          let data;
          try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { reject(new Error('DBMS 응답이 JSON 이 아닙니다')); return; }
          if (res.statusCode >= 400) reject(new Error('DBMS 오류: ' + (data.error || res.statusCode)));
          else resolve(data);
        });
      });
      req.on('error', reject);
      req.end(text ?? undefined);
    });
  }

  return {
    /** SQL 한 문장을 실행하고 그 결과를 돌려준다. SELECT 면 objects 에 레코드를 객체로 담는다 */
    async query(sql) {
      const data = await request('POST', '/query', { sql });
      const result = data.results[0];
      result.worker = data.worker;
      if (result.type === 'select') result.objects = result.rows.map((row) => Object.fromEntries(result.columns.map((name, i) => [name, row[i]])));
      return result;
    },
    tables() { return request('GET', '/tables').then((data) => data.tables); },
    stats() { return request('GET', '/stats'); },
    close() { agent.destroy(); },
  };
}
