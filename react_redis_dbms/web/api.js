/* ======================================================================
 * api.js — 화면에서 게임 서버 API 를 부르는 함수들
 *
 *   서버가 오류로 답하면 그 메시지를 담은 Error 를 던진다.
 * ====================================================================== */

async function call(method, url, body, token, roomToken) {
  const options = { method, headers: {} };
  if (token) options.headers.authorization = 'Bearer ' + token;
  if (roomToken) options.headers['x-room-token'] = roomToken;            // 같이 하는 방에서 내가 누구인지
  if (body !== undefined) { options.headers['content-type'] = 'application/json'; options.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, options); } catch (e) { throw new Error('서버에 연결할 수 없습니다. 서버가 켜져 있는지 확인하세요'); }
  const data = await res.json().catch(() => ({ error: '서버 응답을 읽을 수 없습니다' }));
  if (!res.ok) throw Object.assign(new Error(data.error || '요청을 처리하지 못했습니다'), { status: res.status });
  return data;
}

export const api = {
  startGame: (player, level, round, lives) => call('POST', '/api/games', { player, level, round, lives }),
  getGame: (id) => call('GET', '/api/games/' + id),
  playWord: (id, word) => call('POST', '/api/games/' + id + '/words', { word }),
  giveUp: (id) => call('POST', '/api/games/' + id + '/giveup'),
  registerWord: (word, finisher, token) => call('POST', '/api/words', { word, finisher }, token),
  removeWord: (word, token) => call('DELETE', '/api/words', { word }, token),
  login: (id, password) => call('POST', '/api/login', { id, password }),
  logout: (token) => call('POST', '/api/logout', undefined, token),
  session: (token) => call('GET', '/api/session', undefined, token),
  wordsStartingWith: (first) => call('GET', '/api/words?first=' + encodeURIComponent(first)),
  ranking: () => call('GET', '/api/ranking'),
  status: () => call('GET', '/api/status'),
  rooms: () => call('GET', '/api/rooms'),
  createRoom: (settings) => call('POST', '/api/rooms', settings),
  getRoom: (id, roomToken) => call('GET', '/api/rooms/' + id, undefined, null, roomToken),
  joinRoom: (id, player) => call('POST', '/api/rooms/' + id + '/join', { player }),
  startRoom: (id, roomToken) => call('POST', '/api/rooms/' + id + '/start', undefined, null, roomToken),
  playRoom: (id, roomToken, word) => call('POST', '/api/rooms/' + id + '/words', { word }, null, roomToken),
  leaveRoom: (id, roomToken) => call('POST', '/api/rooms/' + id + '/leave', undefined, null, roomToken),
};
