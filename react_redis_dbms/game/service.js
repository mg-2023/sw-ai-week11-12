/* ======================================================================
 * service.js — 끝말잇기 한 판의 진행. 미니 레디스와 미니 DBMS 를 여기서 함께 쓴다
 *
 *   미니 DBMS (파일에 오래 보관)                미니 레디스 (메모리에 잠깐 보관)
 *     words  등록한 단어                          word:<단어>             사전 확인 결과 캐시          60초
 *     games  끝난 판의 기록                       first:<글자>            그 글자로 시작하는 단어 캐시   60초
 *                                                 ranking                 기록 상위 10개 캐시           5초
 *                                                 game:<번호>             진행 중인 판의 상태 (목숨, 점수, 낸 단어)  30분
 *                                                 game:<번호>:used:<단어>  이번 라운드에 나온 단어       30분 (새 라운드에 지움)
 *                                                 game:<번호>:turn        지금 차례. 플레이어 차례면 사라질 때 시간 초과(10초), 상대 차례면 생각이 끝남(0.1~1초)
 *                                                 game:<번호>:lock        한 판을 한 번에 한 요청만 다루게 하는 잠금 (nx)
 *                                                 game:seq / stats:games  판 번호 / 끝난 판 수 (incr)
 *
 *   단어 확인   : 캐시(word:…)에 있으면 그대로, 없으면 DBMS 를 선형 탐색하고 결과를 캐시에 넣는다
 *   단어 등록   : DBMS 에 INSERT 한 뒤 word:<단어> 와 first:<첫 글자> 캐시를 지운다 (무효화)
 *   상대의 생각 : 내 단어는 바로 받아들이고, 상대 차례를 연다. 남은 라운드 시간에 따라 생각할 시간(0.1~1초, rules.js thinkTime)을
 *                 차례 키(game:<번호>:turn)의 TTL 로 걸고, 키가 사라진 뒤 처음 오는 요청에서 상대가 둔다 (시간 초과와 같은 방식).
 *                 생각한 시간도 라운드 시간에서 빠지고, 생각하는 동안 라운드 시간이 다 되면 상대가 목숨을 잃는다
 *   상대의 선택 : 후보마다 등급을 매겨 센 등급부터 확률을 굴린다 (rules.js pickWord). 등급은 메모리의 등급 표(글자 → 단어 수)로 매긴다.
 *                 등급 표는 사전을 처음 한 번 id 범위로 나눠 끝까지 읽어 세고, 그 뒤로는 등록 · 삭제할 때 숫자만 고친다
 *   단어 삭제   : 미니 DBMS 에는 DELETE 가 없다. 그래서 같은 단어를 removed = 1 로 한 줄 더 INSERT 한다 ("지웠다"는 기록).
 *                 같은 단어가 여러 줄이면 가장 나중 줄을 따르므로, 그 단어는 없는 단어가 된다. 캐시도 함께 지운다
 *   목숨        : 이을 단어를 내지 못한 쪽(시간 초과, 이을 단어 없음)이 목숨 하나를 잃고, 새 시작 단어로 이어 간다.
 *                 목숨이 0 이 되면 판이 끝난다
 *   새 라운드   : 끄투처럼 나온 단어를 비운다 (그 판의 used 키를 prefix 로 한꺼번에 지운다)
 *   판이 끝나면 : games 에 INSERT, 그 판의 used 키를 prefix 로 한꺼번에 지우고, ranking 캐시를 지운다
 *                 목숨이 0 이 되면 끝난다 (라운드 수는 따로 정하지 않는다. 목숨 수가 판의 길이를 정한다)
 *
 *   모든 응답의 trace 에는 "어디서 값을 가져왔는지"가 담긴다. 화면이 이것을 그대로 보여 준다.
 *     { label, key, source: 'cache' | 'db' | 'redis' | 'think', plan?, ms }
 * ====================================================================== */

import fs from 'node:fs';
import { createCache } from '../redis/src/cache.js';
import { quote } from './db.js';
import { WORD_PATTERN, LEVELS, ROUND_TIMES, DEFAULT_ROUND, LIVES, MAX_LIVES, POINTS, letterPoints, firstChar, lastChar, nextStartChars, rejectReason, pickWord, gradeOf, thinkTime } from './rules.js';

/** 파일에서 word 와 같은 줄을 모두 지운다 */
function dropLine(file, word) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const kept = lines.filter((line) => line.trim() !== word);
  if (kept.length !== lines.length) fs.writeFileSync(file, kept.join('\n'));
}

/** 요청을 처리할 수 없을 때. status 가 HTTP 상태 코드가 된다 */
export class GameError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const GAME_TTL = 30 * 60_000;        // 진행 중인 판을 보관하는 시간
const OVER_TTL = 10 * 60_000;        // 끝난 판을 다시 볼 수 있는 시간
const LOCK_TTL = 5_000;
const START_TRIES = 30;              // 시작 단어를 뽑아 보는 횟수

/**
 * redis     : redis/src/client.js 의 클라이언트
 * db        : game/db.js 의 클라이언트
 * turnMs    : 한 차례의 제한 시간
 * random    : 상대가 단어를 고를 때, 시작 단어를 뽑을 때 쓰는 난수 함수
 * lives     : 판을 시작할 때 목숨 수를 고르지 않으면 쓰는 값 (플레이어와 상대가 각각 갖는 목숨 수)
 * randomStart : 판을 열 때 2~3글자 시작 단어를 무작위로 제시할지 (false 면 플레이어가 아무 단어로 시작)
 * secondMs  : 라운드 시간 1초의 길이 (테스트에서 줄여 쓴다)
 * coin      : 판의 첫 라운드에 누가 먼저 낼지 정하는 난수 (0.5 미만이면 플레이어)
 * wordFiles : { words, finishers, removed } 화면에서 등록·삭제한 단어를 이어 적을 파일 (없으면 적지 않는다)
 * think     : 남은 라운드 시간(ms) → 상대가 생각할 시간(ms). 기본은 rules.js thinkTime 을 secondMs 에 맞춰 늘이고 줄인 것. 0 이면 기다리지 않고 바로 둔다
 */
export function createGameService({ redis, db, turnMs = 10_000, random = Math.random, wordFiles = null, randomStart = true, lives = LIVES, secondMs = 1000, coin = random,
  think = (roundLeftMs) => thinkTime(roundLeftMs * 1000 / secondMs, random) * secondMs / 1000 }) {
  const wordCache = createCache(redis, { ttl: 60_000 });
  const rankCache = createCache(redis, { ttl: 5_000 });
  let registering = Promise.resolve();     // 단어 등록을 한 줄로 세운다 ("있는지 확인 → INSERT" 사이에 다른 등록이 끼어들지 않게)

  const gameKey = (id) => 'game:' + id;
  const turnKey = (id) => 'game:' + id + ':turn';
  const usedPrefix = (id) => 'game:' + id + ':used:';

  /* ---------------------------------------------------------------- 단어 사전 */

  /** 캐시를 거쳐 값을 가져오고, 어디서 가져왔는지 trace 에 남긴다 */
  async function cached(cache, key, label, trace, load) {
    const started = performance.now();
    let plan = null;
    const { value, hit } = await cache.getOrLoad(key, async () => {
      const loaded = await load();
      plan = loaded.plan;
      return loaded.value;
    });
    trace.push({ label, key, source: hit ? 'cache' : 'db', plan, ms: performance.now() - started });
    return value;
  }

  /** DBMS 에서 단어 한 개를 찾는다. 같은 단어가 여러 줄이면 가장 나중 줄을 따른다 (나중 줄이 removed = 1 이면 지워진 단어) */
  async function findWord(word) {
    const result = await db.query('SELECT id, finisher, removed FROM words WHERE word = ' + quote(word));
    const latest = result.objects.reduce((a, b) => (a && a.id > b.id ? a : b), null);
    const known = latest !== null && latest.removed !== 1;
    return { plan: result.plan, value: { known, finisher: known && latest.finisher === 1 } };
  }

  /** 등록된 단어인가 → { known, finisher } */
  const lookup = (word, trace) => cached(wordCache, 'word:' + word, "'" + word + "' 사전 확인", trace, () => findWord(word));

  /** char 로 시작하는 단어 전부 → [{ word, finisher }] */
  const wordsStartingWith = (char, trace) => cached(wordCache, 'first:' + char, "'" + char + "'(으)로 시작하는 단어", trace, async () => {
    const result = await db.query('SELECT id, word, finisher, removed FROM words WHERE first = ' + quote(char));
    const latest = new Map();                                  // 같은 단어는 가장 나중 줄만 남긴다
    for (const row of result.objects.sort((a, b) => a.id - b.id)) latest.set(row.word, row);
    const alive = [...latest.values()].filter((row) => row.removed !== 1);            // 지워진 단어는 뺀다
    return { plan: result.plan, value: alive.map((row) => ({ word: row.word, finisher: row.finisher === 1 })) };
  });

  /** word 다음에 낼 수 있는 단어들 (두음법칙 포함) → { total, open } */
  async function continuations(word, used, trace) {
    const lists = [];
    for (const char of nextStartChars(word)) lists.push(await wordsStartingWith(char, trace));
    const all = lists.flat();
    // total: 사전에 있는 전체 개수 (등급을 매길 때 쓴다. 이번 라운드에 써서 줄어든 것은 반영하지 않는다)
    // open : 그중 이번 라운드에 아직 나오지 않아 실제로 낼 수 있는 단어
    return { total: all.length, open: all.filter((c) => !used.has(c.word)) };
  }

  /*
   * 등급 표: 글자 → 그 글자로 시작하는 (지워지지 않은) 단어 수.
   * 상대는 후보마다 등급을 알아야 고를 수 있다 (pickWord). 후보가 수백 개이고 끝 글자도 제각각이라 글자마다 first:<글자> 를 불러오면
   * 한 차례에 DBMS 를 수백 번 부를 수 있다. 그래서 사전을 한 번 끝까지 읽어 세어 두고, 등록 · 삭제 때는 숫자만 고친다.
   * 한 번에 돌려받는 레코드 수에 상한(maxRows)이 있어서 id 범위로 나눠 읽는다 (WHERE id > 마지막 번호 → B+ 트리 INDEX_RANGE)
   */
  let gradeCounts = null;                  // 다 센 표 (Map). 아직 안 셌으면 null
  let gradeCounting = null;                // 세는 중인 작업 (Promise)

  async function countFirsts() {
    const latest = new Map();              // 같은 단어는 번호가 가장 큰 줄만 남긴다 (findWord 와 같은 규칙)
    for (let last = 0; ;) {
      const result = await db.query('SELECT id, word, first, removed FROM words WHERE id > ' + last);
      for (const row of result.objects) {
        const prev = latest.get(row.word);
        if (!prev || prev.id < row.id) latest.set(row.word, row);
        last = Math.max(last, row.id);
      }
      if (!result.truncated || result.objects.length === 0) break;      // 잘리지 않았으면 끝까지 읽은 것이다
    }
    const counts = new Map();
    for (const row of latest.values()) if (row.removed !== 1) counts.set(row.first, (counts.get(row.first) ?? 0) + 1);
    return counts;
  }

  /** 등급 표를 돌려준다 (처음이면 센다). 등록 · 삭제와 같은 줄(registering)에 세워, 세는 도중의 등록이 빠지거나 두 번 세지지 않게 한다 */
  function gradeTable() {
    if (gradeCounts) return Promise.resolve(gradeCounts);
    if (!gradeCounting) {
      const job = registering.then(countFirsts).then((counts) => {
        if (gradeCounting === job) gradeCounts = counts;                   // 세는 동안 표를 버렸으면(clearWordCache) 쓰지 않는다
        return counts;
      });
      gradeCounting = job;
      registering = job.catch(() => {});
      job.catch(() => { if (gradeCounting === job) gradeCounting = null; });   // 실패하면 다음에 다시 센다
    }
    return gradeCounting;
  }

  /** 등록 · 삭제 뒤 등급 표의 숫자를 고친다. 아직 다 세지 않았으면 할 일이 없다 (나중에 셀 때 DBMS 에서 반영된다) */
  function bumpCount(char, delta) {
    if (gradeCounts) gradeCounts.set(char, (gradeCounts.get(char) ?? 0) + delta);
  }

  /** 등급 표 → (단어 → 등급 이름). 셈은 continuations 의 total 과 같다 (끝 글자 + 두음법칙 글자로 시작하는 단어 수, 이번 라운드에 나온 단어 포함) */
  const graderOf = (counts) => (word) => gradeOf(nextStartChars(word).reduce((sum, char) => sum + (counts.get(char) ?? 0), 0));

  /** 판의 기록에 남길 한 줄: 누가, 무슨 단어를, 이을 수 있는 단어 수와 등급, 받은 점수 (시작 단어는 0점) */
  const entry = (by, word, total, extra = {}) => ({ by, word, options: total, grade: gradeOf(total), points: by === 'start' ? 0 : POINTS[gradeOf(total)] + letterPoints(word.length), ...extra });

  /** 단어 등록. 이미 있는 일반 단어를 끝내기로 다시 등록하면 끝내기 단어로 바뀐다 */
  function register(raw, finisher = false) {
    const job = registering.then(async () => {
      const word = String(raw ?? '').trim();
      if (!WORD_PATTERN.test(word)) throw new GameError(400, '한글 2글자 이상으로 입력하세요');
      finisher = finisher === true;

      const existing = (await findWord(word)).value;
      if (existing.known && (existing.finisher || !finisher)) return { added: false, word, finisher: existing.finisher, message: "'" + word + "'은(는) 이미 등록된 단어입니다" };

      const inserted = await db.query('INSERT INTO words (word, first, last, finisher) VALUES (' +
        [quote(word), quote(firstChar(word)), quote(lastChar(word)), finisher ? 1 : 0].join(', ') + ')');
      const invalidated = ['word:' + word, 'first:' + firstChar(word)];
      for (const key of invalidated) await wordCache.invalidate(key);      // 원본이 바뀌었으니 옛 캐시를 지운다
      if (!existing.known) bumpCount(firstChar(word), +1);                  // 끝내기로 바꾸기만 한 단어는 개수가 그대로다

      if (wordFiles) {
        fs.appendFileSync(finisher ? wordFiles.finishers : wordFiles.words, '\n' + word + '\n');
        if (wordFiles.removed) dropLine(wordFiles.removed, word);            // 지웠던 단어를 다시 등록하면 삭제 목록에서 뺀다
      }
      return { added: true, word, finisher, id: inserted.firstId, invalidated,
        message: existing.known ? "'" + word + "'을(를) 끝내기 단어로 바꿨습니다" : "'" + word + "'을(를) 등록했습니다" };
    });
    registering = job.catch(() => {});
    return job;
  }

  /** 단어 삭제. 등록된 단어가 아니면 아무것도 하지 않는다 */
  function remove(raw) {
    const job = registering.then(async () => {
      const word = String(raw ?? '').trim();
      if (!WORD_PATTERN.test(word)) throw new GameError(400, '한글 2글자 이상으로 입력하세요');
      if (!(await findWord(word)).value.known) return { removed: false, word, message: "'" + word + "'은(는) 등록되지 않은 단어입니다" };

      const inserted = await db.query('INSERT INTO words (word, first, last, finisher, removed) VALUES (' +
        [quote(word), quote(firstChar(word)), quote(lastChar(word)), 0, 1].join(', ') + ')');
      const invalidated = ['word:' + word, 'first:' + firstChar(word)];
      for (const key of invalidated) await wordCache.invalidate(key);
      bumpCount(firstChar(word), -1);

      if (wordFiles && wordFiles.removed) fs.appendFileSync(wordFiles.removed, '\n' + word + '\n');   // 사전을 다시 만들어도 되살아나지 않게 적어 둔다
      return { removed: true, word, id: inserted.firstId, invalidated, message: "'" + word + "'을(를) 삭제했습니다" };
    });
    registering = job.catch(() => {});
    return job;
  }

  /* ---------------------------------------------------------------- 판 진행 */

  async function load(id) {
    const state = await redis.get(gameKey(id));
    if (state === null) throw new GameError(404, '없는 판이거나 보관 시간이 지난 판입니다');
    return state;
  }

  /** 화면에 보낼 모양: 상태 + 남은 시간 */
  async function view(state) {
    const remainingMs = state.status === 'playing' ? Math.max(0, await redis.ttl(turnKey(state.id))) : 0;
    const used = (state.turnLimitMs ?? turnMs) - remainingMs;                // 이번 차례에 쓴 시간
    const playing = state.status === 'playing';
    // remainingMs      : 실제로 시간 초과가 되는 때까지 (차례 키의 남은 시간 = min(차례, 라운드))
    // turnRemainingMs  : 화면의 차례 막대. 차례마다 10초로 다시 차고, 라운드 시간과 따로 줄어든다
    // roundRemainingMs : 화면의 라운드 막대
    // 상대가 생각하는 동안은 내 차례 막대를 가득 찬 채로 둔다 (내 시간은 상대가 둔 뒤부터 흐른다)
    const turnRemainingMs = !playing ? 0 : state.turn === 'computer' ? turnMs : Math.max(0, turnMs - used);
    const roundRemainingMs = playing && state.roundLeftMs !== undefined ? Math.max(0, state.roundLeftMs - used) : 0;
    return { ...state, remainingMs, turnRemainingMs, roundRemainingMs, turnMs };
  }

  /**
   * 플레이어 차례를 연다: 차례 키에 min(한 차례 제한, 라운드 남은 시간)을 건다. 이 키가 사라지면 시간 초과다.
   * 판 상태(turnLimitMs)를 바꾸므로 판 상태를 저장하기 전에 부른다
   */
  function turnLimit(state) {
    state.turnLimitMs = Math.max(1, Math.min(turnMs, state.roundLeftMs ?? Infinity));
    return state.turnLimitMs;
  }
  const openTurn = (state) => redis.set(turnKey(state.id), 1, { ttl: state.turnLimitMs });

  /** 단어를 받아들이면, 이번 차례에 쓴 시간을 라운드 시간에서 뺀다 (remaining: 차례 키의 남은 시간) */
  function spend(state, remaining) {
    if (state.roundLeftMs !== undefined) state.roundLeftMs = Math.max(0, state.roundLeftMs - (state.turnLimitMs - remaining));
  }

  /** 시간 초과의 이유: 라운드 시간이 차례 제한보다 먼저 끝났으면 'round-time', 아니면 'timeout' */
  const timeoutReason = (state) => (state.turnLimitMs < turnMs ? 'round-time' : 'timeout');

  /** 한 판을 한 번에 한 요청만 다루게 한다. 잠금 키를 nx(없을 때만 저장)로 만든 요청만 들어간다 */
  async function withLock(id, run) {
    const lockKey = gameKey(id) + ':lock';
    if (!(await redis.set(lockKey, 1, { nx: true, ttl: LOCK_TTL }))) throw new GameError(409, '앞선 요청을 처리하는 중입니다');
    try { return await run(); } finally { await redis.del(lockKey); }
  }

  /** 판을 끝낸다: 기록 저장, 그 판의 키 정리, 순위 캐시 무효화 */
  async function finish(state, result, reason, trace) {
    state.status = 'over';
    state.result = result;
    state.reason = reason;

    const started = performance.now();
    const saved = await db.query('INSERT INTO games (player, level, turns, result, reason, score) VALUES (' +
      [quote(state.player), quote(state.level), state.turns, quote(result), quote(reason), state.score.player].join(', ') + ')');
    state.recordId = saved.firstId;
    trace.push({ label: '판 기록 저장 (기록 번호 ' + saved.firstId + ')', key: 'games', source: 'db', plan: 'INSERT', ms: performance.now() - started });

    await redis.del(turnKey(state.id));
    const removed = await redis.delByPrefix(usedPrefix(state.id));
    await rankCache.invalidate('ranking');
    await redis.incr('stats:games');
    await redis.set(gameKey(state.id), state, { ttl: OVER_TTL });
    trace.push({ label: '이번 판의 단어 표시 ' + removed + '개와 순위 캐시 지움', key: usedPrefix(state.id) + '*', source: 'redis', plan: null, ms: 0 });
    return state;
  }

  /** 이번 라운드에 나온 단어들 */
  const usedWordsOf = async (id) => new Set((await redis.keys(usedPrefix(id))).map((key) => key.slice(usedPrefix(id).length)));

  /**
   * 시작 단어를 무작위로 고른다: 2~3글자이고, 이번 라운드에 아직 나오지 않았고, 이을 수 있는 단어가 하나 이상 있는 것.
   * 단어 번호(id)를 무작위로 뽑아 WHERE id = ? 로 찾는다 → B+ 트리 인덱스를 타므로 사전이 커도 바로 찾는다.
   * 사전이 비었거나 START_TRIES 번 안에 못 찾으면 null (그때는 플레이어가 아무 단어로 시작한다)
   */
  async function pickStartWord(trace, used = new Set()) {
    const table = (await db.tables()).find((t) => t.table === 'words');
    if (!table || table.rows === 0) return null;
    for (let i = 0; i < START_TRIES; i++) {
      const id = 1 + Math.floor(random() * table.rows);
      const started = performance.now();
      const result = await db.query('SELECT word FROM words WHERE id = ' + id);
      const word = result.objects[0] ? result.objects[0].word : null;
      trace.push({ label: '시작 단어 뽑기 (단어 번호 ' + id + (word ? ", '" + word + "'" : '') + ')', key: 'words', source: 'db', plan: result.plan, ms: performance.now() - started });
      if (!word || word.length < 2 || word.length > 3 || used.has(word)) continue;
      if (!(await lookup(word, trace)).known) continue;                    // 그 번호의 줄이 지워진 단어일 수 있다
      const next = await continuations(word, new Set([...used, word]), trace);
      if (next.open.length > 0) return { word, total: next.total };
    }
    return null;
  }

  /**
   * 상대 차례를 연다: 남은 라운드 시간에 따라 생각할 시간을 정하고(rules.js thinkTime: 넉넉하면 0.5~1초, 거의 없으면 0.1~0.2초)
   * 그 시간을 차례 키의 TTL 로 건다. 키가 사라진 뒤 처음 오는 요청(get · play)에서 상대가 둔다 (computerReply).
   * 그래서 내 단어는 이 요청에서 바로 들어가고, 상대의 단어는 생각 시간이 지난 뒤에 나온다.
   * 생각을 마치기 전에 라운드 시간이 끝나면(thinkLate) 키는 라운드가 끝나는 때 사라지고, 상대가 'round-time' 으로 목숨을 잃는다.
   * 생각 시간이 0 이면 기다리지 않고 바로 둔다 → 둔 단어를 돌려준다. 기다릴 때는 null
   */
  async function computerTurn(state, trace) {
    const left = state.roundLeftMs ?? Infinity;
    const wanted = Math.max(0, Math.round(think(left)));
    state.turn = 'computer';
    state.thinkLate = wanted >= left;
    state.thinkMs = Math.min(wanted, left);
    state.turnLimitMs = Math.max(1, state.thinkMs);
    if (wanted === 0) return computerReply(state, trace);
    trace.push({ label: '상대 차례: 생각할 시간 ' + (state.thinkMs / 1000).toFixed(1) + '초를 차례 키의 TTL 로 걸었습니다', key: turnKey(state.id), source: 'redis', plan: null, ms: 0 });
    await redis.set(gameKey(state.id), state, { ttl: GAME_TTL });
    await openTurn(state);                                         // 상대 차례: 이 키가 사라지면 상대가 둔다
    return null;
  }

  /**
   * 상대가 생각을 마치고 둔다 (상대 차례의 차례 키가 사라졌을 때, 또는 생각 시간이 0 일 때).
   * 생각한 시간만큼 라운드 시간을 줄이고, 생각하는 동안 라운드 시간이 끝났으면 상대가 목숨을 잃는다.
   * 이을 단어가 없으면 상대가, 상대의 단어에 이을 단어가 없으면 플레이어가 목숨을 잃는다. 아니면 플레이어 차례를 연다.
   * 둔 단어 { word, finisher, thinkMs } 를 돌려준다 (못 두었으면 null)
   */
  async function computerReply(state, trace) {
    const spent = state.thinkMs ?? 0;
    if (state.roundLeftMs !== undefined) state.roundLeftMs = Math.max(0, state.roundLeftMs - spent);
    state.turn = 'player';
    trace.push({ label: state.thinkLate ? '상대가 생각하는 동안 라운드 시간이 다 됨' : '상대가 생각한 시간 (남은 라운드 시간에 따라 0.1~1초)', key: turnKey(state.id), source: 'think', plan: null, ms: spent });
    if (state.thinkLate) { await loseLife(state, 'computer', 'round-time', trace); return null; }

    const usedWords = await usedWordsOf(state.id);
    const last = [...state.history].reverse().find((h) => h.word);       // 상대가 이어야 할 단어 (내 단어 또는 시작 단어)
    let reply = null, theirs = null;
    if (state.need && last) {
      const move = await computerMove(state, usedWords, (await continuations(last.word, usedWords, trace)).open, trace, spent);
      if (move) ({ reply, theirs } = move);
    } else {                                                             // 시작 단어 없이 상대가 먼저: 시작 단어를 뽑는 방법으로 고른다
      const opening = await pickStartWord(trace, usedWords);
      if (opening) {
        reply = { word: opening.word, finisher: (await lookup(opening.word, trace)).finisher, thinkMs: spent };
        theirs = await recordComputer(state, usedWords, reply, trace, spent);
      }
    }
    if (!reply) { await loseLife(state, 'computer', 'computer-stuck', trace); return null; }
    if (theirs.open.length === 0) { await loseLife(state, 'player', 'no-word', trace); return reply; }

    turnLimit(state);
    await redis.set(gameKey(state.id), state, { ttl: GAME_TTL });
    await openTurn(state);                                         // 플레이어 차례 시작: 이 키가 사라지면 시간 초과
    return reply;
  }

  /**
   * 상대가 한 수 둔다: 후보마다 등급을 매겨 센 등급부터 확률을 굴린다 (rules.js pickWord). 등급 표를 못 만들면 등급 없이 고른다.
   * 라운드의 첫 수면 한방 단어(끝내기 단어, 이을 단어 0개)를 빼고 고른다 (첫 턴 한방 금지).
   * 낼 단어가 없으면 null, 냈으면 { reply, theirs } (theirs: 그 단어 다음에 플레이어가 낼 수 있는 단어)
   */
  async function computerMove(state, usedWords, candidates, trace, thinkMs = 0) {
    const ready = gradeCounts !== null, started = performance.now();
    const counts = await gradeTable().catch(() => null);
    if (!ready) trace.push({ label: counts ? '등급 표 만들기 (사전 전체를 한 번 셈, 글자 ' + counts.size + '개)' : '등급 표 만들기 실패 → 등급 없이 고름', key: 'words', source: 'db', plan: 'INDEX_RANGE', ms: performance.now() - started });
    const grader = counts ? graderOf(counts) : undefined;
    const pool = state.firstMove ? candidates.filter((c) => !c.finisher && (!grader || grader(c.word) !== 'kill')) : candidates;
    const reply = pickWord(pool, state.level, random, grader);
    return reply ? { reply: { ...reply, thinkMs }, theirs: await recordComputer(state, usedWords, reply, trace, thinkMs) } : null;
  }

  /** 상대가 낸 단어를 판에 적는다 → 그 단어 다음에 플레이어가 낼 수 있는 단어 */
  async function recordComputer(state, usedWords, reply, trace, thinkMs = 0) {
    await redis.set(usedPrefix(state.id) + reply.word, 1, { ttl: GAME_TTL });
    usedWords.add(reply.word);
    const theirs = await continuations(reply.word, usedWords, trace);
    const answered = entry('computer', reply.word, theirs.total, { finisher: reply.finisher, thinkMs });
    state.history.push(answered);
    state.score.computer += answered.points;
    state.turns++;
    state.need = nextStartChars(reply.word);
    state.firstMove = false;
    return theirs;
  }

  /**
   * 새 라운드를 연다 (판을 열 때, 그리고 누군가 목숨을 잃은 뒤).
   *   starter : 먼저 내는 쪽. 판의 첫 라운드는 무작위, 그 뒤로는 목숨을 잃은 쪽
   * 시작 단어를 놓고(randomStart), 상대가 먼저면 상대 차례를 연다 (생각한 뒤 첫 수를 둔다). 아니면 플레이어 차례를 연다.
   * 시작 단어가 없을 때 상대의 첫 수는 시작 단어를 뽑는 방법(pickStartWord: 2~3글자, 이을 단어가 있음)으로 고른다.
   * 상대가 첫 수를 못 두면 상대가, 상대의 첫 수에 이을 단어가 없으면 플레이어가 목숨을 잃는다 (computerReply).
   * 새 라운드라 라운드 시간이 가득 → 상대는 0.5~1초 생각한다
   */
  async function openRound(state, used, trace, starter = 'player') {
    const first = randomStart ? await pickStartWord(trace, used) : null;
    state.need = null;
    state.roundLeftMs = state.roundMs;                                     // 새 라운드: 라운드 시간을 다시 채운다
    state.firstMove = true;                                                // 이번 라운드의 첫 수: 한방 단어 금지
    state.starter = starter;
    if (first) {
      state.history.push(entry('start', first.word, first.total));
      state.need = nextStartChars(first.word);
      await redis.set(usedPrefix(state.id) + first.word, 1, { ttl: GAME_TTL });      // 시작 단어도 이번 라운드에 나온 단어다
    }
    if (starter === 'computer') { await computerTurn(state, trace); return; }
    state.turn = 'player';
    turnLimit(state);
    await redis.set(gameKey(state.id), state, { ttl: GAME_TTL });
    await openTurn(state);                                         // 플레이어 차례 시작: 이 키가 사라지면 시간 초과
  }

  /**
   * who('player' | 'computer')가 목숨 하나를 잃는다. 이것으로 이번 라운드가 끝난다.
   * 목숨이 0 이 되면 판이 끝난다.
   * 아니면 나온 단어를 비우고(끄투처럼 라운드마다) 새 라운드를 연다. 목숨을 잃은 쪽이 먼저 낸다
   *   reason: 'timeout' 시간 초과 · 'round-time' 라운드 시간 끝 (플레이어 차례, 또는 상대가 생각하는 중) · 'no-word' 이을 단어가 없음 · 'computer-stuck' 상대가 이을 단어가 없음
   */
  async function loseLife(state, who, reason, trace) {
    state.lives[who]--;
    state.history.push({ by: 'life', who, reason, left: state.lives[who] });
    if (state.lives[who] <= 0) return finish(state, who === 'player' ? 'lose' : 'win', reason, trace);
    state.roundNo = (state.roundNo ?? 1) + 1;
    const cleared = await redis.delByPrefix(usedPrefix(state.id));
    trace.push({ label: '새 라운드 ' + state.roundNo + ': 지난 라운드의 단어 표시 ' + cleared + '개 지움', key: usedPrefix(state.id) + '*', source: 'redis', plan: null, ms: 0 });
    await openRound(state, new Set(), trace, who);                         // 목숨을 잃은 쪽이 다음 라운드를 먼저 낸다
    return state;
  }

  async function start({ player, level, round, lives: pickedLives } = {}) {
    const name = String(player ?? '').trim().slice(0, 12) || '손님';
    if (!LEVELS.includes(level)) level = 'normal';
    round = Number(round);
    if (!ROUND_TIMES.includes(round)) round = DEFAULT_ROUND;
    const lifeCount = Number.isInteger(Number(pickedLives)) && pickedLives >= 1 && pickedLives <= MAX_LIVES ? Number(pickedLives) : lives;   // 1~5 가 아니면 기본값
    const trace = [];
    const id = await redis.incr('game:seq');
    const state = {
      id, player: name, level, round, roundNo: 1, roundMs: round * secondMs, roundLeftMs: round * secondMs, turnLimitMs: turnMs, status: 'playing', result: null, reason: null, need: null, turns: 0,
      lives: { player: lifeCount, computer: lifeCount }, livesStart: lifeCount, score: { player: 0, computer: 0 }, history: [],
    };
    await openRound(state, new Set(), trace, coin() < 0.5 ? 'player' : 'computer');   // 첫 라운드의 선공은 무작위
    return { game: await view(state), trace };
  }

  /** 플레이어가 단어를 낸다 → 받아들이면 상대 차례를 연다 (상대의 단어는 생각 시간이 지난 뒤 나온다) */
  function play(id, raw) {
    return withLock(id, async () => {
      const trace = [];
      const word = String(raw ?? '').trim();
      const state = await load(id);
      if (state.status !== 'playing') throw new GameError(409, '이미 끝난 판입니다');
      const done = async (extra) => ({ accepted: false, reject: null, computer: null, ...extra, game: await view(state), trace });

      // 상대가 생각하는 중이면 단어를 받지 않는다. 생각 시간이 이미 지났으면 상대의 수를 먼저 반영한다
      if (state.turn === 'computer') {
        const over = (await redis.ttl(turnKey(id))) === -2;
        const reply = over ? await computerReply(state, trace) : null;
        return done({ computer: reply, reject: { code: 'not-your-turn', message: over ? '상대가 방금 단어를 냈습니다. 그 단어에 이어서 내세요' : '상대가 생각하는 중입니다' } });
      }

      // 차례 키가 만료돼 사라졌으면 시간 초과다: 목숨을 잃고, 지금 낸 단어는 받지 않는다
      const remaining = await redis.ttl(turnKey(id));
      if (remaining === -2) {
        await loseLife(state, 'player', timeoutReason(state), trace);
        return done({ reject: state.status === 'playing' ? { code: 'timeout', message: '시간이 지나 목숨을 하나 잃었습니다' } : null });
      }

      const valid = WORD_PATTERN.test(word);
      const used = valid && (await redis.get(usedPrefix(id) + word)) !== null;
      const startsRight = !state.need || state.need.includes(word[0]);
      const found = valid && startsRight && !used ? await lookup(word, trace) : null;   // 사전은 다른 조건을 통과한 단어만 찾아본다
      const reject = rejectReason(word, { need: state.need, used, known: found ? found.known : true });
      if (reject) return done({ reject });

      // 이을 단어를 센다. 라운드의 첫 단어로 한방 단어(이을 단어 0개, 또는 끝내기 단어)를 내면 받지 않는다 (첫 턴 한방 금지)
      const usedWords = await usedWordsOf(id);
      usedWords.add(word);
      const mine = await continuations(word, usedWords, trace);
      const firstKill = rejectReason(word, { firstKill: state.firstMove === true && (mine.total === 0 || found.finisher) });
      if (firstKill) return done({ reject: firstKill });

      // 받아들인 단어를 이번 라운드에 나온 단어로 표시하고, 등급에 따라 점수를 준다. 이번 차례에 쓴 시간은 라운드 시간에서 뺀다
      spend(state, remaining);
      await redis.set(usedPrefix(id) + word, 1, { ttl: GAME_TTL });
      const played = entry('player', word, mine.total);
      state.history.push(played);
      state.score.player += played.points;
      state.turns++;
      state.firstMove = false;
      state.need = nextStartChars(word);                       // 상대가 이어야 할 글자

      // 상대 차례: 생각할 시간을 차례 키에 걸고 바로 답한다. 상대의 단어는 그 키가 사라진 뒤 판 상태를 물을 때 나온다
      // (생각 시간이 0 이면 여기서 바로 둔다)
      const reply = await computerTurn(state, trace);
      return done({ accepted: true, computer: reply });
    });
  }

  /** 판의 현재 상태. 차례 키가 사라져 있으면: 플레이어 차례였으면 시간 초과로 목숨을 잃고, 상대 차례였으면 상대가 생각을 마치고 둔다 */
  async function get(id) {
    const state = await load(id);
    if (state.status !== 'playing' || (await redis.ttl(turnKey(id))) !== -2) return { game: await view(state), trace: [] };
    return withLock(id, async () => {
      const trace = [];
      const fresh = await load(id);
      if (fresh.status === 'playing' && (await redis.ttl(turnKey(id))) === -2) {
        if (fresh.turn === 'computer') await computerReply(fresh, trace);
        else await loseLife(fresh, 'player', timeoutReason(fresh), trace);
      }
      return { game: await view(fresh), trace };
    });
  }

  function giveUp(id) {
    return withLock(id, async () => {
      const trace = [];
      const state = await load(id);
      if (state.status === 'playing') await finish(state, 'lose', 'give-up', trace);
      return { game: await view(state), trace };
    });
  }

  /* ---------------------------------------------------------------- 조회 */

  /** 점수가 가장 높은 판 10개 */
  async function ranking() {
    const trace = [];
    const rows = await cached(rankCache, 'ranking', '순위 조회', trace, async () => {
      const result = await db.query('SELECT id, player, level, turns, result, score FROM games ORDER BY score DESC LIMIT 10');
      return { plan: result.plan, value: result.objects };
    });
    return { ranking: rows, trace };
  }

  /** 기록 번호로 판 기록 한 건을 찾는다 (B+ 트리 인덱스 사용) */
  async function record(id) {
    const started = performance.now();
    const result = await db.query('SELECT * FROM games WHERE id = ' + Number(id));
    return { record: result.objects[0] ?? null, trace: [{ label: '기록 번호 ' + Number(id) + ' 조회', key: 'games', source: 'db', plan: result.plan, ms: performance.now() - started }] };
  }

  /**
   * prefix 로 시작하는 등록 단어 목록 (한 글자든 여러 글자든 된다).
   * 미니 DBMS 는 "~로 시작하는" 조건(LIKE)이 없어서, 첫 글자가 같은 단어를 가져온 뒤(캐시됨) 여기서 앞부분을 비교해 거른다
   */
  async function words(prefix) {
    const trace = [];
    prefix = String(prefix ?? '').trim();
    if (!/^[가-힣]{1,20}$/.test(prefix)) throw new GameError(400, '찾을 단어의 앞부분을 한글로 입력하세요');
    const sameFirst = await wordsStartingWith(prefix[0], trace);
    return { first: prefix, words: prefix.length === 1 ? sameFirst : sameFirst.filter((w) => w.word.startsWith(prefix)), trace };
  }

  /** 두 저장소의 현재 상태 */
  async function status() {
    const [info, tables, pool] = await Promise.all([redis.info(), db.tables(), db.stats()]);
    return { redis: info, tables, pool, cache: { ...wordCache.stats } };
  }

  /** 단어 캐시를 모두 지운다 (단어 파일을 다시 읽어 들인 뒤에 부른다). 등급 표도 버려서 다음에 다시 센다 */
  async function clearWordCache() {
    gradeCounts = null;
    gradeCounting = null;
    return (await redis.delByPrefix('word:')) + (await redis.delByPrefix('first:'));
  }

  /** 등급 표를 미리 센다 (서버를 켤 때 부른다. 첫 차례가 잠금 시간 안에 끝나도록) → 표 (Map) */
  const prepareGrades = () => gradeTable();

  // 같이 하는 방(rooms.js)이 같은 사전 · 캐시를 쓰도록 내준다
  const dictionary = { lookup, continuations, pickStartWord };

  return { register, remove, start, play, get, giveUp, ranking, record, words, status, clearWordCache, prepareGrades, dictionary };
}
