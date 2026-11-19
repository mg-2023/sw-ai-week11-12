/* 테스트 공통 도구: 임시 데이터 폴더 만들기 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SCHEMA = {
  users: { id: 'int', name: 'text', age: 'int', city: 'text' },
  products: { id: 'int', name: 'text', price: 'float', stock: 'int' },
};

/** schema.json 이 든 임시 폴더를 만든다 */
export function makeDataDir(schema = SCHEMA) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-dbms-'));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(schema));
  return dir;
}

export const removeDir = (dir) => fs.rmSync(dir, { recursive: true, force: true });
