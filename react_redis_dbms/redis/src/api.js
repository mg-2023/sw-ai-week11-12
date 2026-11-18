/* ======================================================================
 * api.js — 저장소를 외부에서 쓸 수 있게 하는 HTTP API
 *
 *   GET    /keys/:key              조회            → 200 { key, value, ttl }   |  404
 *   PUT    /keys/:key              저장            ← { value, ttl?, nx?, xx? } → 200 { ok: true }  |  409 (nx / xx 조건 불일치)
 *   DELETE /keys/:key              삭제            → 200 { deleted: 0 | 1 }
 *   POST   /keys/:key/incr         정수 증가       ← { by? }                   → 200 { value }
 *   POST   /keys/:key/expire       만료 걸기       ← { ttl }                   → 200 { ok: true }  |  404
 *   DELETE /keys/:key/expire       만료 없애기     → 200 { ok: true | false }
 *   GET    /keys?prefix=           키 목록         → 200 { keys: [...] }
 *   DELETE /keys?prefix=user:      묶음 무효화     → 200 { deleted: n }
 *   POST   /flush                  전부 지우기     → 200 { deleted: n }
 *   GET    /info                   상태            → 200 { keys, hits, misses, expired, table }
 *
 *   ttl 단위는 ms. 응답의 ttl 은 남은 시간이고, 만료가 없으면 -1 이다.
 *   오류: 400 잘못된 요청 (JSON 오류, 인자 오류) · 404 없는 키 / 없는 경로 · 405 지원하지 않는 메서드 · 413 본문이 너무 큼
 *
 *   동시성: 본문을 다 읽은 뒤 저장소 명령을 "동기 함수 호출 한 번"으로 실행한다.
 *           요청이 아무리 겹쳐 들어와도 명령은 하나씩 차례로 실행된다.
 * ====================================================================== */

import http from 'node:http';
import { CommandError } from './store.js';

const MAX_BODY = 1024 * 1024;        // 요청 본문 최대 1MB

/** 요청을 처리하다 생긴 오류. status 가 HTTP 상태 코드가 된다 */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** 요청 본문을 끝까지 읽어 JSON 으로 해석한다. 본문이 없으면 {} */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new HttpError(413, '본문이 너무 큽니다 (최대 1MB)')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') { resolve({}); return; }
      try {
        const body = JSON.parse(text);
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch (e) { reject(new HttpError(400, '본문이 올바른 JSON 객체가 아닙니다')); }
    });
  });
}

/** 경로 조각을 원래 문자로 되돌린다 (%20 → 공백 등) */
function decode(part) {
  try { return decodeURIComponent(part); } catch (e) { throw new HttpError(400, '경로의 인코딩이 올바르지 않습니다'); }
}

/** 요청 하나를 저장소 명령으로 바꿔 실행하고 [상태 코드, 응답 객체] 를 돌려준다. 저장소 명령은 모두 동기 실행이다 */
function execute(store, method, url, body) {
  const parts = url.pathname.split('/').filter(Boolean);
  const [head, rawKey, action] = parts;

  if (head === 'info' && parts.length === 1) {
    if (method !== 'GET') throw new HttpError(405, '지원하지 않는 메서드입니다');
    return [200, store.info()];
  }
  if (head === 'flush' && parts.length === 1) {
    if (method !== 'POST') throw new HttpError(405, '지원하지 않는 메서드입니다');
    return [200, { deleted: store.flushAll() }];
  }
  if (head !== 'keys' || parts.length > 3) throw new HttpError(404, '없는 경로입니다');

  if (parts.length === 1) {                                  // /keys?prefix=
    const prefix = url.searchParams.get('prefix') ?? '';
    if (method === 'GET') return [200, { keys: store.keys(prefix) }];
    if (method === 'DELETE') return [200, { deleted: store.delByPrefix(prefix) }];
    throw new HttpError(405, '지원하지 않는 메서드입니다');
  }

  const key = decode(rawKey);
  if (parts.length === 2) {                                  // /keys/:key
    if (method === 'GET') {
      const value = store.get(key);
      if (value === null) throw new HttpError(404, '없는 키입니다');
      return [200, { key, value, ttl: store.ttl(key) }];
    }
    if (method === 'PUT') {
      const saved = store.set(key, body.value, { ttl: body.ttl, nx: body.nx === true, xx: body.xx === true });
      return saved ? [200, { ok: true }] : [409, { ok: false, error: '조건(nx / xx)에 맞지 않아 저장하지 않았습니다' }];
    }
    if (method === 'DELETE') return [200, { deleted: store.del(key) }];
    throw new HttpError(405, '지원하지 않는 메서드입니다');
  }

  if (action === 'incr' && method === 'POST') return [200, { value: store.incr(key, body.by ?? 1) }];
  if (action === 'expire' && method === 'POST') {
    if (!store.expire(key, body.ttl)) throw new HttpError(404, '없는 키입니다');
    return [200, { ok: true }];
  }
  if (action === 'expire' && method === 'DELETE') return [200, { ok: store.persist(key) }];
  throw new HttpError(action === 'incr' || action === 'expire' ? 405 : 404, '없는 경로이거나 지원하지 않는 메서드입니다');
}

/** store 를 감싼 HTTP 서버를 만든다 (listen 은 호출한 쪽이 한다) */
export function createApiServer(store) {
  return http.createServer(async (req, res) => {
    let status, result;
    try {
      const url = new URL(req.url, 'http://localhost');
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req);
      [status, result] = execute(store, req.method, url, body);
    } catch (err) {
      if (err instanceof HttpError) status = err.status;
      else if (err instanceof CommandError) status = 400;
      else status = 500;
      result = { error: err.message };
    }
    const text = JSON.stringify(result);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  });
}

/** 서버를 port 에서 듣게 한다 (0 이면 빈 포트). 실제 주소를 돌려준다 */
export function listen(server, port = 0, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // backlog: 아직 받아들이지 못한 연결을 운영체제가 줄 세워 두는 길이. 요청이 한꺼번에 몰려도 거절되지 않게 넉넉히 잡는다
    server.listen({ port, host, backlog: 4096 }, () => resolve('http://' + host + ':' + server.address().port));
  });
}

/** 서버를 닫는다 (열려 있는 연결도 끊는다) */
export function close(server) {
  return new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
}
