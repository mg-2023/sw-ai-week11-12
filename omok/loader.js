/* 주소의 ?engine= 값으로 엔진 버전 폴더를 골라 엔진 → 오목 → 패널 순서로 스크립트를 붙이는 로더 */
(function (root) {
  'use strict';

  const ENGINES = {
    src: { base: 'src/', label: '현재 작업본 (src)' },
    'v1-batch': { base: 'engines/v1-batch/', label: 'v1 이벤트 경계 배칭 (고정본)' },
    v0: { base: 'engines/v0/', label: 'v0 배칭 없음 (고정본)' },
  };
  const ENGINE_FILES = ['vdom', 'diff', 'patch', 'hooks', 'component'];
  const APP_FILES = ['omok/game.js', 'omok/panel.js'];

  const asked = new URLSearchParams(root.location.search).get('engine');
  const key = Object.prototype.hasOwnProperty.call(ENGINES, asked) ? asked : 'src';
  root.ENGINE_INFO = { key, engines: ENGINES };

  /* 스크립트 하나를 붙이는 함수 (async=false 라 붙인 순서대로 실행된다) */
  function add(src) {
    const s = root.document.createElement('script');
    s.src = src;
    s.async = false;
    root.document.body.appendChild(s);
  }

  for (const f of ENGINE_FILES) add(ENGINES[key].base + f + '.js');
  for (const f of APP_FILES) add(f);
})(globalThis);
