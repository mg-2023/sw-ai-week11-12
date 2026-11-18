/* ======================================================================
 * auth.js — 제작자 로그인. 단어 등록은 로그인한 제작자만 할 수 있다
 *
 *   계정은 하나뿐이고 admin.json 에 들어 있다. (만드는 방법: npm run admin)
 *     { "id": "…", "salt": "…", "hash": "…" }      비밀번호 자체는 저장하지 않는다
 *     hash = scrypt(비밀번호, salt)  →  파일이 새어 나가도 비밀번호를 알아낼 수 없다
 *
 *   로그인에 성공하면 무작위 토큰을 만들어 미니 레디스에 넣고 화면에 돌려준다.
 *     session:<토큰>          로그인 상태          30분 뒤 만료 → 자동 로그아웃
 *     login:fail:<접속 주소>   로그인 실패 횟수      1분 뒤 만료. 5번 틀리면 1분 동안 로그인을 받지 않는다
 *
 *   화면은 단어를 등록할 때 이 토큰을 함께 보내고, 서버는 session:<토큰> 이 살아 있는지 본다.
 * ====================================================================== */

import fs from 'node:fs';
import crypto from 'node:crypto';

const SESSION_TTL = 30 * 60_000;
const FAIL_TTL = 60_000;
const MAX_FAILS = 5;

/** 로그인·권한 오류. status 가 HTTP 상태 코드가 된다 */
export class AuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** 비밀번호 → 저장할 값 { salt, hash } */
export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 32).toString('hex') };
}

/** 계정 파일에 넣을 내용을 만든다. 아이디·비밀번호가 규칙에 맞지 않으면 예외 */
export function makeAccount(id, password) {
  if (!/^[A-Za-z0-9_-]{3,20}$/.test(String(id))) throw new AuthError(400, '아이디는 영문·숫자·_·- 3~20자로 정하세요');
  if (String(password).length < 8) throw new AuthError(400, '비밀번호는 8자 이상으로 정하세요');
  return { id: String(id), ...hashPassword(password) };
}

/** 두 문자열이 같은지, 걸리는 시간이 내용에 따라 달라지지 않게 비교한다 */
function sameText(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/**
 * redis     : 미니 레디스 클라이언트
 * adminFile : 계정 파일 경로 (로그인할 때마다 읽으므로, 계정을 바꿔도 서버를 다시 켤 필요가 없다)
 */
export function createAuth({ redis, adminFile }) {
  function account() {
    try {
      const data = JSON.parse(fs.readFileSync(adminFile, 'utf8'));
      return data && typeof data.id === 'string' && typeof data.salt === 'string' && typeof data.hash === 'string' ? data : null;
    } catch (e) { return null; }
  }

  return {
    /** 제작자 계정이 만들어져 있는가 */
    configured: () => account() !== null,

    /** 아이디와 비밀번호를 확인하고 토큰을 돌려준다. client: 요청을 보낸 쪽을 구분하는 값 (접속 주소) */
    async login(id, password, client = 'unknown') {
      const admin = account();
      if (!admin) throw new AuthError(503, '제작자 계정이 아직 없습니다. 서버 폴더에서 npm run admin 으로 만드세요');

      const failKey = 'login:fail:' + client;
      if (((await redis.get(failKey)) ?? 0) >= MAX_FAILS) throw new AuthError(429, '로그인을 여러 번 틀렸습니다. 1분 뒤에 다시 시도하세요');

      // 아이디가 틀려도 비밀번호 계산을 똑같이 한다 (응답 시간으로 아이디가 맞았는지 알 수 없게)
      const idOk = sameText(id ?? '', admin.id);
      const passwordOk = sameText(hashPassword(password ?? '', admin.salt).hash, admin.hash);
      if (!idOk || !passwordOk) {
        if ((await redis.incr(failKey)) === 1) await redis.expire(failKey, FAIL_TTL);
        throw new AuthError(401, '아이디 또는 비밀번호가 맞지 않습니다');
      }

      await redis.del(failKey);
      const token = crypto.randomBytes(32).toString('hex');
      await redis.set('session:' + token, { id: admin.id }, { ttl: SESSION_TTL });
      return { token, id: admin.id, expiresInMs: SESSION_TTL };
    },

    /** 토큰이 살아 있는 로그인인가 → { id, remainingMs } | null */
    async session(token) {
      if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
      const value = await redis.get('session:' + token);
      return value === null ? null : { id: value.id, remainingMs: await redis.ttl('session:' + token) };
    },

    /** 로그인하지 않았으면 401 예외 */
    async require(token) {
      const session = await this.session(token);
      if (!session) throw new AuthError(401, '단어 등록은 제작자 로그인 후에 할 수 있습니다');
      return session;
    },

    async logout(token) {
      if (typeof token === 'string' && /^[0-9a-f]{64}$/.test(token)) await redis.del('session:' + token);
      return { ok: true };
    },
  };
}
