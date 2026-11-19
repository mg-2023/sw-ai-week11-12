/* ======================================================================
 * room.js — 같은 와이파이의 사람들과 같이 하도록 끝말잇기를 켠다 (npm run room)
 *
 *   server.js 와 같지만 게임 서버(3000)만 0.0.0.0 으로 열어, 같은 와이파이의 다른 PC · 폰이 접속할 수 있게 한다.
 *   미니 레디스(6380) · 미니 DBMS(4000)는 그대로 이 PC 안(127.0.0.1)에서만 열린다.
 *   접속한 사람들은 "같이 하기" 탭에서 방을 만들거나 들어간다 (최대 4명).
 *   처음 켤 때 Windows 방화벽 창이 뜨면 허용한다. 같은 와이파이의 누구나 접속할 수 있다.
 * ====================================================================== */

import os from 'node:os';

process.env.HOST = '0.0.0.0';
await import('./server.js');

// 어댑터 이름을 함께 보여 준다: 'Wi-Fi' · '이더넷' 쪽 주소를 쓰고, 'vEthernet (WSL)' 같은 가상 어댑터 주소는 다른 기기에서 열리지 않는다
const port = Number(process.env.PORT || 3000);
const addresses = Object.entries(os.networkInterfaces())
  .flatMap(([name, list]) => (list || []).filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => 'http://' + a.address + ':' + port + '   (' + name + (/vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback/i.test(name) ? ' — 가상 어댑터, 다른 기기에서는 안 열림' : '') + ')'));
console.log('\n같이 할 사람에게 알려 줄 주소 (같은 와이파이):');
for (const url of addresses) console.log('  ' + url);
if (addresses.length === 0) console.log('  네트워크 주소를 찾지 못했습니다. 와이파이 연결을 확인하세요.');
