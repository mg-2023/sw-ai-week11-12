/* ======================================================================
 * set-admin.js — 제작자 계정을 만든다 (npm run admin)
 *
 *   아이디와 비밀번호를 물어본 뒤 admin.json 에 저장한다. 비밀번호는 해시로 바꿔 저장한다.
 *   다시 실행하면 계정을 바꾼다. 서버를 다시 켤 필요는 없다.
 *   admin.json 은 .gitignore 에 들어 있어 저장소에 올라가지 않는다.
 * ====================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { makeAccount } from './auth.js';

export const ADMIN_FILE = path.join(fileURLToPath(new URL('..', import.meta.url)), 'admin.json');

/** 한 줄을 입력받는다. hidden 이면 입력한 글자를 화면에 보이지 않게 한다 */
function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) rl._writeToOutput = (text) => { if (text.includes(question)) process.stdout.write(question); };
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer); });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const id = (await ask('아이디 (영문·숫자 3~20자): ')).trim();
  const password = await ask('비밀번호 (8자 이상, 입력한 글자는 보이지 않습니다): ', true);
  const again = await ask('비밀번호 한 번 더: ', true);
  if (password !== again) { console.error('두 비밀번호가 다릅니다. 다시 실행하세요'); process.exit(1); }
  try {
    fs.writeFileSync(ADMIN_FILE, JSON.stringify(makeAccount(id, password), null, 2) + '\n');
    console.log("제작자 계정 '" + id + "' 을(를) 저장했습니다: " + ADMIN_FILE);
  } catch (err) { console.error(err.message); process.exit(1); }
}
