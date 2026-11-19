/* ======================================================================
 * rooms.js — 같은 와이파이에서 2~4명이 함께 하는 방. 사전 · 캐시는 혼자 하는 판(service.js)과 같은 것을 쓴다
 *
 *   미니 레디스 (방 상태는 바뀔 때마다 30분 TTL 을 다시 건다)
 *     room:<번호>              방 상태 (사람, 설정, 차례, 낸 단어)
 *     room:<번호>:used:<단어>   이번 라운드에 나온 단어 (새 라운드에 지움)
 *     room:<번호>:turn         지금 차례인 사람의 남은 시간. 사라지면 시간 초과
 *     room:<번호>:lock         한 방을 한 번에 한 요청만 다루게 하는 잠금 (nx)
 *     room:seq                 방 번호 (incr)
 *   미니 DBMS
 *     games                    판이 끝나면 사람마다 한 줄 (level 'room')
 *
 *   사람마다 비밀 토큰을 준다. 시작 · 단어 내기 · 나가기는 토큰으로 누구인지 확인한다 (다른 사람에게는 pid 만 보인다).
 *   화면은 0.5초마다 방 상태를 물어본다. 그 요청에서 차례 키가 사라져 있으면 시간 초과를 반영한다.
 *
 *   규칙 (혼자 하는 판과 같게)
 *     목숨 1~5 · 라운드 시간은 방을 만들 때 정한다 (라운드 수는 따로 없다. 목숨 수가 판의 길이를 정한다)
 *     첫 라운드의 선공은 무작위, 그 뒤로는 목숨을 잃은 사람 (목숨이 0 이 됐으면 그다음 사람)
 *     라운드의 첫 단어로 한방 단어 금지, 라운드마다 나온 단어를 비운다
 *     차례 시간(10초)이나 라운드 시간이 다 되면 그때 차례인 사람이 목숨을 잃는다 (이을 단어가 없으면 시간이 다 돼서 진다)
 *     목숨이 0 이면 빠진다. 한 사람만 남으면 판이 끝나고 그 사람이 이긴다
 * ====================================================================== */

import crypto from 'node:crypto';
import { quote } from './db.js';
import { GameError } from './service.js';
import { WORD_PATTERN, ROUND_TIMES, DEFAULT_ROUND, LIVES, MAX_LIVES, POINTS, gradeOf, letterPoints, nextStartChars, rejectReason } from './rules.js';

export const MAX_PLAYERS = 4;
const ROOM_TTL = 30 * 60_000;       // 방을 보관하는 시간 (바뀔 때마다 다시 건다)
const OVER_TTL = 10 * 60_000;       // 끝난 방을 다시 볼 수 있는 시간
const LOCK_TTL = 5_000;

/**
 * redis      : redis/src/client.js 의 클라이언트
 * db         : game/db.js 의 클라이언트 (끝난 판을 기록한다)
 * dictionary : service.js 가 내주는 { lookup, continuations, pickStartWord }
 * turnMs     : 한 차례의 제한 시간 · secondMs: 라운드 시간 1초의 길이 (테스트에서 줄인다)
 * random     : 첫 선공을 고를 때 쓰는 난수 · randomStart: 라운드마다 시작 단어를 제시할지
 */
export function createRoomService({ redis, db, dictionary, turnMs = 10_000, secondMs = 1000, random = Math.random, randomStart = true }) {
  const roomKey = (id) => 'room:' + id;
  const turnKey = (id) => 'room:' + id + ':turn';
  const usedPrefix = (id) => 'room:' + id + ':used:';
  const lockKey = (id) => 'room:' + id + ':lock';

  const pickInt = (value, min, max, fallback) => { const n = Number(value); return Number.isInteger(n) && n >= min && n <= max ? n : fallback; };
  const cleanName = (raw, pid) => String(raw ?? '').trim().slice(0, 12) || '손님' + pid;     // 이름을 안 쓰면 '손님2' 처럼 번호를 붙인다
  const newPlayer = (pid, name, lives) => ({ pid, name: cleanName(name, pid), token: crypto.randomBytes(16).toString('hex'), lives, score: 0 });

  async function load(id) {
    const state = await redis.get(roomKey(id));
    if (state === null) throw new GameError(404, '없는 방이거나 보관 시간이 지난 방입니다');
    return state;
  }
  const save = (state) => redis.set(roomKey(state.id), state, { ttl: state.status === 'over' ? OVER_TTL : ROOM_TTL });

  /** 한 방을 한 번에 한 요청만 다룬다. busy 를 주면 잠겨 있을 때 오류 대신 그것을 부른다 (화면의 주기적 조회용) */
  async function withLock(id, run, busy = null) {
    if (!(await redis.set(lockKey(id), 1, { nx: true, ttl: LOCK_TTL }))) {
      if (busy) return busy();
      throw new GameError(409, '앞선 요청을 처리하는 중입니다');
    }
    try { return await run(); } finally { await redis.del(lockKey(id)); }
  }

  const alive = (state) => state.players.filter((p) => p.lives > 0);
  const playerOf = (state, token) => (token ? state.players.find((p) => p.token === token) || null : null);
  const findPid = (state, pid) => state.players.find((p) => p.pid === pid);

  /** pid 다음 차례: 자리 순서대로 돌면서 목숨이 남은 첫 사람 (self 면 pid 자신부터 본다) */
  function nextAlive(state, pid, self = false) {
    const list = state.players, at = list.findIndex((p) => p.pid === pid);
    for (let step = self ? 0 : 1; step <= list.length; step++) {
      const p = list[(at + step + list.length) % list.length];
      if (p.lives > 0) return p.pid;
    }
    return null;
  }

  /* ---------------------------------------------------------------- 시간 (service.js 와 같은 방식) */

  function turnLimit(state) {
    state.turnLimitMs = Math.max(1, Math.min(turnMs, state.roundLeftMs));
    return state.turnLimitMs;
  }
  const openTurn = (state) => redis.set(turnKey(state.id), 1, { ttl: state.turnLimitMs });
  const spend = (state, remaining) => { state.roundLeftMs = Math.max(0, state.roundLeftMs - (state.turnLimitMs - remaining)); };

  /** 화면에 보낼 모양: 토큰을 빼고, 남은 시간과 "나"(pid)를 붙인다 */
  async function view(state, me = null) {
    const playing = state.status === 'playing';
    const remainingMs = playing ? Math.max(0, await redis.ttl(turnKey(state.id))) : 0;
    const used = state.turnLimitMs - remainingMs;
    const { players, ...rest } = state;
    return {
      ...rest,
      players: players.map(({ token, ...p }) => p),
      history: state.history.slice(-80),
      me: me ? me.pid : null,
      remainingMs, turnMs,
      turnRemainingMs: playing ? Math.max(0, turnMs - used) : 0,
      roundRemainingMs: playing ? Math.max(0, state.roundLeftMs - used) : 0,
    };
  }

  /* ---------------------------------------------------------------- 방 목록 · 만들기 · 들어가기 · 나가기 */

  /** 끝나지 않은 방들 (새 방이 위로) */
  async function list() {
    const keys = (await redis.keys('room:')).filter((key) => /^room:\d+$/.test(key));
    const rooms = [];
    for (const key of keys) {
      const s = await redis.get(key);
      if (s && s.status !== 'over') rooms.push({ id: s.id, name: s.name, status: s.status, players: s.players.map((p) => p.name), max: MAX_PLAYERS, settings: s.settings });
    }
    return { rooms: rooms.sort((a, b) => b.id - a.id) };
  }

  /** 방을 만든다. 만든 사람이 방장이다 → { room, token } */
  async function create({ name, player, lives, round } = {}) {
    const id = await redis.incr('room:seq');
    const settings = {
      lives: pickInt(lives, 1, MAX_LIVES, LIVES),
      round: ROUND_TIMES.includes(Number(round)) ? Number(round) : DEFAULT_ROUND,
    };
    const host = newPlayer(1, player, settings.lives);
    const state = {
      id, name: String(name ?? '').trim().slice(0, 20) || host.name + '의 방', status: 'waiting', settings, host: 1, nextPid: 2, players: [host],
      turn: null, starter: null, need: null, history: [], turns: 0, roundNo: 0, roundMs: settings.round * secondMs, roundLeftMs: 0, turnLimitMs: turnMs,
      firstMove: false, winners: [], reason: null,
    };
    await save(state);
    return { room: await view(state, host), token: host.token };
  }

  /** 기다리는 방에 들어간다 → { room, token } */
  function join(id, { player } = {}) {
    return withLock(id, async () => {
      const state = await load(id);
      if (state.status !== 'waiting') throw new GameError(409, '이미 시작한 방입니다');
      if (state.players.length >= MAX_PLAYERS) throw new GameError(409, '방이 꽉 찼습니다 (최대 ' + MAX_PLAYERS + '명)');
      const me = newPlayer(state.nextPid++, player, state.settings.lives);
      state.players.push(me);
      await save(state);
      return { room: await view(state, me), token: me.token };
    });
  }

  /** 방에서 나간다. 기다리는 중이면 자리를 빼고(방장이 나가면 다음 사람이 방장), 판 중이면 목숨을 모두 잃은 것으로 친다 */
  function leave(id, token) {
    return withLock(id, async () => {
      const state = await load(id);
      const me = playerOf(state, token);
      if (!me) throw new GameError(403, '이 방의 사람이 아닙니다');
      if (state.status === 'waiting') {
        state.players = state.players.filter((p) => p !== me);
        if (state.players.length === 0) { await redis.del(roomKey(id)); return { left: true, room: null }; }
        if (state.host === me.pid) state.host = state.players[0].pid;
        await save(state);
      } else if (state.status === 'playing' && me.lives > 0) {
        me.lives = 0;
        state.history.push({ by: 'life', pid: me.pid, reason: 'left', left: 0 });
        if (alive(state).length <= 1) await finish(state, 'last-one');
        else {
          if (state.turn === me.pid) { state.turn = nextAlive(state, me.pid); turnLimit(state); await openTurn(state); }
          await save(state);
        }
      }
      return { left: true, room: await view(state, null) };
    });
  }

  /* ---------------------------------------------------------------- 판 진행 */

  /** 새 라운드: 나온 단어를 비우고, 시작 단어를 놓고, starter 의 차례를 연다 */
  async function openRound(state, starter) {
    await redis.delByPrefix(usedPrefix(state.id));
    const first = randomStart ? await dictionary.pickStartWord([], new Set()) : null;
    state.need = null;
    state.roundLeftMs = state.roundMs;
    state.firstMove = true;
    state.turn = starter;
    state.starter = starter;
    if (first) {
      state.history.push({ by: 'start', word: first.word, options: first.total, grade: gradeOf(first.total), points: 0 });
      state.need = nextStartChars(first.word);
      await redis.set(usedPrefix(state.id) + first.word, 1, { ttl: ROOM_TTL });
    }
    turnLimit(state);
    await save(state);
    await openTurn(state);
  }

  /** 방장이 판을 시작한다 (2명 이상). 첫 선공은 무작위 */
  function start(id, token) {
    return withLock(id, async () => {
      const state = await load(id);
      const me = playerOf(state, token);
      if (!me) throw new GameError(403, '이 방의 사람이 아닙니다');
      if (state.host !== me.pid) throw new GameError(403, '방장만 시작할 수 있습니다');
      if (state.status !== 'waiting') throw new GameError(409, '이미 시작한 방입니다');
      if (state.players.length < 2) throw new GameError(409, '2명 이상이어야 시작할 수 있습니다');
      state.status = 'playing';
      state.roundNo = 1;
      for (const p of state.players) { p.lives = state.settings.lives; p.score = 0; }
      await openRound(state, state.players[Math.floor(random() * state.players.length)].pid);
      return { room: await view(state, me) };
    });
  }

  /** 판을 끝낸다: 이긴 사람을 정하고, 사람마다 판 기록을 남기고, 방의 키를 정리한다 */
  async function finish(state, reason) {
    state.status = 'over';
    state.reason = reason;
    state.turn = null;
    state.winners = alive(state).map((p) => p.pid);          // 남은 사람 (모두 나갔으면 없음)
    for (const p of state.players) {
      await db.query('INSERT INTO games (player, level, turns, result, reason, score) VALUES (' +
        [quote(p.name), quote('room'), state.turns, quote(state.winners.includes(p.pid) ? 'win' : 'lose'), quote(reason), p.score].join(', ') + ')');
    }
    await redis.del('ranking');                              // 순위 캐시 무효화 (service.js 와 같은 키)
    await redis.del(turnKey(state.id));
    await redis.delByPrefix(usedPrefix(state.id));
    await save(state);
  }

  /** pid 가 목숨 하나를 잃는다 → 이번 라운드가 끝난다. 한 사람만 남으면 판이 끝나고, 아니면 새 라운드 */
  async function loseLife(state, pid, reason) {
    const p = findPid(state, pid);
    p.lives = Math.max(0, p.lives - 1);
    state.history.push({ by: 'life', pid, reason, left: p.lives });
    if (alive(state).length <= 1) return finish(state, 'last-one');
    state.roundNo++;
    return openRound(state, nextAlive(state, pid, true));    // 목숨을 잃은 사람이 먼저 (0 이 됐으면 그다음 사람)
  }

  /** 차례 키가 사라졌다: 그때 차례인 사람이 목숨을 잃는다 (라운드 시간이 먼저 끝났으면 'round-time') */
  const timeout = (state) => loseLife(state, state.turn, state.turnLimitMs < turnMs ? 'round-time' : 'timeout');

  /** 단어를 낸다 (내 차례일 때만) → { accepted, reject, room } */
  function play(id, token, raw) {
    return withLock(id, async () => {
      const trace = [];
      const word = String(raw ?? '').trim();
      const state = await load(id);
      const me = playerOf(state, token);
      if (!me) throw new GameError(403, '이 방의 사람이 아닙니다');
      if (state.status !== 'playing') throw new GameError(409, '진행 중인 판이 아닙니다');
      const done = async (extra) => ({ accepted: false, reject: null, ...extra, room: await view(state, me) });

      const remaining = await redis.ttl(turnKey(id));
      if (remaining === -2) { await timeout(state); return done({ reject: { code: 'timeout', message: '시간이 지났습니다' } }); }
      if (state.turn !== me.pid) return done({ reject: { code: 'not-your-turn', message: '내 차례가 아닙니다' } });

      const valid = WORD_PATTERN.test(word);
      const used = valid && (await redis.get(usedPrefix(id) + word)) !== null;
      const startsRight = !state.need || state.need.includes(word[0]);
      const found = valid && startsRight && !used ? await dictionary.lookup(word, trace) : null;
      const reject = rejectReason(word, { need: state.need, used, known: found ? found.known : true });
      if (reject) return done({ reject });

      const usedWords = new Set((await redis.keys(usedPrefix(id))).map((key) => key.slice(usedPrefix(id).length)));
      usedWords.add(word);
      const next = await dictionary.continuations(word, usedWords, trace);
      const firstKill = rejectReason(word, { firstKill: state.firstMove && (next.total === 0 || found.finisher) });
      if (firstKill) return done({ reject: firstKill });

      spend(state, remaining);
      await redis.set(usedPrefix(id) + word, 1, { ttl: ROOM_TTL });
      const grade = gradeOf(next.total), points = POINTS[grade] + letterPoints(word.length);
      me.score += points;
      state.history.push({ by: 'player', pid: me.pid, word, options: next.total, grade, points });
      state.need = nextStartChars(word);
      state.firstMove = false;
      state.turns++;
      state.turn = nextAlive(state, me.pid);
      turnLimit(state);
      await save(state);
      await openTurn(state);
      return done({ accepted: true });
    });
  }

  /** 방 상태. 판 중에 차례 키가 사라져 있으면 시간 초과를 반영한다 (다른 요청이 잠금 중이면 지금 상태만 돌려준다) */
  async function get(id, token) {
    const state = await load(id);
    const me = playerOf(state, token);
    if (state.status !== 'playing' || (await redis.ttl(turnKey(id))) !== -2) return { room: await view(state, me) };
    return withLock(id, async () => {
      const fresh = await load(id);
      if (fresh.status === 'playing' && (await redis.ttl(turnKey(id))) === -2) await timeout(fresh);
      return { room: await view(fresh, playerOf(fresh, token)) };
    }, async () => ({ room: await view(state, me) }));
  }

  return { list, create, join, leave, start, play, get };
}
