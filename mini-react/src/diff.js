/* ======================================================================
 * diff.js — 두 VDOM 을 비교해 Patch 목록을 만든다 (DOM 을 건드리지 않는 순수 함수)
 *
 *   Patch : CREATE | REMOVE | REPLACE | TEXT | PROPS
 *   path  : 컨테이너의 childNodes 를 따라 내려가는 인덱스 배열
 *
 *   key 없이 "같은 위치끼리" 비교한다.
 * ====================================================================== */

export function diffProps(oldProps, newProps) {
  const changes = [];
  for (const name of new Set([...Object.keys(oldProps), ...Object.keys(newProps)])) {
    if (oldProps[name] !== newProps[name]) changes.push({ name, oldValue: oldProps[name], newValue: newProps[name] });
  }
  return changes;
}

export function diff(oldV, newV, path = [], patches = []) {
  if (oldV === undefined && newV === undefined) return patches;
  if (oldV === undefined) { patches.push({ type: 'CREATE', path, vnode: newV }); return patches; }   // 추가
  if (newV === undefined) { patches.push({ type: 'REMOVE', path }); return patches; }                // 삭제
  if (typeof oldV === 'string' && typeof newV === 'string') {                                       // 텍스트 변경
    if (oldV !== newV) patches.push({ type: 'TEXT', path, text: newV });
    return patches;
  }
  if (typeof oldV === 'string' || typeof newV === 'string' || oldV.type !== newV.type || oldV.ns !== newV.ns) {  // 타입(네임스페이스 포함)이 다르면 통째로 교체
    patches.push({ type: 'REPLACE', path, vnode: newV });
    return patches;
  }
  const changes = diffProps(oldV.props, newV.props);                                                // 같은 타입: 속성 비교
  if (changes.length) patches.push({ type: 'PROPS', path, changes });

  const oldKids = oldV.children, newKids = newV.children;
  const common = Math.min(oldKids.length, newKids.length);
  for (let i = 0; i < common; i++) diff(oldKids[i], newKids[i], [...path, i], patches);             // 자식 재귀
  for (let i = common; i < newKids.length; i++) patches.push({ type: 'CREATE', path: [...path, i], vnode: newKids[i] }); // 앞에서부터 추가
  for (let i = oldKids.length - 1; i >= common; i--) patches.push({ type: 'REMOVE', path: [...path, i] });             // 뒤에서부터 삭제
  return patches;
}
