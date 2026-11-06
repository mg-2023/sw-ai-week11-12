/**
 * diff.js — 두 Virtual DOM 을 비교해 "바꿀 일 목록(patches)" 을 만든다
 *
 * 입력: oldVnode, newVnode   (둘 다 vdom.js 모양, undefined 도 됨)
 * 출력: patches 배열. 각 항목은 { type, path, ... }
 *
 *   path  = 루트에서 그 노드까지 자식 번호 목록. [] 는 루트, [1, 0] 은 루트의 1번 자식의 0번 자식
 *
 *   CREATE  { path, node }            path 자리에 새 노드를 넣는다
 *   REMOVE  { path }                  path 자리 노드를 뺀다
 *   REPLACE { path, node }            종류(type)가 달라 통째로 바꾼다
 *   TEXT    { path, value }           텍스트 글자만 바꾼다
 *   PROPS   { path, set, remove }     바뀐 속성만 넣고(set) 없어진 속성만 뺀다(remove)
 *
 * 규칙: 자식은 같은 번호끼리 비교한다 (결정 4 — 번호로 걷기).
 *   - 새 쪽이 길면 뒤에 CREATE, 옛 쪽이 길면 뒤에서부터 REMOVE
 *   - REMOVE 를 뒤 번호부터 내보내므로, 목록 순서대로 적용해도 앞 번호가 밀리지 않는다
 *   - 한계: 목록 맨 앞에 하나를 넣으면 뒤가 모두 한 칸씩 "바뀜" 으로 나온다 (key 비교는 안 함)
 */
(function (root) {
  'use strict';

  const TEXT = '#text';

  function diff(oldVnode, newVnode) {
    const patches = [];
    walk(oldVnode, newVnode, [], patches);
    return patches;
  }

  function walk(oldV, newV, path, patches) {
    // 1) 한쪽이 없다
    if (oldV === undefined || oldV === null) {
      if (newV !== undefined && newV !== null) patches.push({ type: 'CREATE', path, node: newV });
      return;
    }
    if (newV === undefined || newV === null) {
      patches.push({ type: 'REMOVE', path });
      return;
    }

    // 2) 종류가 다르다 → 통째로 교체 (div → p, 텍스트 → 요소 …). 아래는 더 볼 필요 없다
    if (oldV.type !== newV.type) {
      patches.push({ type: 'REPLACE', path, node: newV });
      return;
    }

    // 3) 둘 다 텍스트 → 글자만 비교
    if (newV.type === TEXT) {
      if (oldV.props.nodeValue !== newV.props.nodeValue) {
        patches.push({ type: 'TEXT', path, value: newV.props.nodeValue });
      }
      return;
    }

    // 4) 같은 요소 → 속성 비교, 그다음 자식 비교
    const propPatch = diffProps(oldV.props, newV.props);
    if (propPatch) patches.push({ type: 'PROPS', path, ...propPatch });

    const oldKids = oldV.children;
    const newKids = newV.children;
    const common = Math.min(oldKids.length, newKids.length);

    // 같은 번호끼리 (앞쪽 공통 구간)
    for (let i = 0; i < common; i++) {
      walk(oldKids[i], newKids[i], path.concat(i), patches);
    }
    // 새로 생긴 뒤쪽 자식: 앞 번호부터 넣는다
    for (let i = common; i < newKids.length; i++) {
      patches.push({ type: 'CREATE', path: path.concat(i), node: newKids[i] });
    }
    // 없어진 뒤쪽 자식: 뒤 번호부터 뺀다 (앞에서부터 빼면 번호가 밀린다)
    for (let i = oldKids.length - 1; i >= common; i--) {
      patches.push({ type: 'REMOVE', path: path.concat(i) });
    }
  }

  /**
   * 속성 비교. 바뀐 게 없으면 null.
   *   set    : 새로 생겼거나 값이 바뀐 속성 { 이름: 새 값 }
   *   remove : 없어진 속성 이름 목록
   * 값은 === 로 비교한다. 함수(이벤트)는 같은 함수일 때만 같다.
   */
  function diffProps(oldProps, newProps) {
    const set = {};
    const remove = [];
    for (const name of Object.keys(newProps)) {
      if (!Object.prototype.hasOwnProperty.call(oldProps, name) || oldProps[name] !== newProps[name]) {
        set[name] = newProps[name];
      }
    }
    for (const name of Object.keys(oldProps)) {
      if (!Object.prototype.hasOwnProperty.call(newProps, name)) remove.push(name);
    }
    if (Object.keys(set).length === 0 && remove.length === 0) return null;
    return { set, remove };
  }

  const api = { diff, diffProps };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MiniReact = Object.assign(root.MiniReact || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
