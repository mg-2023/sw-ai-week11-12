/* 두 Virtual DOM 을 비교해 경로 달린 patch 목록을 만드는 모듈 */
(function (root) {
  'use strict';

  const TEXT = '#text';

  /* 이전 · 새 Virtual DOM 을 비교해 patch 목록을 돌려주는 함수 */
  function diff(oldVnode, newVnode, stats) {
    const patches = [];
    walk(oldVnode, newVnode, [], patches, stats);
    return patches;
  }

  /* 두 노드를 같은 번호끼리 재귀로 비교하며 patch 를 쌓는 함수 */
  function walk(oldV, newV, path, patches, stats) {
    if (stats) stats.compared += 1;
    if (oldV === undefined || oldV === null) {
      if (newV !== undefined && newV !== null) patches.push({ type: 'CREATE', path, node: newV });
      return;
    }
    if (newV === undefined || newV === null) {
      patches.push({ type: 'REMOVE', path });
      return;
    }

    if (oldV.type !== newV.type) {
      patches.push({ type: 'REPLACE', path, node: newV });
      return;
    }

    if (newV.type === TEXT) {
      if (oldV.props.nodeValue !== newV.props.nodeValue) {
        patches.push({ type: 'TEXT', path, value: newV.props.nodeValue });
      }
      return;
    }

    const propPatch = diffProps(oldV.props, newV.props);
    if (propPatch) patches.push({ type: 'PROPS', path, ...propPatch });
    if (propPatch && stats && isEventOnly(propPatch)) stats.eventOnly += 1;
    const beforeKids = patches.length;

    const oldKids = oldV.children;
    const newKids = newV.children;
    const common = Math.min(oldKids.length, newKids.length);

    for (let i = 0; i < common; i++) {
      walk(oldKids[i], newKids[i], path.concat(i), patches, stats);
    }
    for (let i = common; i < newKids.length; i++) {
      patches.push({ type: 'CREATE', path: path.concat(i), node: newKids[i] });
    }
    for (let i = oldKids.length - 1; i >= common; i--) {
      patches.push({ type: 'REMOVE', path: path.concat(i) });
    }

    if (newV.type === 'select' && has(newV.props, 'value')) {
      const kidsChanged = patches.length > beforeKids;
      const valueChanged = propPatch !== null && has(propPatch.set, 'value');
      if (valueChanged) {
        delete propPatch.set.value;
        if (Object.keys(propPatch.set).length === 0 && propPatch.remove.length === 0) {
          patches.splice(beforeKids - 1, 1);
        }
      }
      if (valueChanged || kidsChanged) {
        patches.push({ type: 'PROPS', path, set: { value: newV.props.value }, remove: [] });
      }
    }
  }

  /* PROPS patch 가 이벤트 핸들러 교체만 담았는지 확인하는 함수 */
  function isEventOnly(propPatch) {
    const setOk = Object.keys(propPatch.set).every((k) => /^on/i.test(k) && typeof propPatch.set[k] === 'function');
    return setOk && propPatch.remove.every((k) => /^on/i.test(k));
  }

  /* 객체가 그 이름의 칸을 직접 가졌는지 확인하는 함수 */
  function has(obj, name) {
    return Object.prototype.hasOwnProperty.call(obj, name);
  }

  /* 이름이 __proto__ 여도 진짜 칸으로 값을 넣는 함수 */
  function put(obj, name, value) {
    Object.defineProperty(obj, name, { value, enumerable: true, writable: true, configurable: true });
  }

  /* 두 props 를 비교해 바뀐 속성(set) · 없어진 속성(remove)을 돌려주는 함수 */
  function diffProps(oldProps, newProps) {
    const set = {};
    const remove = [];
    for (const name of Object.keys(newProps)) {
      if (!has(oldProps, name) || oldProps[name] !== newProps[name]) {
        put(set, name, newProps[name]);
      }
    }
    for (const name of Object.keys(oldProps)) {
      if (!has(newProps, name)) remove.push(name);
    }
    if (Object.keys(set).length === 0 && remove.length === 0) return null;
    return { set, remove };
  }

  const api = { diff, diffProps };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MiniReact = Object.assign(root.MiniReact || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
