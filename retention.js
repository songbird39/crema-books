// 새로 받은 목록에 없는 책을 언제 지울지 (크레마·구립도서관·서울도서관 공통)
//  - 끝까지 다 받지 못했으면(실패한 페이지 등) 지우지 않고 이전 책을 남김
//  - 다 받았는데 권수가 이전보다 MAX_DROP 넘게 줄었으면 사이트 이상으로 보고 지우지 않음 (경고)
//  - 다 받았을 때 연속 MISS_LIMIT번 안 보인 책만 지움 (사이트가 하루 이상하게 응답해도 안 사라지게)
const MAX_DROP = 0.05;
const MISS_LIMIT = 2;
const SAMPLE = 50; // 관리자 화면에서 링크로 직접 확인할 수 있게 [id, 제목]을 남기는 개수

// prev, next: 책 배열 / idOf: 책 → ID / titleOf: 예시 표시용 / prevMissing: { id: 연속으로 안 보인 횟수 }
// → { items, missing, changes }
function reconcile(prev = [], next = [], { idOf, titleOf, complete, prevMissing = {} }) {
  const nextIds = new Set(next.map(idOf));
  const prevIds = new Set(prev.map(idOf));
  const added = next.filter(b => !prevIds.has(idOf(b)));
  const gone = prev.filter(b => !nextIds.has(idOf(b)));
  const changes = { at: new Date().toISOString(), prev: prev.length, received: next.length, added: added.length, removed: 0, kept: 0, warning: null,
    addedSample: added.slice(0, SAMPLE).map(b => [idOf(b), titleOf(b)]), removedSample: [], keptSample: [] };
  const missing = {};
  let keep = gone;
  if (!complete) changes.warning = 'incomplete';
  else if (prev.length && next.length < prev.length * (1 - MAX_DROP)) changes.warning = 'drop';
  if (changes.warning) {
    for (const b of gone) { const id = idOf(b); if (prevMissing[id]) missing[id] = prevMissing[id]; } // 세지 않고 그대로
  } else {
    keep = [];
    const removed = [];
    for (const b of gone) {
      const id = idOf(b), n = (prevMissing[id] || 0) + 1;
      if (n >= MISS_LIMIT) removed.push(b); else { missing[id] = n; keep.push(b); }
    }
    changes.removed = removed.length;
    changes.removedSample = removed.slice(0, SAMPLE).map(b => [idOf(b), titleOf(b)]);
  }
  changes.kept = keep.length; // 이번에 안 보였지만 남겨 둔 책
  changes.keptSample = keep.slice(0, SAMPLE).map(b => [idOf(b), titleOf(b)]);
  return { items: [...next, ...keep], missing, changes };
}

module.exports = { reconcile, MAX_DROP, MISS_LIMIT };
