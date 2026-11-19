/* ======================================================================
 * server.js — 끝말잇기 게임 서버: 화면 파일을 내려 주고, 게임 API 를 제공한다
 *
 *   화면
 *     GET  /                         web/index.html
 *     GET  /app.js, /style.css …     web/ 아래 파일
 *     GET  /mini-react/…             미니 리액트 라이브러리 (mini-react/ 폴더)
 *
 *   API  (응답은 모두 JSON. 오류는 { error })
 *     POST /api/games                판 시작          ← { player, level }      → { game, trace }
 *     GET  /api/games/:id            판 상태                                    → { game, trace }
 *     POST /api/games/:id/words      단어 내기        ← { word }                → { accepted, reject, computer, game, trace }
 *     POST /api/games/:id/giveup     포기                                       → { game, trace }
 *     GET  /api/words?first=기차     그 글자들로 시작하는 등록 단어 (한 글자 이상)   → { first, words, trace }
 *     POST /api/words                단어 등록        ← { word, finisher }      → { added, message, invalidated }   (제작자 로그인 필요, 아니면 401)
 *     DELETE /api/words              단어 삭제        ← { word }                → { removed, message, invalidated }   (제작자 로그인 필요)
 *     POST /api/login                제작자 로그인    ← { id, password }        → { token, id, expiresInMs }  |  401  |  429 (5번 틀림)
 *     POST /api/logout               로그아웃         (Authorization: Bearer <토큰>)
 *     GET  /api/session              로그인 상태                                → { loggedIn, id, remainingMs, configured }
 *     GET  /api/ranking              가장 길게 이은 판 10개                      → { ranking, trace }
 *     GET  /api/records/:id          기록 번호로 판 기록 조회                    → { record, trace }
 *     GET  /api/status               미니 레디스 · 미니 DBMS 상태
 *
 *   같이 하는 방 (rooms.js). 방 안의 요청은 머리말 "X-Room-Token: <토큰>" 으로 누구인지 알린다
 *     GET  /api/rooms                방 목록                                    → { rooms }
 *     POST /api/rooms                방 만들기        ← { name, player, lives, round, rounds }  → { room, token }
 *     GET  /api/rooms/:id            방 상태                                    → { room }
 *     POST /api/rooms/:id/join       들어가기         ← { player }              → { room, token }
 *     POST /api/rooms/:id/start      시작 (방장)                                → { room }
 *     POST /api/rooms/:id/words      단어 내기        ← { word }                → { accepted, reject, room }
 *     POST /api/rooms/:id/leave      나가기                                     → { left, room }
 *
 *   판의 규칙과 저장은 service.js 가 맡는다. 여기서는 주소를 보고 맞는 함수를 부르기만 한다.
 * ====================================================================== */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { GameError } from './service.js';
import { AuthError } from './auth.js';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const MAX_BODY = 64 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new GameError(413, '본문이 너무 큽니다')); req.destroy(); return; }
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
      } catch (e) { reject(new GameError(400, '본문이 올바른 JSON 객체가 아닙니다')); }
    });
  });
}

/** root 폴더 안의 파일을 읽는다. 폴더 밖을 가리키거나 없는 파일이면 null */
function readStatic(root, relative) {
  const file = path.resolve(root, '.' + path.posix.normalize('/' + relative));
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  if (!TYPES[path.extname(file)] || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return { type: TYPES[path.extname(file)], body: fs.readFileSync(file) };
}

/**
 * service : createGameService() 의 결과
 * webDir  : 화면 파일 폴더
 * libDir  : 미니 리액트 src 폴더 (/mini-react/ 로 내려 준다)
 * auth    : createAuth() 의 결과. 주면 단어 등록에 로그인을 요구한다
 * rooms   : createRoomService() 의 결과. 주면 같이 하는 방 API 를 연다
 */
export function createGameServer({ service, webDir, libDir, auth = null, rooms = null }) {
  webDir = path.resolve(webDir);
  libDir = path.resolve(libDir);

  /** 요청 머리말 "Authorization: Bearer <토큰>" 에서 토큰을 꺼낸다 */
  const tokenOf = (req) => { const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); return m ? m[1] : null; };

  async function api(req, parts, url) {
    const [head, id, action] = parts;
    const method = req.method;
    const wrong = () => new GameError(405, '지원하지 않는 메서드입니다');

    if (head === 'games' && parts.length === 1) {
      if (method !== 'POST') throw wrong();
      return service.start(await readJson(req));
    }
    if (head === 'games' && /^\d+$/.test(id ?? '')) {
      if (parts.length === 2) { if (method !== 'GET') throw wrong(); return service.get(Number(id)); }
      if (parts.length === 3 && action === 'words') { if (method !== 'POST') throw wrong(); return service.play(Number(id), (await readJson(req)).word); }
      if (parts.length === 3 && action === 'giveup') { if (method !== 'POST') throw wrong(); return service.giveUp(Number(id)); }
    }
    if (rooms && head === 'rooms') {
      const roomToken = req.headers['x-room-token'] || null;
      if (parts.length === 1) {
        if (method === 'GET') return rooms.list();
        if (method === 'POST') return rooms.create(await readJson(req));
        throw wrong();
      }
      if (/^\d+$/.test(id ?? '')) {
        if (parts.length === 2) { if (method !== 'GET') throw wrong(); return rooms.get(Number(id), roomToken); }
        if (parts.length === 3 && method !== 'POST') throw wrong();
        if (parts.length === 3 && action === 'join') return rooms.join(Number(id), await readJson(req));
        if (parts.length === 3 && action === 'start') return rooms.start(Number(id), roomToken);
        if (parts.length === 3 && action === 'words') return rooms.play(Number(id), roomToken, (await readJson(req)).word);
        if (parts.length === 3 && action === 'leave') return rooms.leave(Number(id), roomToken);
      }
    }
    if (head === 'words' && parts.length === 1) {
      if (method === 'GET') return service.words(url.searchParams.get('first') ?? '');     // first: 찾을 단어의 앞부분 (한 글자 이상)
      if (method === 'POST') {
        if (auth) await auth.require(tokenOf(req));                    // 단어 등록은 로그인한 제작자만
        const body = await readJson(req);
        return service.register(body.word, body.finisher === true);
      }
      if (method === 'DELETE') {
        if (auth) await auth.require(tokenOf(req));                    // 단어 삭제도 로그인한 제작자만
        return service.remove((await readJson(req)).word);
      }
      throw wrong();
    }
    if (auth && head === 'login' && parts.length === 1) {
      if (method !== 'POST') throw wrong();
      const body = await readJson(req);
      return auth.login(body.id, body.password, req.socket.remoteAddress);
    }
    if (auth && head === 'logout' && parts.length === 1) { if (method !== 'POST') throw wrong(); return auth.logout(tokenOf(req)); }
    if (auth && head === 'session' && parts.length === 1) {
      if (method !== 'GET') throw wrong();
      const session = await auth.session(tokenOf(req));
      return { loggedIn: session !== null, id: session ? session.id : null, remainingMs: session ? session.remainingMs : 0, configured: auth.configured() };
    }
    if (head === 'ranking' && parts.length === 1) { if (method !== 'GET') throw wrong(); return service.ranking(); }
    if (head === 'records' && parts.length === 2 && /^\d+$/.test(id)) { if (method !== 'GET') throw wrong(); return service.record(Number(id)); }
    if (head === 'status' && parts.length === 1) { if (method !== 'GET') throw wrong(); return service.status(); }
    throw new GameError(404, '없는 경로입니다');
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch (e) { pathname = '/\0'; }

    if (!pathname.startsWith('/api/')) {
      const file = pathname.startsWith('/mini-react/') ? readStatic(libDir, pathname.slice('/mini-react/'.length))
        : readStatic(webDir, pathname === '/' ? 'index.html' : pathname.slice(1));
      if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('없는 주소입니다'); return; }
      res.writeHead(200, { 'content-type': file.type + '; charset=utf-8', 'content-length': file.body.length, 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : file.body);
      return;
    }

    let status = 200, result;
    try {
      result = await api(req, pathname.split('/').filter(Boolean).slice(1), url);
    } catch (err) {
      status = err instanceof GameError || err instanceof AuthError ? err.status : 500;
      result = { error: err.message };
    }
    const text = JSON.stringify(result);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  });
}
