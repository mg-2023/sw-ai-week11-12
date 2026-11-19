/* ======================================================================
 * cache.js — 미니 레디스를 캐시로 쓰는 방법 (Cache-Aside)
 *
 *   getOrLoad(key, loader)
 *     ① 캐시에서 key 를 찾는다                      → 있으면 그대로 돌려준다 (HIT)
 *     ② 없으면 loader() 로 원본(DB 등)에서 가져온다  (MISS)
 *     ③ 가져온 값을 ttl 과 함께 캐시에 넣고 돌려준다
 *
 *   같은 키를 여러 요청이 동시에 놓쳤을 때: 원본 조회를 요청 수만큼 하지 않고, 먼저 시작한 조회 하나를 함께 기다린다.
 *   캐시 서버가 죽었을 때: 캐시 오류는 삼키고 원본에서 가져온다 (캐시는 없어도 동작해야 하는 보조 수단이다).
 *
 *   redis 는 client.js 의 클라이언트나 store.js 의 저장소 어느 쪽이든 된다 (get / set / del 만 쓴다).
 * ====================================================================== */

export function createCache(redis, { ttl = 60_000 } = {}) {
  const loading = new Map();           // 지금 원본에서 가져오는 중인 key → Promise
  const stats = { hits: 0, misses: 0, errors: 0 };

  /** 캐시 명령을 실행하되, 실패하면 fallback 을 돌려준다 */
  async function safely(run, fallback) {
    try { return await run(); } catch (err) { stats.errors++; return fallback; }
  }

  return {
    stats,

    /** 캐시에 있으면 그 값을, 없으면 loader() 의 결과를 캐시에 넣고 돌려준다. 반환: { value, hit } */
    async getOrLoad(key, loader) {
      const cached = await safely(() => redis.get(key), null);
      if (cached !== null) { stats.hits++; return { value: cached, hit: true }; }
      stats.misses++;

      if (!loading.has(key)) {
        const job = (async () => {
          const value = await loader();
          if (value !== null && value !== undefined) await safely(() => redis.set(key, value, { ttl }), false);
          return value;
        })().finally(() => loading.delete(key));
        loading.set(key, job);
      }
      return { value: await loading.get(key), hit: false };
    },

    /** 원본이 바뀌었을 때: 캐시의 값을 지워 다음 조회가 원본을 다시 읽게 한다 (무효화) */
    async invalidate(key) {
      return safely(() => redis.del(key), 0);
    },
  };
}
