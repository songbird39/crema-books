// 제목·저자 매칭 (서버와 브라우저가 같이 씀)
(function (root) {
// ─── Title matching ───
// 책이 16만 권이라 부분 문자열 전수 비교는 너무 느리고 짧은 제목에서 오매칭도 많다.
// 정규화한 전체 제목 → 부제를 뗀 기본 제목 순으로 해시 조회한다.
function normTitle(t) {
  return (t || '').replace(/\s/g, '').toLowerCase();
}
// 판본 차이를 무시한 '같은 작품' 키: 초판본·확장판·개정판·○○ 에디션·리커버·양장·큰글자책 등을 떼고
// 공백·문장부호를 없앤 제목. 권 표시((상)·(1)·2부)는 다른 책이므로 남긴다.
const EDITION_WORDS = '초판본|초판|확장판|한글판|영문판|국문판|개정\\s*증보판|개정판|증보판|특별판|한정판|완전판|합본|무삭제판|리커버|양장본|양장|큰\\s*글[자씨]책?|보급판|기념판|에디션|edition|recover';
const EDITION_PAREN_RE = new RegExp(`[(\\[{<][^)\\]}>]*(${EDITION_WORDS}|주년)[^)\\]}>]*[)\\]}>]`, 'gi');
const EDITION_RE = new RegExp(`(?<=^|[\\s\\p{P}])(출간\\s*)?(\\d+\\s*주년\\s*)?(기념\\s*)?(${EDITION_WORDS})(?=$|[\\s\\p{P}])`, 'giu'); // 단어 단위로만 (양장피 ≠ 양장)
const EDITION_NAMED_RE = /[가-힣a-z]+\s+(에디션|edition)/gi; // '블랙 에디션'처럼 이름 붙은 에디션
const LEADING_TAG_RE = /^\s*[\[【][^\]】]*[\]】]\s*/; // [단독] [eBook] 같은 앞머리 표시
// '스토너 - 존 윌리엄스 장편소설', '데미안 - 열린책들 세계문학 227', '데미안 - 에디터스 컬렉션' 같은 시리즈·장르 부제
const GENRE_SUBTITLE_RE = /\s+[-:]\s+[^-:]*(장편\s*소설|소설|에세이|산문집|시집|세계\s*문학|문학\s*전집|전집|컬렉션|클래식|시리즈|총서)[^-:]*$/;
function workKey(t) {
  const k = (t || '').toLowerCase().replace(LEADING_TAG_RE, '').replace(GENRE_SUBTITLE_RE, '').replace(EDITION_PAREN_RE, ' ').replace(EDITION_NAMED_RE, ' ').replace(EDITION_RE, ' ').replace(/[\s\p{P}\p{S}]/gu, '');
  return k || (t || '').replace(/\s/g, '').toLowerCase();
}
function baseTitle(t) {
  return normTitle((t || '').split(/\s*[:(\[]|\s+-\s+/)[0]);
}
// 저자 칸 → 이름들 ('핼리 루벤홀드 저/이저리 역' → ['핼리루벤홀드', '이저리'])
function authorNames(a) {
  // 괄호 안도 이름으로 ('김동주(김단테)' = '김단테(김동주)')
  return (a || '').replace(/[<>]/g, '').replace(/^\s*(지은이|저자|글|지음)\s*[:：]\s*/, '').replace(/[()[\]]/g, '/')
    .split(/[,/·;]|\s+외(?:\s|\d|$)|\s+등(?:\s|$)/)
    .map(x => x.replace(/(\s*(공저|편저|편역|번역|저|지음|글|그림|역|옮김|엮음|편|기획|원작|감수|해설|공|외\s*\d*명?))+\s*$/, '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase())
    .filter(x => x.length >= 2 && !/^(지은이|옮긴이|엮은이|그린이|저자|역자|편집부|공저|편저|원작|감수)$/.test(x));
}
// 같은 사람인지: 이름이 같거나 한쪽이 다른 쪽을 품거나, 표기만 조금 다름 ('핼리 루벤홀드' = '헬리 루벤홀드': 두 글자 조각이 절반 넘게 겹침)
function sameName(x, y) {
  if (x === y || (Math.min(x.length, y.length) >= 3 && (x.includes(y) || y.includes(x)))) return true;
  // 성이 뒤에 오는 서양 이름: 끝 세 글자 이상이 같으면 ('R. L. 스티븐슨' = '로버트 루이스 스티븐슨')
  if (/[가-힣]{3}$/.test(x) && x.length >= 5 && y.length >= 5 && x.slice(-3) === y.slice(-3) && /[a-z가-힣]{2,}[가-힣]{3,}$/.test(x)) return true;
  const bi = (t) => { const o = new Set(); for (let i = 0; i < t.length - 1; i++) o.add(t.slice(i, i + 2)); return o; };
  const a = bi(x), b = bi(y);
  let n = 0; for (const g of a) if (b.has(g)) n++;
  return a.size + b.size > 0 && 2 * n / (a.size + b.size) >= 0.5;
}
// 한글 이름의 자음 뼈대: 모음·된소리·거센소리 차이를 무시 ('도스또예프스끼' = '도스토옙스키' = dsdbsg)
const SK_INI = ['g', 'g', 'n', 'd', 'd', 'r', 'm', 'b', 'b', 's', 's', '', 'j', 'j', 'j', 'g', 'd', 'b', 'h'];
const SK_FIN = ['', 'g', 'g', 'g', 'n', 'n', 'n', 'd', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'm', 'b', 'b', 's', 's', 'N', 'd', 'd', 'g', 'd', 'b', 'd'];
function nameSkeleton(t) {
  let o = '';
  for (const ch of t) { const c = ch.charCodeAt(0) - 0xAC00; if (c >= 0 && c < 11172) o += SK_INI[Math.floor(c / 588)] + SK_FIN[c % 28]; }
  return o;
}
const diceBigram = (x, y) => {
  const bi = (t) => { const o = new Set(); for (let i = 0; i < t.length - 1; i++) o.add(t.slice(i, i + 2)); return o; };
  const a = bi(x), b = bi(y); let n = 0; for (const g of a) if (b.has(g)) n++;
  return a.size + b.size ? 2 * n / (a.size + b.size) : 0;
};
// 외국 이름 번역 표기 차이: 한글 네 글자 이상끼리는 자음 뼈대가 거의 같으면 같은 사람
function sameForeignName(x, y) {
  const hx = x.replace(/[^가-힣]/g, ''), hy = y.replace(/[^가-힣]/g, '');
  if (hx.length < 4 || hy.length < 4) return false;
  const sx = nameSkeleton(hx), sy = nameSkeleton(hy);
  if (sx === sy) return true;
  // 성(끝부분) 뼈대가 같거나 ('데이비드 허버트 로렌스' = 'D. H. 로런스'), 전체가 많이 겹침
  return (sx.length >= 4 && sy.length >= 4 && sx.slice(-4) === sy.slice(-4)) || diceBigram(sx, sy) >= 0.7;
}
const HANGUL_RE = /[가-힣]/;
// 저자가 서로 맞는지 (어느 한쪽 저자를 모르거나, 한쪽은 로마자·한쪽은 한글이라 비교할 수 없으면 맞는 걸로)
// 놓치는 것(같은 책인데 못 묶음)이 잘못 묶는 것보다 나빠서 너그럽게
function authorsMatch(a, b) {
  const x = authorNames(a), y = authorNames(b);
  if (!x.length || !y.length) return true;
  if (!x.some(n => HANGUL_RE.test(n)) !== !y.some(n => HANGUL_RE.test(n))) return true;
  return x.some(p => y.some(q => sameName(p, q) || sameForeignName(p, q)));
}
// 제목 색인. 찾을 때 저자를 주면 같은 제목 책들 중 저자가 맞는 것만 (제목만 같은 다른 책: '더 파이브' 루벤홀드 ≠ 김한송 외)
function buildTitleIndex(books) {
  const byNorm = new Map();
  const byWork = new Map();
  const byBase = new Map();
  const push = (m, k, b) => { const a = m.get(k); if (a) a.push(b); else m.set(k, [b]); };
  for (const b of books) {
    const n = normTitle(b.title);
    if (n) push(byNorm, n, b);
    const w = workKey(b.title);
    if (w) push(byWork, w, b);
    const base = baseTitle(b.title);
    if (base.length > 4) push(byBase, base, b);
  }
  const pick = (arr, author) => !arr ? null : author === undefined ? arr[0] : arr.find(b => authorsMatch(author, b.author)) || null;
  return (title, author) => {
    const n = normTitle(title);
    const r1 = pick(byNorm.get(n), author);
    if (r1) return r1;
    const w = workKey(title);
    const r2 = pick(byWork.get(w), author); // 판본만 다른 같은 책
    if (r2) return r2;
    const base = baseTitle(title);
    if (base.length <= 4) return null;
    return pick(byNorm.get(base), author) || pick(byBase.get(base), author) || null;
  };
}


// 저자 비교용 키: 첫 저자 이름 앞 2글자
// 사이트마다 "알랭 드 보통외 3명", "<황보름> 저", "지은이: 황보름", "시니맘(박지혜) 저", "신해"(잘림) 처럼 표기가 다름
function authorKey(a) {
  let s = (a || '').replace(/\([^)]*\)|[<>]/g, '').replace(/^\s*(지은이|저자|글|지음)\s*[:：]\s*/, '');
  s = s.split(/[,/·;:]|\s+외|외\s*\d|\s+등/)[0];
  s = s.replace(/\s*(공저|편저|저|지음|글|그림|역|옮김|엮음|편)\s*$/, ''); // 한글엔 \b가 안 먹어서 끝 단어로 제거
  return s.replace(/[^가-힣a-zA-Z]/g, '').toLowerCase().slice(0, 2);
}


const api = { normTitle, workKey, baseTitle, authorNames, sameName, sameForeignName, authorsMatch, buildTitleIndex, authorKey, HANGUL_RE };
if (typeof module === "object" && module.exports) module.exports = api; else root.Match = api;
})(typeof self !== "undefined" ? self : this);
