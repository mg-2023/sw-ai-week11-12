/* ======================================================================
 * client.js — 다른 프로그램에서 미니 레디스 서버를 쓰기 위한 클라이언트
 *
 *   const redis = createClient('http://127.0.0.1:6380');
 *   await redis.set('user:1', { name: '철수' }, { ttl: 60_000 });
 *   await redis.get('user:1');        // { name: '철수' }   (없으면 null)
 *
 *   HTTP API (api.js) 를 호출할 뿐이다. 메서드 이름과 반환값은 store.js 와 같다. (모두 Promise 를 돌려준다)
 * ====================================================================== */

import http from 'node:http';

/** 서버가 오류 응답을 보냈을 때 */
export class RedisError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createClient(baseUrl, { maxSockets = 32 } = {}) {
  const keyUrl = (key, suffix = '') => baseUrl + '/keys/' + encodeURIComponent(key) + suffix;

  // 연결 풀: 요청마다 새 연결을 맺지 않고 최대 maxSockets 개의 연결을 계속 재사용한다.
  // 요청이 그보다 많이 몰리면 빈 연결이 생길 때까지 줄을 선다. (한꺼번에 수백 개를 연결하면 운영체제가 연결을 거절한다)
  const agent = new http.Agent({ keepAlive: true, maxSockets });

  /** 요청을 보내고 [상태 코드, 응답 객체] 를 돌려준다. allow 에 없는 오류 상태면 예외를 던진다 */
  function request(method, url, body, allow = []) {
    return new Promise((resolve, reject) => {
      const text = body === undefined ? null : JSON.stringify(body);
      const headers = text === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) };
      const req = http.request(url, { method, agent, headers }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          let data;
          try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { reject(new RedisError(res.statusCode, '응답이 JSON 이 아닙니다')); return; }
          if (res.statusCode >= 400 && !allow.includes(res.statusCode)) reject(new RedisError(res.statusCode, data.error || '요청 실패'));
          else resolve([res.statusCode, data]);
        });
      });
      req.on('error', reject);                     // 서버가 꺼져 있을 때 등
      req.end(text ?? undefined);
    });
  }

  return {
    async get(key) {
      const [status, data] = await request('GET', keyUrl(key), undefined, [404]);
      return status === 404 ? null : data.value;
    },
    async set(key, value, options = {}) {
      const [status] = await request('PUT', keyUrl(key), { value, ...options }, [409]);
      return status === 200;
    },
    async del(key) { return (await request('DELETE', keyUrl(key)))[1].deleted; },
    async incr(key, by = 1) { return (await request('POST', keyUrl(key, '/incr'), { by }))[1].value; },
    async expire(key, ttl) { return (await request('POST', keyUrl(key, '/expire'), { ttl }, [404]))[0] === 200; },
    async persist(key) { return (await request('DELETE', keyUrl(key, '/expire')))[1].ok; },
    /** 남은 시간(ms). 만료가 없으면 -1, 없는 키면 -2 */
    async ttl(key) {
      const [status, data] = await request('GET', keyUrl(key), undefined, [404]);
      return status === 404 ? -2 : data.ttl;
    },
    async keys(prefix = '') { return (await request('GET', baseUrl + '/keys?prefix=' + encodeURIComponent(prefix)))[1].keys; },
    async delByPrefix(prefix) { return (await request('DELETE', baseUrl + '/keys?prefix=' + encodeURIComponent(prefix)))[1].deleted; },
    async flushAll() { return (await request('POST', baseUrl + '/flush'))[1].deleted; },
    async info() { return (await request('GET', baseUrl + '/info'))[1]; },
    /** 연결 풀의 연결을 모두 닫는다 */
    close() { agent.destroy(); },
  };
}
