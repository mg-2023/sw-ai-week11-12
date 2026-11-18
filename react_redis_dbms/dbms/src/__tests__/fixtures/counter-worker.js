/* 잠금 테스트용 워커: 쓰기 잠금을 잡고 공유 카운터를 "읽고 → 더해서 → 쓰는" 일을 times 번 한다 */
import { workerData } from 'node:worker_threads';
import { createRwLock } from '../../rw-lock.js';

const lock = createRwLock(workerData.lockBuffer, 0);
const counter = new Int32Array(workerData.counterBuffer);
for (let i = 0; i < workerData.times; i++) {
  if (workerData.useLock) lock.lockWrite();
  const value = counter[0];                    // 일부러 Atomics 를 쓰지 않는다: 잠금이 없으면 여기서 값이 꼬인다
  for (let spin = 0; spin < 50; spin++);       // 읽기와 쓰기 사이를 조금 벌린다
  counter[0] = value + 1;
  if (workerData.useLock) lock.unlockWrite();
}
