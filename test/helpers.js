// 테스트 공용: jsdom 으로 브라우저 DOM 을 흉내 낸다
const { JSDOM } = require('jsdom');

/** 새 문서를 만들고, body 안에 html 을 넣은 상자(#root)를 돌려준다 */
function setup(html = '') {
  const dom = new JSDOM(`<!DOCTYPE html><body><div id="root">${html}</div></body>`);
  const document = dom.window.document;
  return { window: dom.window, document, rootEl: document.getElementById('root') };
}

module.exports = { setup };
