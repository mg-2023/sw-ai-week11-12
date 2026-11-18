/* ======================================================================
 * aof.js — 영속성: AOF (Append Only File, 명령 기록 파일)
 *
 *   데이터는 메모리에만 있으므로 서버가 꺼지면 사라진다. 그래서 데이터를 바꾼 명령을 한 줄씩 파일 끝에 이어 쓴다.
 *     {"op":"set","key":"a","value":1,"expireAt":null}
 *     {"op":"del","key":"a"}
 *   서버를 다시 켜면 파일을 처음부터 읽어 같은 명령을 순서대로 다시 실행한다 → 꺼지기 직전 상태가 된다.
 *
 *   만료는 "몇 초 뒤"가 아니라 "만료 시각"으로 적는다. 꺼져 있던 시간만큼 보관 기간이 늘어나지 않게 하기 위해서다.
 *
 *   fsync 정책 (운영체제 버퍼에 있는 내용을 디스크에 실제로 쓰게 하는 시점)
 *     'always'   : 명령마다. 가장 안전하고 가장 느리다
 *     'everysec' : 1초마다. 서버가 죽어도 최대 1초 분량만 잃는다 (기본값, Redis 의 기본값과 같다)
 *     'no'       : 운영체제에 맡긴다
 *
 *   파일 줄이기 (rewrite)
 *     같은 키를 여러 번 바꾸면 파일만 길어진다. 지금 살아 있는 데이터만 set 기록으로 새 파일에 쓰고
 *     이름을 바꿔 원래 파일을 대신한다. 새 파일을 다 쓴 뒤에 바꾸므로 도중에 꺼져도 원래 파일은 남는다.
 * ====================================================================== */

import fs from 'node:fs';
import { createStore } from './store.js';

/**
 * 기록 파일을 읽어 기록 배열로 돌려준다. 파일이 없으면 빈 배열.
 * 쓰는 도중에 서버가 죽으면 마지막 줄이 잘려 있을 수 있다 → 해석되지 않는 줄을 만나면 거기서 멈춘다 (broken: true).
 */
export function readRecords(path) {
  if (!fs.existsSync(path)) return { records: [], broken: false };
  const records = [];
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    if (line === '') continue;
    try { records.push(JSON.parse(line)); } catch (e) { return { records, broken: true }; }
  }
  return { records, broken: false };
}

/** 기록 파일을 이어 쓰기로 연다 */
export function openAof(path, { fsync = 'everysec' } = {}) {
  let fd = fs.openSync(path, 'a');
  let dirty = false;                   // 마지막 fsync 뒤에 쓴 것이 있는가
  const flush = () => { if (dirty && fd !== null) { fs.fsyncSync(fd); dirty = false; } };
  const timer = fsync === 'everysec' ? setInterval(flush, 1000) : null;
  if (timer) timer.unref();

  return {
    /** 기록 한 줄을 파일 끝에 쓴다 */
    append(record) {
      fs.writeSync(fd, JSON.stringify(record) + '\n');
      if (fsync === 'always') fs.fsyncSync(fd); else dirty = true;
    },

    /** 파일을 records 만 담은 새 파일로 바꾼다 */
    rewrite(records) {
      const temp = path + '.tmp';
      const tempFd = fs.openSync(temp, 'w');
      fs.writeSync(tempFd, records.map((r) => JSON.stringify(r) + '\n').join(''));
      fs.fsyncSync(tempFd);
      fs.closeSync(tempFd);
      fs.closeSync(fd);                // Windows 는 열려 있는 파일을 바꿔치기할 수 없다
      fs.renameSync(temp, path);
      fd = fs.openSync(path, 'a');
      dirty = false;
    },

    flush,

    close() {
      if (fd === null) return;
      if (timer) clearInterval(timer);
      flush();
      fs.closeSync(fd);
      fd = null;
    },
  };
}

/**
 * 파일에 기록을 남기는 저장소를 연다.
 *   ① 기록 파일을 읽어 다시 실행 (복구)   ② 살아 있는 데이터만 남겨 파일을 줄임   ③ 이후의 쓰기 명령을 파일에 이어 씀
 * 반환: { store, recovered: 복구한 키 수, broken: 잘린 줄이 있었는가, compact(), close() }
 */
export function openPersistentStore(path, { fsync = 'everysec', now = Date.now } = {}) {
  const { records, broken } = readRecords(path);
  let aof = null;
  const store = createStore({ now, onWrite: (record) => { if (aof) aof.append(record); } });
  for (const record of records) store.apply(record);          // 복구 중에는 aof 가 null 이라 다시 기록되지 않는다

  aof = openAof(path, { fsync });
  const compact = () => aof.rewrite(store.snapshot());
  if (records.length > 0) compact();

  return { store, recovered: store.size, broken, compact, close: () => aof.close() };
}
