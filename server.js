const express = require('express');
const compression = require('compression');
const { parse } = require('node-html-parser');
const { LIBRARIES, crawlLibrary, detailUrlTemplate } = require('./libraries');
const fs = require('fs');
const path = require('path');

const app = express();
// SSE 스트림은 압축하면 버퍼링되어 진행 메시지가 클라이언트에 전달되지 않음
app.use(compression({
  filter: (req, res) => {
    if ((res.getHeader('Content-Type') || '').toString().includes('text/event-stream')) return false;
    return compression.filter(req, res);
  }
}));
const PORT = process.env.PORT || 3456;
const DATA_FILE = path.join(__dirname, 'data.json');

// Serve static files
app.use(express.static(__dirname));
app.use(express.json());

// Load saved data (always from completed file)
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch { return { books: [], bestsellers: {}, lastSync: null, lastPage: 0 }; }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data));
}
// Fetch with retry
async function fetchText(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(30000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'ko-KR,ko;q=0.9',
        }
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      if (resp.url.includes('/Error/')) throw new Error(`에러 페이지로 리다이렉트됨: ${url}`);
      return await resp.text();
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

// ─── Crema Club Crawl ───
// 인기순(BEST) 정렬은 전체 목록에서 YES24 서버가 15초 안에 응답하지 못하므로 제목순(TITLE)으로 전체를 받는다.
// (사이트 정렬값: BEST/UPDATE/TITLE/ISSDM. 제목순이 요청당 ~3.5초로 가장 빠르고 페이지 크기와 무관하다.)
// 목록 행 수(totalCnt)는 같은 책이 중복 등재된 행을 포함해 고유 권수보다 ~9천 개 많다.
// 1) 전체 목록(dispNo=017001)으로 모든 책 수집 → 2) 장르별 목록으로 장르 라벨 부착
const CREMA_PAGE_SIZE = 2000;
const CREMA_ALL_DISPNO = '017001';

const GENRES = [
  { dispNo: '017001045', name: '소설' },
  { dispNo: '017001050', name: '에세이/시' },
  { dispNo: '017001047', name: '경제/경영' },
  { dispNo: '017001054', name: '자기계발' },
  { dispNo: '017001048', name: '인문' },
  { dispNo: '017001051', name: '사회/정치' },
  { dispNo: '017001052', name: '역사' },
  { dispNo: '017001053', name: '종교' },
  { dispNo: '017001056', name: '예술/대중문화' },
  { dispNo: '017001055', name: '자연과학' },
  { dispNo: '017001042', name: '가정/살림' },
  { dispNo: '017001043', name: '건강/취미/여행' },
  { dispNo: '017001058', name: '어린이/유아' },
  { dispNo: '017001059', name: '청소년' },
  { dispNo: '017001060', name: '국어/외국어' },
  { dispNo: '017001040', name: 'IT/모바일' },
  { dispNo: '017001041', name: '대학교재' },
  { dispNo: '017001061', name: '수험서/자격증' },
  { dispNo: '017001036', name: '잡지' },
  { dispNo: '017001038', name: '만화' },
  { dispNo: '017001046', name: '로맨스' },
  { dispNo: '017001049', name: '판타지/무협' },
  { dispNo: '017001016', name: '무료eBook' },
];

function cremaUrl(dispNo, pageNo) {
  return `https://cremaclub.yes24.com/BookClub/Category?dispNo=${dispNo}&order=TITLE&pageNo=${pageNo}&pageSize=${CREMA_PAGE_SIZE}`;
}

function parseCremaTotal(html) {
  const m = html.match(/totalCnt\s*=\s*parseInt\("(\d+)"\)/);
  return m ? parseInt(m[1]) : null;
}

function parseCremaItems(html) {
  const books = [];
  for (const item of parse(html).querySelectorAll('#yesSchList li')) {
    try {
      // Title & ID
      const nameLink = item.querySelector('.gd_name');
      if (!nameLink) continue;
      const href = nameLink.getAttribute('href') || '';
      const bookId = href.match(/Detail\/(\d+)/)?.[1] || '';
      const title = nameLink.text.trim();
      if (!title || !bookId) continue;

      // Cover
      const imgEl = item.querySelector('img.lazy');
      const cover = imgEl?.getAttribute('data-original') || '';

      // Author
      const authEl = item.querySelector('.info_auth');
      const author = authEl ? authEl.text.replace(/\s*저\s*$/, '').trim() : '';

      // Rating
      let rating = 0;
      const ratingEl = item.querySelector('.rating_grade .yes_b');
      if (ratingEl) rating = parseFloat(ratingEl.text) || 0;

      // Review count
      let reviews = 0;
      const reviewEl = item.querySelector('.txC_blue');
      if (reviewEl) reviews = parseInt(reviewEl.text.replace(/,/g, '')) || 0;

      books.push({ bookId, title, author, cover, rating, reviews });
    } catch (e) {
      continue;
    }
  }
  return books;
}

// 한 목록(dispNo)의 모든 페이지를 순회. onPage(books, pageNo, totalPages) 콜백으로 결과 전달.
// 실패한 페이지는 건너뛰고 번호 목록으로 반환.
async function crawlCremaList(dispNo, onPage) {
  const failed = [];
  let totalPages = null;
  for (let pageNo = 1; totalPages === null || pageNo <= totalPages; pageNo++) {
    if (syncAborted) break;
    let html;
    try {
      html = await fetchText(cremaUrl(dispNo, pageNo));
    } catch (e) {
      console.error(`Crema ${dispNo} p${pageNo} failed:`, e.message);
      failed.push(pageNo);
      if (totalPages === null) break; // 첫 페이지 실패 시 총 페이지 수를 알 수 없음
      continue;
    }
    if (totalPages === null) {
      const total = parseCremaTotal(html) ?? 0;
      totalPages = Math.ceil(total / CREMA_PAGE_SIZE);
      console.log(`Crema ${dispNo}: ${total} books, ${totalPages} pages`);
    }
    const books = parseCremaItems(html);
    onPage(books, pageNo, totalPages);
    if (books.length === 0) break;
    // Polite delay
    await new Promise(r => setTimeout(r, 800));
  }
  return { failed, totalPages: totalPages || 0 };
}

async function crawlCremaClub(onProgress) {
  const bookMap = new Map();

  // 1. 전체 목록
  const all = await crawlCremaList(CREMA_ALL_DISPNO, (books, pageNo, totalPages) => {
    for (const b of books) bookMap.set(b.bookId, b);
    onProgress?.({ status: `크레마클럽 전체 ${pageNo}/${totalPages} 페이지 (${bookMap.size.toLocaleString()}권)`, phase: 'crema', page: pageNo, totalPages });
  });

  // 2. 장르 라벨 (전체 목록에서 빠진 책이 있으면 여기서 보충)
  const genreFailed = [];
  for (let i = 0; i < GENRES.length && !syncAborted; i++) {
    const genre = GENRES[i];
    const r = await crawlCremaList(genre.dispNo, (books, pageNo, totalPages) => {
      for (const b of books) {
        const existing = bookMap.get(b.bookId);
        if (existing) existing.genre ??= genre.name;
        else bookMap.set(b.bookId, { ...b, genre: genre.name });
      }
      onProgress?.({ status: `장르 ${genre.name} ${pageNo}/${totalPages} 페이지 (${i + 1}/${GENRES.length})`, phase: 'genre', page: i + 1, totalPages: GENRES.length });
    });
    if (r.failed.length) genreFailed.push(`${genre.name} p${r.failed.join(',')}`);
  }

  return {
    books: [...bookMap.values()],
    failedPages: all.failed.length,
    // 전체 목록을 끝까지 받았는지 (부분 결과로 기존 데이터를 덮어쓰지 않기 위함)
    complete: !syncAborted && all.failed.length === 0 && all.totalPages > 0,
    genreFailed,
  };
}

// ─── YES24 Bestseller ───
async function crawlYes24Best() {
  const books = [];
  const url = 'https://www.yes24.com/Product/Category/BestSeller?pageNumber=1&pageSize=120';
  const html = await fetchText(url);
  const root = parse(html);

  const items = root.querySelectorAll('.itemUnit');
  let rank = 0;
  for (const item of items) {
    rank++;
    const titleEl = item.querySelector('.gd_name');
    const title = titleEl?.text?.trim() || '';
    const authorEl = item.querySelector('.info_auth a');
    const author = authorEl?.text?.trim() || '';
    // goodsNo from parent or data attribute
    const parent = item.closest('[data-goods-no]') || item.querySelector('[data-goods-no]');
    const goodsNo = parent?.getAttribute('data-goods-no') ||
      (titleEl?.getAttribute('href')?.match(/Goods\/(\d+)/)?.[1]) || '';
    if (title) books.push({ rank, title, author, goodsNo });
  }

  console.log(`YES24: ${books.length} books crawled`);
  return books;
}

// ─── Aladin Bestseller / Steadyseller ───
async function crawlAladin(type = 'Bestseller') {
  const books = [];
  for (let page = 1; page <= 2; page++) {
    const url = `https://www.aladin.co.kr/shop/common/wbest.aspx?BestType=${type}&BranchType=1&CID=0&page=${page}&cnt=50&SortOrder=1`;
    const html = await fetchText(url);
    const root = parse(html);

    // 항목마다 bo3 제목 링크 1개 + 저자 검색 링크 + 출판사 검색 링크
    // (첫 줄은 이벤트 문구라 li 위치로 저자를 잡으면 안 됨)
    let rank = (page - 1) * 50;
    for (const box of root.querySelectorAll('.ss_book_box')) {
      const titleEl = box.querySelector('a.bo3');
      const title = titleEl?.text?.trim() || '';
      if (!title) continue;
      rank++;
      const itemId = (titleEl.getAttribute('href') || '').match(/ItemId=(\d+)/)?.[1] || '';
      const author = box.querySelector('a[href*="AuthorSearch"]')?.text?.trim() || '';
      const publisher = box.querySelector('a[href*="PublisherSearch"], A[href*="PublisherSearch"]')?.text?.trim() || '';
      books.push({ rank, title, author, publisher, itemId });
    }

    await new Promise(r => setTimeout(r, 500));
  }
  return books;
}

const { reconcile } = require('./retention');
const { normTitle, workKey, baseTitle, authorNames, sameName, sameForeignName, authorsMatch, buildTitleIndex, authorKey, HANGUL_RE } = require("./match");

// ─── 베스트셀러 ───
const BEST_SOURCES = { yes24: 'YES24 베스트', aladin_best: '알라딘 베스트', aladin_steady: '알라딘 스테디' };

async function crawlBestsellerLists(onProgress) {
  const lists = {};
  const jobs = [['yes24', crawlYes24Best], ['aladin_best', () => crawlAladin('Bestseller')], ['aladin_steady', () => crawlAladin('Steadyseller')]];
  for (let i = 0; i < jobs.length; i++) {
    const [src, crawl] = jobs[i];
    onProgress?.({ status: `${BEST_SOURCES[src]} 크롤링 중...`, phase: 'bestseller', page: i + 1, totalPages: jobs.length });
    try {
      lists[src] = (await crawl()).map(b => ({
        rank: b.rank, title: b.title, author: b.author, publisher: b.publisher || '',
        link: src === 'yes24' ? (b.goodsNo ? `https://www.yes24.com/Product/Goods/${b.goodsNo}` : '') : (b.itemId ? `https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=${b.itemId}` : ''),
        goodsNo: b.goodsNo || '',
      }));
    } catch (e) {
      console.error(`${src} failed:`, e.message);
      onProgress?.({ status: `${BEST_SOURCES[src]} 실패: ${e.message}`, phase: 'bestseller', page: i + 1, totalPages: jobs.length });
    }
  }
  return lists;
}

// 베스트셀러 목록의 각 책에 크레마 책(cremaId)과 소장 도서관(libIds: {libKey: 책ID})을 붙이고,
// 크레마 정렬용 bookId → {source: rank} 맵을 만든다.
function matchBestsellerLists(lists, cremaBooks, merged) {
  const cremaById = new Map(cremaBooks.map(b => [b.bookId, b]));
  const findCremaByTitle = buildTitleIndex(cremaBooks);
  const findLibByTitle = buildTitleIndex(merged || []);
  const bestsellers = {};
  for (const [src, list] of Object.entries(lists)) {
    for (const b of list) {
      // YES24 상품번호는 크레마 bookId와 같음 → 우선, 없으면 제목
      const cb = (b.goodsNo && cremaById.get(b.goodsNo)) || findCremaByTitle(b.title, b.author || '');
      b.cremaId = cb?.bookId || null;
      b.libIds = findLibByTitle(b.title, b.author || '')?.ids || {};
      b.millieId = findMillie(b.title, b.author || '');
      b.ridiId = findRidi(b.title, b.author || '');
      if (cb) (bestsellers[cb.bookId] ||= {})[src] ??= b.rank;
    }
  }
  return bestsellers;
}

// 저장된 베스트셀러 목록에 최신 크레마/도서관 데이터로 다시 매칭 (도서관·크레마 동기화 후 호출)
function rematchBestsellers() {
  const d = loadData();
  if (!d.bestsellerLists) return;
  d.bestsellers = matchBestsellerLists(d.bestsellerLists, d.books || [], loadLibs().merged);
  saveData(d);
}

async function syncBestsellers(onProgress) {
  const lists = await crawlBestsellerLists(onProgress);
  const d = loadData();
  // 실패한 목록은 이전 것 유지
  d.bestsellerLists = { ...(d.bestsellerLists || {}), ...lists };
  d.bestsellers = matchBestsellerLists(d.bestsellerLists, d.books || [], loadLibs().merged);
  d.bestsellerSync = new Date().toISOString();
  saveData(d);
  return d;
}

// ─── API Routes ───
let syncRunning = false;
let syncAborted = false;

app.get('/api/sync', async (req, res) => {
  if (syncRunning) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.write(`data: ${JSON.stringify({ error: '이미 동기화가 진행 중입니다' })}\n\n`);
    res.end();
    return;
  }
  syncRunning = true;
  syncAborted = false;

  // 클라이언트가 끊기면 중단 요청만 하고, 잠금은 크롤링 루프가 실제로 끝난 뒤(finally)에 푼다.
  // 여기서 바로 풀면 새 동기화가 syncAborted를 false로 되돌려 이전 크롤링이 같이 계속 돈다.
  res.on('close', () => { syncAborted = true; });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (obj) => {
    if (typeof obj === 'string') obj = { status: obj };
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch(e) {}
  };

  try {
    send({ status: '크레마클럽 크롤링 시작...', phase: 'crema', page: 0, totalPages: 1 });

    // 1. Crawl Crema Club (전체 + 장르)
    const crawlResult = await crawlCremaClub((p) => send(p));
    if (syncAborted) { console.log('Crema sync aborted'); return; }
    const prev = loadData();
    // 없어진 책 처리 규칙은 retention.js (다 못 받았거나 크게 줄었으면 지우지 않음, 연속 2번 안 보이면 지움)
    const rc = reconcile(prev.books || [], crawlResult.books, { idOf: b => b.bookId, titleOf: b => b.title, complete: crawlResult.complete, prevMissing: prev.cremaMissing });
    const cremaBooks = rc.items;
    const rcNote = `새 책 ${rc.changes.added} · 지움 ${rc.changes.removed} · 안 보였지만 남김 ${rc.changes.kept}`;
    if (!crawlResult.complete) {
      send({ status: `크레마클럽 크롤링 일부 실패 (실패 페이지 ${crawlResult.failedPages}개) — 받은 책만 갱신, 지우지 않음 (${rcNote})`, phase: 'bestseller', page: 0, totalPages: 5 });
    } else {
      const genreNote = crawlResult.genreFailed.length ? ` (장르 일부 실패: ${crawlResult.genreFailed.join(' / ')})` : '';
      const dropNote = rc.changes.warning === 'drop' ? ` ⚠ 권수가 ${rc.changes.prev}→${rc.changes.received}로 크게 줄어 지우지 않음` : '';
      send({ status: `크레마클럽 ${cremaBooks.length.toLocaleString()}권 (${rcNote})${dropNote}${genreNote}`, phase: 'bestseller', page: 0, totalPages: 5 });
    }

    // 2. Crawl bestseller lists (매칭은 저장 후 rematchBestsellers에서)
    const bestsellerLists = await crawlBestsellerLists((p) => send(p));

    // 4. Cross-match with seoul
    send({ status: '서울도서관 크로스매칭 중...', phase: 'match' });
    const seoulBooksData = loadSeoul();
    let crossMatch = {};
    if (seoulBooksData.books.length > 0) {
      crossMatch = buildCrossMatch(seoulBooksData.books, cremaBooks);
      seoulBooksData.crossMatch = crossMatch;
      saveSeoul(seoulBooksData);
    }

    // 5. Save
    const data = {
      ...prev,
      books: cremaBooks,
      cremaMissing: rc.missing,
      cremaChanges: rc.changes,
      bestsellerLists: { ...(prev.bestsellerLists || {}), ...bestsellerLists },
      bestsellerSync: new Date().toISOString(),
      lastSync: new Date().toISOString(),
      seoulMatch: crossMatch.cremaToSeoul || {}
    };
    if (crawlResult.complete) data.lastCremaCrawl = data.lastSync;
    saveData(data);
    send({ status: '구립도서관 매칭 중...', phase: 'match' });
    rebuildLibMatch(); // 베스트셀러 매칭도 여기서 갱신
    const bestsellers = loadData().bestsellers || {};

    const matchCount = Object.keys(bestsellers).length;
    const crossCount = Object.keys(crossMatch.cremaToSeoul || {}).length;
    send(`완료! ${cremaBooks.length}권, 베스트셀러 ${matchCount}권, 서울도서관 ${crossCount}권 매칭`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (e) {
    send(`오류: ${e.message}`);
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  } finally {
    syncRunning = false;
  }
});

// ─── 즐겨찾기 ───
// 책 정보만 저장하고, 크레마·도서관 소장 여부는 조회할 때마다 최신 데이터로 찾는다.
// key: 크레마 책이면 'c:<bookId>', 아니면 't:<정규화 제목>|<저자 키>' (클라이언트에서 계산)
const FAV_FILE = path.join(__dirname, 'data-favorites.json');
// 즐겨찾기는 플랫폼과 무관하게 책 단위: key = 't:<정규화 제목>|<저자 키>'
const favKey = (title, author) => 't:' + workKey(title) + '|' + authorKey(author);
function loadFavs() {
  let d;
  try { d = JSON.parse(fs.readFileSync(FAV_FILE, 'utf8')); }
  catch { return { items: [] }; }
  // key 규칙이 바뀌었으면(예전 'c:<bookId>' 등) 다시 계산하고 같은 책은 하나로
  if (d.items.some(f => f.key !== favKey(f.title, f.author))) {
    const seen = new Set();
    d.items = d.items.map(f => ({ ...f, key: favKey(f.title, f.author) })).filter(f => !seen.has(f.key) && seen.add(f.key));
    saveFavs(d);
  }
  return d;
}
function saveFavs(d) { fs.writeFileSync(FAV_FILE, JSON.stringify(d, null, 2)); }

let favIndex = null; // 크레마/통합 목록 색인 (크기가 커서 캐시, 매칭이 바뀌면 rebuildLibMatch에서 비움)
function getFavIndex() {
  if (!favIndex) {
    const crema = loadData();
    const libs = loadLibs();
    favIndex = {
      cremaById: new Map((crema.books || []).map(b => [b.bookId, b])),
      findCrema: buildTitleIndex(crema.books || []),
      findMerged: buildTitleIndex(libs.merged || []),
      cremaLibIds: libs.cremaLibIds || {},
      seoulMatch: crema.seoulMatch || {},
    };
  }
  return favIndex;
}

function enrichFav(f) {
  const ix = getFavIndex();
  // 저장된 cremaId도 저자가 맞을 때만 (예전에 제목만으로 붙은 것: '친구' 시그리드 누네즈 ≠ 이정민·이명애)
  const saved = f.cremaId && ix.cremaById.get(f.cremaId);
  const cb = (saved && authorsMatch(f.author, saved.author) ? saved : null) || ix.findCrema(f.title, f.author || '');
  let libIds;
  if (cb && (ix.cremaLibIds[cb.bookId] || ix.seoulMatch[cb.bookId])) {
    libIds = { ...(ix.cremaLibIds[cb.bookId] || {}) };
    if (ix.seoulMatch[cb.bookId]) libIds.seoul = ix.seoulMatch[cb.bookId];
  } else {
    libIds = ix.findMerged(f.title, f.author || '')?.ids || {};
  }
  return { ...f, millieId: findMillie(cb?.title || f.title, cb?.author || f.author || ''), ridiId: findRidi(cb?.title || f.title, cb?.author || f.author || ''), cremaId: cb?.bookId || null, crema: cb ? { rating: cb.rating, reviews: cb.reviews, cover: cb.cover } : null, libIds };
}

app.get('/api/favorites', (req, res) => {
  res.json({ items: loadFavs().items.map(enrichFav) });
});

app.post('/api/favorites', (req, res) => {
  const { title, author = '', publisher = '', cremaId = null } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title이 필요합니다' });
  const key = favKey(title, author);
  const d = loadFavs();
  if (!d.items.some(f => f.key === key)) {
    d.items.unshift({ key, title, author, publisher, cremaId, addedAt: new Date().toISOString() });
    saveFavs(d);
  }
  res.json({ item: enrichFav(d.items.find(f => f.key === key)) });
});

app.delete('/api/favorites', (req, res) => {
  const d = loadFavs();
  d.items = d.items.filter(f => f.key !== req.query.key);
  saveFavs(d);
  res.json({ ok: true });
});

// ─── 십진분류(KDC): 국립중앙도서관 Open API (키는 nl-key.txt 또는 NL_API_KEY) ───
// 소장자료 검색에서 제목·저자가 맞는 책들의 분류번호 중 가장 많은 것 → 없으면 ISBN 서지정보 API
// 저장: data-kdc.json { 책 키(즐겨찾기와 같은 규칙): { c: '843.6' | '8xx'(큰 분류만) | null, s: 'n'(소장자료) | 'i'(ISBN) } }
const KDC_FILE = path.join(__dirname, 'data-kdc.json');
const nlKey = () => { try { return process.env.NL_API_KEY || fs.readFileSync(path.join(__dirname, 'nl-key.txt'), 'utf8').trim(); } catch { return ''; } };
let kdcCache = null, kdcDirty = 0;
const kdcMap = () => kdcCache ||= (() => { try { return JSON.parse(fs.readFileSync(KDC_FILE, 'utf8')); } catch { return {}; } })();
function saveKdc(force) {
  if (!kdcCache || (!force && kdcDirty < 200)) return;
  // 임시 파일에 쓰고 바꿔치기: 쓰는 도중 꺼져도 기존 파일은 멀쩡
  fs.writeFileSync(KDC_FILE + '.tmp', JSON.stringify(kdcCache));
  fs.renameSync(KDC_FILE + '.tmp', KDC_FILE);
  kdcDirty = 0;
}
let isbnByWork = null; // 통합 목록에서 제목 → ISBN 있는 책들
function findIsbn(title, author) {
  if (!isbnByWork) {
    isbnByWork = new Map();
    for (const m of loadLibs().merged || []) if (/^\d{13}$/.test(m.isbn || '')) {
      const k = workKey(m.title); const a = isbnByWork.get(k); if (a) a.push(m); else isbnByWork.set(k, [m]);
    }
  }
  const fa = firstAuthorSq(author);
  return (isbnByWork.get(workKey(title)) || []).find(m => sameAuthorKeys(firstAuthorSq(m.author), sqz(m.author), [fa]))?.isbn || null;
}
const KDC_NUM_RE = /^\d{3}(\.\d+)?/;
async function nlJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function kdcByIsbn(key, isbn) {
  const j = await nlJson(`https://www.nl.go.kr/seoji/SearchApi.do?cert_key=${key}&result_style=json&page_no=1&page_size=5&isbn=${isbn}`);
  return (j?.docs || []).map(d => (String(d.KDC || '').match(KDC_NUM_RE) || [])[0]).find(Boolean) || null;
}
async function lookupKdc(key, title, author, isbn) {
  const strip = (t) => (t || '').replace(/<[^>]+>/g, '');
  const core = (title || '').replace(/\s*[(\[].*$/, '').replace(/\s+[-:]\s.*$/, '').trim() || title;
  if (!core) return { c: null };
  const fa = firstAuthorSq(author);
  const au = (author || '').replace(/\([^)]*\)|\[[^\]]*\]/g, '').split(/[,/·;]/)[0].replace(/\s*(지음|저|글|엮음|편저|편|옮김|역|저자)\s*$/, '').trim();
  const votes = new Map(), mains = new Map(), isbns = [];
  for (const kwd of au ? [`${core} ${au}`, core] : [core]) {
    const j = await nlJson(`https://www.nl.go.kr/NL/search/openApi/search.do?key=${key}&apiType=json&srchTarget=total&pageNum=1&pageSize=30&kwd=${encodeURIComponent(kwd)}`);
    for (const r of j?.result || []) {
      if (r.typeName !== '도서') continue;
      if (!sqz(strip(r.titleInfo)).includes(sqz(core))) continue;
      if (fa && !sqz(strip(r.authorInfo)).includes(fa)) continue;
      const c = (String(r.classNo || '').match(KDC_NUM_RE) || String(r.callNo || '').match(KDC_NUM_RE) || [])[0];
      if (c) { const v = votes.get(c.slice(0, 3)) || new Map(); v.set(c, (v.get(c) || 0) + 1); votes.set(c.slice(0, 3), v); }
      if (/^\d$/.test(r.kdcCode1s || '')) mains.set(r.kdcCode1s, (mains.get(r.kdcCode1s) || 0) + 1);
      if (/^\d{13}/.test(r.isbn || '')) isbns.push(r.isbn.slice(0, 13));
    }
    if (votes.size) break;
  }
  if (votes.size) {
    // 세 자리는 가장 많이 나온 것, 그 안에서는 가장 많이 나온 번호 (같으면 더 자세한 번호)
    const sum = (v) => [...v.values()].reduce((a, b) => a + b, 0);
    const [, v] = [...votes].sort((a, b) => sum(b[1]) - sum(a[1]))[0];
    const c = [...v].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
    return { c, s: 'n' };
  }
  for (const i of [isbn, findIsbn(title, author), ...isbns].filter(Boolean).slice(0, 3)) {
    const c = await kdcByIsbn(key, i);
    if (c) return { c, s: 'i' };
  }
  const m = [...mains].sort((a, b) => b[1] - a[1])[0]?.[0];
  return { c: m ? m + 'xx' : null, s: m ? 'n' : undefined };
}
// 동시에 여러 개 조회 (화면 요청과 백그라운드 작업이 같은 줄을 씀)
const KDC_CONCURRENCY = 4;
let kdcActive = 0;
const kdcWaiters = [], kdcPending = new Map();
async function kdcSlot(fn, urgent) { // 화면 요청(urgent)은 줄 맨 앞에
  while (kdcActive >= KDC_CONCURRENCY) await new Promise(r => urgent ? kdcWaiters.unshift(r) : kdcWaiters.push(r));
  kdcActive++;
  try { return await fn(); } finally { kdcActive--; kdcWaiters.shift()?.(); }
}
function getKdc(k, title, author, isbn, urgent) {
  const map = kdcMap();
  if (k in map) return Promise.resolve(map[k]);
  if (kdcPending.has(k)) return kdcPending.get(k);
  const key = nlKey();
  if (!key) return Promise.resolve(null);
  const run = async () => {
    try {
      const v = await lookupKdc(key, title, author, isbn);
      map[k] = v.s ? v : { c: v.c };
      kdcDirty++; saveKdc();
      return map[k];
    } catch (e) { return null; } // 실패는 저장하지 않음 (다음에 다시)
    finally { kdcPending.delete(k); }
  };
  const p = kdcSlot(run, urgent);
  kdcPending.set(k, p);
  return p;
}
// 백그라운드: 밀리 → 크레마 → 도서관 순서로 아직 없는 책을 모두
const kdcJob = { running: false, stage: '', done: 0, total: 0 };
async function kdcSyncAll() {
  if (kdcJob.running || !nlKey()) return;
  kdcJob.running = true;
  try {
    const stages = [
      ['즐겨찾기', () => loadFavs().items.map(f => [f.title, f.author, null])],
      ['밀리', () => (loadMillie().books || []).map(r => [r[1], r[2], null])],
      ['크레마', () => (loadData().books || []).map(b => [b.title, b.author, null])],
      ['도서관', () => (loadLibs().merged || []).map(m => [m.title, m.author, m.isbn || null])],
    ];
    for (const [name, rows] of stages) {
      const map = kdcMap(), seen = new Set();
      const todo = rows().filter(([t, a]) => { const k = favKey(t, a); if (k in map || seen.has(k)) return false; seen.add(k); return true; });
      Object.assign(kdcJob, { stage: name, done: 0, total: todo.length });
      const queue = todo.slice();
      await Promise.all(Array.from({ length: KDC_CONCURRENCY }, async () => {
        for (let r; (r = queue.shift());) {
          // 인터넷이 끊기는 등 조회에 실패하면 건너뛰지 않고 기다렸다가 다시 (5초 → 최대 5분, 8번까지)
          for (let tries = 0, wait = 5000; tries < 8; tries++, wait = Math.min(wait * 2, 300000)) {
            if (await getKdc(favKey(r[0], r[1]), r[0], r[1], r[2])) break;
            kdcJob.waiting = true;
            await new Promise(res => setTimeout(res, wait));
          }
          kdcJob.waiting = false;
          kdcJob.done++;
        }
      }));
      saveKdc(true);
    }
    kdcJob.stage = '완료';
  } finally { kdcJob.running = false; saveKdc(true); }
}
setTimeout(() => kdcSyncAll().catch(e => console.log('KDC 동기화', e.message)), 20000);
app.get('/api/kdc', (req, res) => {
  const map = kdcMap(), out = {};
  for (const k in map) if (map[k].c) out[k] = map[k].c;
  res.json({ enabled: !!nlKey(), job: kdcJob, map: out });
});
// 화면에 보이는 책: [{k, t, a, i}] → { k: '843.6' | null }
app.post('/api/kdc/lookup', async (req, res) => {
  const items = (req.body?.items || []).slice(0, 60);
  const out = {};
  await Promise.all(items.map(async ({ k, t, a, i }) => {
    const v = await getKdc(k, t, a, i, true);
    out[k] = v ? v.c : undefined;
  }));
  res.json({ map: out });
});

// 베스트셀러만 새로 받기 (~10초)
let bestSyncRunning = false;
app.get('/api/bestsellers/sync', async (req, res) => {
  if (bestSyncRunning) return res.status(409).json({ error: '이미 베스트셀러를 받는 중입니다' });
  bestSyncRunning = true;
  try {
    const d = await syncBestsellers();
    res.json({ bestsellerLists: d.bestsellerLists, bestsellers: d.bestsellers, bestsellerSync: d.bestsellerSync });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    bestSyncRunning = false;
  }
});

app.get('/api/data', (req, res) => {
  res.json(loadData());
});

// ─── 밀리의 서재 ───
// 로그인 없이 쓸 수 있는 공개 API는 카테고리별 순위 목록뿐이고, 정렬마다 상위 100권까지만 준다.
// 인기순·제목순·출간순으로 받아 합치면 전체(약 18만 종)의 1/3 정도. 그래서 '없음'은 확정이 아니라 '미확인'.
const MILLIE_FILE = path.join(__dirname, 'data-millie.json');
const MILLIE_API = 'https://apis.millie.co.kr/public/content/search/category';
// 최상위 카테고리 (하위 카테고리는 동기화 때 API로 받는다)
const MILLIE_ROOTS = [1194, 1208, 1223, 1240, 1253, 1269, 1287, 1312, 1319, 1332, 1336, 1343, 1353, 1362, 1447, 1474, 1610,
  1705, 1754, 1779, 1785, 1827, 2032, 2068, 2076, 2110, 2125, 2131, 2137, 2141, 2168, 2170, 2176, 2179, 2180, 2212];
const MILLIE_ORDERINGS = ['popular', 'title', 'published'];

function loadMillie() {
  try { return JSON.parse(fs.readFileSync(MILLIE_FILE, 'utf8')); }
  catch { return { books: [] }; }
}

async function fetchMillieJson(url, retries = 2) {
  for (let i = 0; ; i++) {
    try {
      // Accept: text/html이면 406을 돌려줌
      const resp = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'application/json' } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      if (resp.status === 204) return null; // 내용 없음 (예: 평가가 하나도 없는 책의 별점)
      return await resp.json();
    } catch (e) {
      if (i >= retries) throw e;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

async function crawlMillie(onProgress) {
  // 1) 하위 카테고리 목록
  const cats = new Map();
  for (const root of MILLIE_ROOTS) {
    try {
      const d = await fetchMillieJson(`${MILLIE_API}/?category_seq=${root}`);
      for (const c of d.sub_categories || []) if (c.total_count) cats.set(c.category_seq, c.category_name);
    } catch (e) { console.error(`millie category ${root}:`, e.message); }
  }
  // 2) 카테고리 × 정렬마다 상위 100권
  const jobs = [];
  for (const seq of cats.keys()) for (const o of MILLIE_ORDERINGS) jobs.push([seq, o]);
  const books = new Map();
  let done = 0, failed = 0;
  const worker = async () => {
    while (jobs.length) {
      const [seq, ordering] = jobs.shift();
      try {
        const d = await fetchMillieJson(`${MILLIE_API}/ranking/?limit=100&offset=0&ordering=${ordering}&category_seq=${seq}`);
        for (const r of d.results || []) {
          // [id, 제목, 저자, 상위 카테고리, 표지, 서재에 담은 수, 리뷰 수, 오디오북 여부(content_code 806), 하위 카테고리, 별점·평가 수(아래 3단계), 완독률(%), 완독 예상 시간(초)]
          if (!books.has(r.book_id)) books.set(r.book_id, [r.book_id, r.content_name, r.author || '', r.category || '', r.content_thumb_url || '', r.content_take_count || 0, r.content_review_count || 0, r.content_code === 806 ? 1 : 0, r.category2 || '', 0, 0, r.view_percent ?? null, r.view_time ?? null]);
        }
      } catch (e) { failed++; }
      done++;
      onProgress?.({ status: `밀리의 서재 ${done}/${done + jobs.length} · ${books.size.toLocaleString()}권`, phase: 'millie', page: done, totalPages: done + jobs.length });
      await new Promise(r => setTimeout(r, 150));
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const rows = [...books.values()];
  // 별점은 runMillieJob에서 따로 (없는 책 먼저, 있는 책은 2주마다) → 여기선 이전 값을 그대로 옮김
  const prev = new Map((loadMillie().books || []).map(r => [r[0], r]));
  for (const r of rows) { const p = prev.get(r[0]); if (p) { r[9] = p[9] || 0; r[10] = p[10] || 0; } }
  return { books: rows, categories: cats.size, failed };
}

// 3) 책마다 별점 (5점 만점, 책 페이지와 같은 공개 API) → 행 [9] 평균, [10] 평가 수
// 실패한 책은 이전 동기화 값을 그대로 둔다
// rows 중 targets(행)만 받아서 행을 고치고 pointsAt[id]에 받은 날짜를 남김. 실패한 책은 그대로 (다음에 다시)
async function crawlMilliePoints(targets, onProgress, pointsAt) {
  const queue = targets.slice();
  let done = 0, ok = 0;
  const worker = async () => {
    while (queue.length) {
      const r = queue.shift();
      try {
        const d = await fetchMillieJson(`https://apis.millie.co.kr/public/content/detail/point/${r[0]}/`, 1);
        r[9] = parseFloat(d?.average_point) || 0; r[10] = d?.point_count || 0;
        pointsAt[r[0]] = new Date().toISOString(); ok++;
      } catch {}
      if (++done % 200 === 0 || !queue.length) onProgress?.({ status: `밀리의 서재 별점 ${done.toLocaleString()}/${targets.length.toLocaleString()}`, phase: 'millie', page: done, totalPages: targets.length });
      await new Promise(res => setTimeout(res, 400));
    }
  };
  // 천천히 (6개 동시 + 50ms 간격으로 2만 5천 번 요청했다가 밀리에서 IP가 차단됨)
  await Promise.all(Array.from({ length: 2 }, worker));
  return { tried: targets.length, ok };
}

// 별점 받을 책 고르기
//  all: 전부 / rolling: 별점을 아직 안 받은 책 전부(최대 MILLIE_NEW_MAX) + 받은 지 2주 넘은 책 중 오래된 순으로 전체의 1/14
const MILLIE_POINTS_DAYS = 14, MILLIE_NEW_MAX = 6000;
function pickMilliePoints(books, pointsAt, mode) {
  if (mode === 'all') return { targets: books.slice(), missing: books.filter(r => !pointsAt[r[0]]).length, refresh: books.filter(r => pointsAt[r[0]]).length };
  const missing = books.filter(r => !pointsAt[r[0]]).slice(0, MILLIE_NEW_MAX);
  const old = Date.now() - MILLIE_POINTS_DAYS * 864e5;
  const quota = Math.ceil(books.length / MILLIE_POINTS_DAYS);
  const refresh = books.filter(r => pointsAt[r[0]] && Date.parse(pointsAt[r[0]]) < old)
    .sort((a, b) => pointsAt[a[0]].localeCompare(pointsAt[b[0]])).slice(0, quota);
  return { targets: [...missing, ...refresh], missing: missing.length, refresh: refresh.length };
}

// 밀리 책 → 크레마 bookId / 통합 목록 항목 / 베스트셀러 / 즐겨찾기에 millieId를 붙이는 제목 색인
let millieFinder = null;
function findMillie(title, author) {
  if (!millieFinder) {
    const rows = loadMillie().books || [];
    millieFinder = buildTitleIndex(rows.map(([id, title, author]) => ({ id, title, author })));
  }
  return millieFinder(title, author)?.id || null;
}

// 밀리는 공개 목록이 카테고리별 인기 순위(상위 100권)뿐이라 순위에서 빠졌다고 없어진 게 아님 →
// 한 번 본 책은 계속 두고(누적), 이번에 안 보인 책은 책 상세 API로 하나씩 확인해서 없어진 게 확실할 때만 지운다.
// 없어짐: 404·400(잘못된 책 번호) 또는 is_serviced=false. 그 밖의 오류는 확인 못 함 → 남김.
const MILLIE_VERIFY_MAX = 1500; // 하루에 확인하는 최대 권수 (오래 안 보인 책부터, 나머지는 다음 날)
async function millieBookState(id) {
  try {
    const r = await fetch(`https://apis.millie.co.kr/v3/content/detail/book/${id}/`, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'application/json' } });
    if (r.status === 404 || r.status === 400) return 'gone';
    if (!r.ok) return 'unknown';
    const d = await r.json();
    return d?.is_serviced === false ? 'gone' : d?.book_id || d?.content_seq ? 'exists' : 'unknown';
  } catch { return 'unknown'; }
}
async function reconcileMillie(prev, rows, onProgress) {
  const now = new Date().toISOString();
  const seen = { ...(prev.seen || {}) };
  const ids = new Set(rows.map(r => r[0]));
  const prevIds = new Set((prev.books || []).map(r => r[0]));
  for (const r of rows) seen[r[0]] = now;
  const added = rows.filter(r => !prevIds.has(r[0]));
  const gone = (prev.books || []).filter(r => !ids.has(r[0]));
  // 오래 안 보인 책부터 확인
  gone.sort((a, b) => (seen[a[0]] || '').localeCompare(seen[b[0]] || ''));
  const state = new Map();
  const queue = gone.slice(0, MILLIE_VERIFY_MAX);
  let done = 0;
  await Promise.all(Array.from({ length: 2 }, async () => {
    for (let r; (r = queue.shift());) {
      state.set(r[0], await millieBookState(r[0]));
      if (++done % 200 === 0 || !queue.length) onProgress?.({ status: `밀리의 서재: 순위에서 빠진 책 확인 ${done.toLocaleString()}/${Math.min(gone.length, MILLIE_VERIFY_MAX).toLocaleString()}`, phase: 'millie', page: done, totalPages: Math.min(gone.length, MILLIE_VERIFY_MAX) });
      await new Promise(res => setTimeout(res, 400));
    }
  }));
  const removed = gone.filter(r => state.get(r[0]) === 'gone');
  const kept = gone.filter(r => state.get(r[0]) === 'exists');
  const unknown = gone.filter(r => state.get(r[0]) !== 'gone' && state.get(r[0]) !== 'exists'); // 확인 못 함·확인 안 함
  for (const r of removed) delete seen[r[0]];
  const S = 50, pair = r => [r[0], r[1]];
  const changes = { at: now, prev: (prev.books || []).length, received: rows.length, added: added.length, removed: removed.length, kept: kept.length, unknown: unknown.length, warning: null,
    addedSample: added.slice(0, S).map(pair), removedSample: removed.slice(0, S).map(pair), keptSample: kept.slice(0, S).map(pair), unknownSample: unknown.slice(0, S).map(pair) };
  return { books: [...rows, ...kept, ...unknown], seen, changes };
}

let millieJob = { running: false, status: null, listeners: new Set() };
// pointsMode: 'rolling'(매일 자동 동기화) | 'all'(전부 다시)
async function runMillieJob(pointsMode = 'all') {
  millieJob.running = true;
  const send = (o) => { if (o.status) millieJob.status = o.status; for (const l of millieJob.listeners) l(o); };
  try {
    send({ status: '밀리의 서재 카테고리 받는 중...', phase: 'millie', page: 0, totalPages: 1 });
    const r = await crawlMillie(send);
    if (!r.books.length) throw new Error('받은 책이 없습니다');
    const prevM = loadMillie();
    const m = await reconcileMillie(prevM, r.books, send);
    // 별점 받은 날짜: 처음엔 기록이 없으니, 예전 동기화에서 이미 받은 책은 그 동기화 날짜로 (한꺼번에 다시 받지 않게)
    const pointsAt = prevM.pointsAt || Object.fromEntries((prevM.books || []).map(x => [x[0], prevM.lastSync || new Date(0).toISOString()]));
    const keepIds = new Set(m.books.map(x => x[0]));
    for (const id of Object.keys(pointsAt)) if (!keepIds.has(id)) delete pointsAt[id]; // 지운 책만 (순위에서만 빠진 책은 별점 기록 유지)
    const pick = pickMilliePoints(m.books, pointsAt, pointsMode);
    send({ status: `밀리의 서재 별점: 없는 책 ${pick.missing.toLocaleString()} · 2주 지난 책 ${pick.refresh.toLocaleString()}`, phase: 'millie', page: 0, totalPages: pick.targets.length });
    const pr = await crawlMilliePoints(pick.targets, send, pointsAt);
    m.changes.points = { mode: pointsMode, missing: pick.missing, refresh: pick.refresh, ok: pr.ok, failed: pr.tried - pr.ok,
      stillMissing: m.books.filter(x => !pointsAt[x[0]]).length, stale: m.books.filter(x => pointsAt[x[0]] && Date.parse(pointsAt[x[0]]) < Date.now() - MILLIE_POINTS_DAYS * 864e5).length };
    fs.writeFileSync(MILLIE_FILE, JSON.stringify({ lastSync: new Date().toISOString(), categories: r.categories, failed: r.failed, books: m.books, seen: m.seen, pointsAt, changes: m.changes }));
    millieFinder = null;
    send({ status: '매칭 중...', phase: 'match' });
    rebuildLibMatch();
    const c = m.changes;
    send({ status: `완료! 밀리의 서재 ${m.books.length.toLocaleString()}권 (이번 순위 ${r.books.length.toLocaleString()} · 새 책 ${c.added} · 없어진 것 확인 ${c.removed} · 순위에만 빠진 책 ${c.kept}${c.unknown ? ` · 확인 못 해 남김 ${c.unknown}` : ''} · 별점 ${pr.ok.toLocaleString()}/${pr.tried.toLocaleString()}권 받음 · 카테고리 ${r.categories}개${r.failed ? `, 실패 ${r.failed}건` : ''})` });
    send({ done: true });
  } catch (e) {
    send({ error: e.message });
  } finally {
    millieJob.running = false;
    millieJob.listeners.clear();
  }
}

app.get('/api/millie/sync', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (obj) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {}
    if (obj.done || obj.error) res.end();
  };
  millieJob.listeners.add(send);
  res.on('close', () => millieJob.listeners.delete(send));
  if (millieJob.running) send({ status: '이미 진행 중인 동기화에 연결됨 · ' + (millieJob.status || ''), phase: 'millie' });
  else runMillieJob(req.query.points === 'rolling' ? 'rolling' : 'all');
});

// 책 팝업용: 밀리 책 상세에서 전체 페이지 수 (팝업을 열 때 한 권씩, 메모리에 캐시)
const millieBookCache = new Map();
app.get('/api/millie/book/:id', async (req, res) => {
  const id = String(req.params.id).replace(/[^0-9a-f]/gi, '');
  if (!id) return res.json({});
  try {
    if (!millieBookCache.has(id)) {
      const d = await fetchMillieJson(`https://apis.millie.co.kr/v3/content/detail/book/${id}/`, 1);
      millieBookCache.set(id, { totalPage: d?.total_page || null });
    }
    res.json(millieBookCache.get(id));
  } catch (e) { res.json({ error: e.message }); }
});

// ─── 문학상 수상작 (awards/*.json, 직접 정리한 목록) ───
// 책 단위 목록은 크레마·밀리·도서관 책을 찾아 붙이고, 작가 단위 목록(노벨문학상 등)은 그 작가의 책 수를 센다
const AWARD_DIR = path.join(__dirname, 'awards');
const AWARD_META = [
  ['nobel', '노벨문학상', 'author'],
  ['booker', '부커상', 'book'],
  ['intl_booker', '인터내셔널 부커상', 'mixed'],
  ['pulitzer_fiction', '퓰리처상 소설', 'book'],
  ['nba_fiction', '전미도서상 소설', 'book'],
  ['womens_prize', '여성문학상', 'book'],
  ['naoki', '나오키상', 'book'],
  ['akutagawa', '아쿠타가와상', 'book'],
  ['nyt10_fiction', '뉴욕타임스 올해의 책 (소설)', 'book'],
  ['honya_taisho', '서점대상', 'book'],
  ['time100', '타임 100대 영문 소설', 'book'],
  ['modernlib100', '모던 라이브러리 100 (소설)', 'book'],
  ['hugo', '휴고상', 'book'],
  ['nebula', '네뷸러상', 'book'],
  ['locus', '로커스상', 'book'],
  ['clarke', '아서 C. 클라크상', 'book'],
  ['world_fantasy', '세계환상문학상', 'book'],
  ['bram_stoker', '브램 스토커상', 'book'],
  ['edgar', '에드거상', 'book'],
  ['dagger', '골드 대거상', 'book'],
  ['konomys', '이 미스터리가 대단하다! 1위', 'book'],
  ['honkaku_mys', '본격미스터리대상', 'book'],
  ['pulitzer_nonfiction', '퓰리처상 논픽션', 'book'],
  ['pulitzer_history', '퓰리처상 역사', 'book'],
  ['pulitzer_biography', '퓰리처상 전기', 'book'],
  ['nba_nonfiction', '전미도서상 논픽션', 'book'],
  ['baillie_gifford', '베일리 기퍼드상', 'book'],
  ['royal_society', '왕립학회 과학도서상', 'book'],
  ['nyt10_nonfiction', '뉴욕타임스 올해의 책 (비문학)', 'book'],
  ['modernlib100_nonfiction', '모던 라이브러리 100 (논픽션)', 'book'],
  ['nyt100', '뉴욕타임스 21세기 최고의 책 100', 'book'],
  ['guardian100', '가디언 21세기 최고의 책 100', 'book'],
  ['books1001', '죽기 전에 꼭 읽어야 할 소설 1001', 'book'],
  ['greatbooks', '시카고대 그레이트 북스', 'book'],
  ['snu100', '서울대 권장도서 100', 'book'],
  ['gates', '빌 게이츠 추천 도서', 'book'],
];
const sqz = (t) => (t || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
// 첫 저자 이름만: '움베르토 에코 저/이윤기 역' → '움베르토에코'
const firstAuthorSq = (a) => sqz((a || '').replace(/\([^)]*\)|\[[^\]]*\]/g, '').split(/[,/·;]|\s+외(?:\s|$)|\s+등(?:\s|$)/)[0]
  .replace(/(\s*(공저|편저|편역|번역|저|지음|글|그림|역|옮김|엮음|편|기획|원작|감수|해설))+\s*$/, ''));
// 저자가 같은지: 첫 저자 이름이 같거나, (3글자 이상 이름이면) 저자 칸에 이름이 들어 있음
function sameAuthor(catalogAuthor, names) {
  return sameAuthorKeys(firstAuthorSq(catalogAuthor), sqz(catalogAuthor), names.map(sqz))
    || names.some(n => HANGUL_RE.test(n) && authorNames(n).some(p => authorNames(catalogAuthor).some(q => sameForeignName(p, q))));
}
const sameAuthorKeys = (fa, all, keys) => keys.some(k => k && (fa === k || (k.length >= 3 && all.includes(k))));
const titleKeys = (t) => {
  const w = workKey(t), b = workKey((t || '').replace(/\s*[(\[].*$|\s+[-:]\s.*$/, ''));
  return w === b ? [w] : [w, b];
};
let awardsCache = null;
function buildAwards() {
  const files = AWARD_META.map(([k]) => path.join(AWARD_DIR, `${k}.json`));
  const stamp = [DATA_FILE, LIBS_FILE, MILLIE_FILE, RIDI_FILE, ...files].map(f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join();
  if (awardsCache?.stamp === stamp) return awardsCache.data;
  const crema = loadData().books || [], merged = loadLibs().merged || [], millie = loadMillie().books || [], ridi = loadRidi().books || [];
  const cremaById = new Map(crema.map(b => [b.bookId, b]));
  // 제목 키 → 책 여러 권 (같은 제목 다른 저자를 저자로 가려냄)
  const index = (rows, titleOf) => { const m = new Map(); for (const r of rows) for (const k of titleKeys(titleOf(r))) { const a = m.get(k); if (a) a.push(r); else m.set(k, [r]); } return m; };
  const iC = index(crema, b => b.title), iL = index(merged, m => m.title), iM = index(millie, r => r[1]), iR = index(ridi, r => r[1]);
  // 작가 단위 목록용: 책마다 첫 저자 키·저자 칸 전체 키 (필요할 때 한 번만)
  const authorKeysOf = (rows, authorOf) => { let c; return () => c ||= { fa: rows.map(r => firstAuthorSq(authorOf(r))), all: rows.map(r => sqz(authorOf(r))) }; };
  const akC = authorKeysOf(crema, b => b.author), akM = authorKeysOf(millie, r => r[2]), akL = authorKeysOf(merged, m => m.author), akR = authorKeysOf(ridi, r => r[2]);
  // 첫 저자 키 → 책들 (권으로 나뉜 책 찾기용)
  const byAuthor = (rows, authorOf) => { const m = new Map(); for (const r of rows) { const k = firstAuthorSq(authorOf(r)); const a = m.get(k); if (a) a.push(r); else m.set(k, [r]); } return m; };
  const aC = byAuthor(crema, b => b.author), aL = byAuthor(merged, m => m.author), aM = byAuthor(millie, r => r[2]), aR = byAuthor(ridi, r => r[2]);
  const VOLUME_RE = /^(\d{1,2}|상|중|하|\d{1,2}권|제\d{1,2}권|[ⅰ-ⅹⅠ-Ⅹ]|i{1,3}|iv|v)$/;
  // 원서·대역·학습용 판 (한국어 번역본이 아님): '캉디드 Candide (영어 원서 읽기)' 같은 것
  const FOREIGN_RE = /원서|영문판|영어판|불어판|프랑스어판|독일어판|영한대역|대역판|클리프노트|영어\s*소설|오디오북'|원어민|프랑스어|독일어|스페인어|이탈리아어/;
  const LATIN_RE = /[A-Za-z]{4,}/; // 원제를 붙인 번역본도 많아서 빼지는 않고 뒤로만
  // 같은 저자 책 중에서 고르기: 제목이 같거나, 뒤에 부제가 붙었거나('캉디드 혹은 낙관주의'), 권 표시만 붙은 것('울프홀 1')
  // → 원서 판은 빼고, 가장 많이 읽힌 판 (권으로 나뉜 것만 있으면 가장 앞 권)
  const find = (idx, titles, names, authorOf, aIdx, titleOf, pop) => {
    const whole = new Set(), vols = [];
    for (const t of titles) for (const k of titleKeys(t)) for (const r of idx.get(k) || []) if (!names.length || sameAuthor(authorOf(r), names)) whole.add(r); // 작자 미상(춘향전 등)은 제목만으로
    const cands = names.flatMap(n => aIdx.get(sqz(n)) || []);
    for (const t of titles.slice(0, 1)) { // 부제·권 찾기는 대표 제목만 (aliases엔 저자 표기도 섞여 있음)
      const w = workKey(t);
      if (w.length < 2) continue;
      for (const r of cands) {
        const rw = workKey(titleOf(r));
        if (rw === w || !rw.startsWith(w)) continue;
        const rest = rw.slice(w.length);
        if (VOLUME_RE.test(rest)) vols.push([r, rest]);
        else if (!/^[\d0-9ⅰ-ⅹⅠ-Ⅹ]/.test(rest)) whole.add(r); // 숫자로 시작하면 다른 권·속편 (삼체 2: 암흑의 숲)
      }
    }
    const ko = (r) => !FOREIGN_RE.test(titleOf(r));
    const latin = (r) => LATIN_RE.test(titleOf(r)) ? 1 : 0;
    const best = [...whole].filter(ko).sort((x, y) => latin(x) - latin(y) || pop(y) - pop(x))[0];
    if (best) return best;
    return vols.filter(([r]) => ko(r)).sort((x, y) => (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : pop(y[0]) - pop(x[0])))[0]?.[0] || null;
  };
  const lists = {};
  for (const [key, name, level] of AWARD_META) {
    let items;
    try { items = JSON.parse(fs.readFileSync(path.join(AWARD_DIR, `${key}.json`), 'utf8')); } catch { continue; }
    lists[key] = { name, level, items: items.map(e => {
      const names = [e.a, ...(e.aliases || [])].filter(Boolean);
      if (!e.t && e.works) { // 작가 단위: 그 작가 책 수 (저자 키는 목록마다 한 번만 계산해 둔 것으로)
        const keys = names.map(sqz);
        const n = (ak) => { let c = 0; for (let i = 0; i < ak.fa.length; i++) if (sameAuthorKeys(ak.fa[i], ak.all[i], keys)) c++; return c; };
        return { ...e, author: true, counts: { crema: n(akC()), millie: n(akM()), libs: n(akL()), ridi: n(akR()) } };
      }
      const titles = [e.t, ...(e.aliases || [])].filter(Boolean); // aliases엔 다른 번역 제목·저자 표기가 섞여 있음
      if (!titles.length) return { ...e, cremaId: null, millieId: null, ridiId: null, libIds: {} };
      const cb = find(iC, titles, names, b => b.author, aC, b => b.title, b => b.reviews || 0), lb = find(iL, titles, names, m => m.author, aL, m => m.title, m => Object.keys(m.ids || {}).length), mr = find(iM, titles, names, r => r[2], aM, r => r[1], r => r[5] || 0), rr = find(iR, titles, names, r => r[2], aR, r => r[1], r => r[6] || 0);
      return { ...e, cremaId: cb?.bookId || (lb?.cremaId && !FOREIGN_RE.test(cremaById.get(lb.cremaId)?.title || '') && sameAuthor(cremaById.get(lb.cremaId)?.author, names) ? lb.cremaId : null), millieId: mr?.[0] || null, ridiId: rr?.[0] || null, libIds: lb?.ids || {} };
    }) };
  }
  awardsCache = { stamp, data: lists };
  return lists;
}
setTimeout(() => { try { buildAwards(); } catch {} }, 3000); // 서버 켤 때 미리 계산 (처음 열 때 기다리지 않게)
app.get('/api/awards', (req, res) => {
  try { res.json({ lists: buildAwards() }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/millie/data', (req, res) => {
  const d = loadMillie();
  const libs = loadLibs();
  res.json({ lastSync: d.lastSync || null, count: (d.books || []).length, changes: d.changes || null, running: millieJob.running, cremaToMillie: libs.cremaToMillie || {},
    books: d.books || [], millieMatch: libs.millieMatch || {} });
});

// ─── 리디셀렉트 ───
// 로그인 없이 쓰는 select-api: 최상위 카테고리(19개)를 인기순으로 끝까지 받으면 전체 목록 (약 7만 5천 권, 한 쪽 50권)
// 별점은 목록에 같이 옴(review_summary, 5점 만점). 브라우저 User-Agent가 없으면 Cloudflare가 막음.
// 줄: [id, 제목, 저자, 출판사, 카테고리, 별점, 평가 수, 카테고리 안 인기 순위]
const RIDI_FILE = path.join(__dirname, 'data-ridi.json');
const RIDI_API = 'https://select-api.ridibooks.com/api';
const RIDI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
function loadRidi() {
  try { return JSON.parse(fs.readFileSync(RIDI_FILE, 'utf8')); }
  catch { return { books: [] }; }
}
async function fetchRidiJson(url, retries = 3) {
  for (let i = 0; ; i++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': RIDI_UA, 'Accept': 'application/json' } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) {
      if (i >= retries) throw e;
      await new Promise(r => setTimeout(r, 3000 * (i + 1)));
    }
  }
}
const ridiRow = (b, cat, rank) => {
  const rs = b.review_summary || {};
  return [String(b.id), (b.title?.main || '').trim(), (b.authors?.author || []).map(a => a.name).join(', '), b.publisher?.name || '', cat,
    rs.buyer_rating_count ? Math.round(rs.buyer_rating_average * 100) / 100 : 0, rs.buyer_rating_count || 0, rank];
};
async function crawlRidi(onProgress) {
  const cats = (await fetchRidiJson(`${RIDI_API}/categories`)).map(c => [c.id, c.name]);
  const jobs = []; // [카테고리 id, 이름, 쪽]
  for (const [id, name] of cats) {
    const d = await fetchRidiJson(`${RIDI_API}/books?category=${id}&sort=popular&page=1&size=50`);
    for (let p = 1; p <= (d.total_page || 0); p++) jobs.push([id, name, p]);
  }
  const books = new Map();
  let done = 0, failed = 0;
  const queue = jobs.slice();
  await Promise.all(Array.from({ length: 2 }, async () => {
    for (let j; (j = queue.shift());) {
      const [id, name, p] = j;
      try {
        const d = await fetchRidiJson(`${RIDI_API}/books?category=${id}&sort=popular&page=${p}&size=50`);
        (d.books || []).forEach((b, i) => { if (b?.id && !books.has(String(b.id))) books.set(String(b.id), ridiRow(b, name, (p - 1) * 50 + i + 1)); });
      } catch (e) { failed++; console.error(`ridi ${id} p${p}:`, e.message); }
      if (++done % 50 === 0 || !queue.length) onProgress?.({ status: `리디셀렉트 ${done}/${jobs.length}쪽 · ${books.size.toLocaleString()}권`, phase: 'ridi', page: done, totalPages: jobs.length });
      await new Promise(r => setTimeout(r, 300));
    }
  }));
  return { books: [...books.values()], categories: cats.length, pages: jobs.length, failed };
}
// 이번 목록에 없는 책은 여러 권 조회(b_ids, 300권씩)로 확인: 응답에 없으면 셀렉트에서 빠진 것 → 지움, 있으면 남김.
// 조회가 실패하면 확인 못 함 → 남김. 그래도 받은 권수가 이전보다 5% 넘게 줄면 사이트 이상으로 보고 아무것도 지우지 않음.
async function reconcileRidi(prev, rows, onProgress) {
  const now = new Date().toISOString();
  const prevBooks = prev.books || [];
  const ids = new Set(rows.map(r => r[0])), prevIds = new Set(prevBooks.map(r => r[0]));
  const added = rows.filter(r => !prevIds.has(r[0]));
  const gone = prevBooks.filter(r => !ids.has(r[0]));
  const state = new Map(), fresh = new Map();
  for (let i = 0; i < gone.length; i += 300) {
    const chunk = gone.slice(i, i + 300);
    try {
      const got = await fetchRidiJson(`${RIDI_API}/books?b_ids=${chunk.map(r => r[0]).join(',')}`);
      if (!Array.isArray(got)) throw new Error('응답 형식');
      const found = new Map(got.map(b => [String(b.id), b]));
      for (const r of chunk) { const b = found.get(r[0]); state.set(r[0], b ? 'exists' : 'gone'); if (b) fresh.set(r[0], ridiRow(b, r[4], r[7])); }
    } catch (e) { console.error('ridi verify:', e.message); }
    onProgress?.({ status: `리디셀렉트: 목록에서 빠진 책 확인 ${Math.min(i + 300, gone.length).toLocaleString()}/${gone.length.toLocaleString()}`, phase: 'ridi' });
    await new Promise(r => setTimeout(r, 300));
  }
  let warning = null;
  if (prevBooks.length && rows.length < prevBooks.length * 0.95) warning = 'drop';
  const removed = warning ? [] : gone.filter(r => state.get(r[0]) === 'gone');
  const kept = gone.filter(r => state.get(r[0]) === 'exists').map(r => fresh.get(r[0]) || r);
  const unknown = gone.filter(r => !state.has(r[0]) || (warning && state.get(r[0]) === 'gone'));
  const S = 50, pair = r => [r[0], r[1]];
  const changes = { at: now, prev: prevBooks.length, received: rows.length, added: added.length, removed: removed.length, kept: kept.length, unknown: unknown.length, warning,
    addedSample: added.slice(0, S).map(pair), removedSample: removed.slice(0, S).map(pair), keptSample: kept.slice(0, S).map(pair), unknownSample: unknown.slice(0, S).map(pair) };
  return { books: [...rows, ...kept, ...unknown], changes };
}
let ridiFinder = null;
function findRidi(title, author) {
  if (!ridiFinder) {
    const rows = loadRidi().books || [];
    ridiFinder = buildTitleIndex(rows.map(([id, title, author]) => ({ id, title, author })));
  }
  return ridiFinder(title, author)?.id || null;
}
const ridiJob = { running: false, status: null, listeners: new Set() };
async function runRidiJob() {
  ridiJob.running = true;
  const send = (o) => { if (o.status) ridiJob.status = o.status; for (const l of ridiJob.listeners) l(o); };
  try {
    send({ status: '리디셀렉트 카테고리 받는 중...', phase: 'ridi', page: 0, totalPages: 1 });
    const r = await crawlRidi(send);
    if (!r.books.length) throw new Error('받은 책이 없습니다');
    const m = await reconcileRidi(loadRidi(), r.books, send);
    m.changes.failedPages = r.failed;
    fs.writeFileSync(RIDI_FILE, JSON.stringify({ lastSync: new Date().toISOString(), categories: r.categories, failed: r.failed, books: m.books, changes: m.changes }));
    ridiFinder = null;
    send({ status: '매칭 중...', phase: 'match' });
    rebuildLibMatch();
    const c = m.changes;
    send({ status: `완료! 리디셀렉트 ${m.books.length.toLocaleString()}권 (새 책 ${c.added} · 빠진 책 ${c.removed} · 남김 ${c.kept + c.unknown}${r.failed ? ` · 실패한 쪽 ${r.failed}` : ''})` });
    send({ done: true });
  } catch (e) {
    send({ error: e.message });
  } finally {
    ridiJob.running = false;
    ridiJob.listeners.clear();
  }
}
app.get('/api/ridi/sync', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (obj) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {}
    if (obj.done || obj.error) res.end();
  };
  ridiJob.listeners.add(send);
  res.on('close', () => ridiJob.listeners.delete(send));
  if (ridiJob.running) send({ status: '이미 진행 중인 동기화에 연결됨 · ' + (ridiJob.status || ''), phase: 'ridi' });
  else runRidiJob();
});
app.get('/api/ridi/data', (req, res) => {
  const d = loadRidi();
  const libs = loadLibs();
  res.json({ lastSync: d.lastSync || null, count: (d.books || []).length, changes: d.changes || null, running: ridiJob.running,
    cremaToRidi: libs.cremaToRidi || {}, millieToRidi: libs.millieToRidi || {},
    books: d.books || [], ridiMatch: libs.ridiMatch || {} });
});

// ─── Seoul elib ───
const SEOUL_FILE = path.join(__dirname, 'data-seoul.json');
function loadSeoul() {
  try { return JSON.parse(fs.readFileSync(SEOUL_FILE, 'utf8')); }
  catch { return { books: [], lastSync: null }; }
}
function saveSeoul(d) { fs.writeFileSync(SEOUL_FILE, JSON.stringify(d, null, 2)); }

const ELIB_BASE = 'https://elib.seoul.go.kr';
const ELIB_HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  'Referer': 'https://elib.seoul.go.kr/contents/list?t=EB',
  'X-Requested-With': 'XMLHttpRequest',
};

async function fetchElibCategories() {
  const resp = await fetch(`${ELIB_BASE}/api/category/main?contentType=EB`, { headers: ELIB_HEADERS });
  const data = await resp.json();
  return data.ContentDataList || [];
}

async function fetchElibCategoryBooks(majorCategory, pageCount = 50, currentCount = 1) {
  const url = `${ELIB_BASE}/api/contents/catesearch?majorCategory=${majorCategory}&subCategory=&libCode=&innerKeyword=&orderOption=1&loanable=&currentCount=${currentCount}&pageCount=${pageCount}`;
  const resp = await fetch(url, { headers: ELIB_HEADERS });
  return await resp.json();
}

// 서울도서관 전자도서관 전체 크롤링 (도서관 동기화 작업의 한 도서관으로 실행됨)
async function crawlSeoulElib(onProgress) {
  const categories = await fetchElibCategories();
  if (!categories.length) throw new Error('카테고리를 찾지 못함');
  const allBooks = [];
  const seen = new Set();
  let failed = 0; // 끝내 못 받은 페이지 수 (있으면 '다 받지 못함' → 없어진 책을 지우지 않음)
  for (let i = 0; i < categories.length; i++) {
    const cat = categories[i];
    let currentCount = 1, knownPages = 0;
    while (true) {
      let result;
      for (let t = 0; t < 3 && !result; t++) {
        try { result = await fetchElibCategoryBooks(cat.categoryNo, 50, currentCount); }
        catch (e) {
          console.error(`Seoul cat ${cat.categoryNo} p${currentCount} failed (${t + 1}/3):`, e.message);
          await new Promise(r => setTimeout(r, 3000 * (t + 1)));
        }
      }
      if (!result) {
        failed++;
        if (knownPages && currentCount < knownPages) { currentCount++; continue; } // 그 페이지만 건너뜀
        break;
      }
      knownPages = result.totalPage || Math.ceil((result.totalCount || 0) / 50);
      const items = result.ContentDataList || [];
      if (items.length === 0) break;
      for (const item of items) {
        if (seen.has(item.contentsKey)) continue;
        seen.add(item.contentsKey);
        allBooks.push({
          id: item.contentsKey,
          title: (item.title || '').trim(),
          author: (item.author || '').trim(),
          publisher: (item.publisher || '').trim(),
          cover: item.coverMSizeUrl || item.coverUrl || '',
          type: item.contentsTypeDesc || '',
          typeCode: item.contentsType || '',
          loanable: item.loanYN === 'Y',
          loanCnt: item.loanCnt || 0,
          recommendCnt: item.recommendCnt || 0,
          isbn: item.isbn || '',
          genre: cat.categoryName,
          ownerCode: item.ownerCode || '',
        });
      }
      onProgress?.({ page: i + (currentCount / (result.totalPage || 1)), totalPages: categories.length, count: allBooks.length });
      const totalPage = result.totalPage || Math.ceil((result.totalCount || 0) / 50);
      if (currentCount >= totalPage) break;
      currentCount++;
      await new Promise(r => setTimeout(r, 600));
    }
  }
  return { books: allBooks, failed };
}

// 서울도서관 결과 저장 + 크레마와 매칭 (없어진 책 처리 규칙은 retention.js)
function saveSeoulCrawl(crawled, failed) {
  const prev = loadSeoul();
  const rc = reconcile(prev.books || [], crawled, { idOf: b => b.id, titleOf: b => b.title, complete: !failed, prevMissing: prev.missing });
  const books = rc.items;
  const cremaData = loadData();
  const crossMatch = buildCrossMatch(books, cremaData.books || []);
  saveSeoul({ books, lastSync: new Date().toISOString(), crossMatch, missing: rc.missing, changes: rc.changes, failedPages: failed });
  return rc.changes;
  if ((cremaData.books || []).length > 0) {
    cremaData.seoulMatch = crossMatch.cremaToSeoul;
    saveData(cremaData);
  }
}

function buildCrossMatch(seoulBooks, cremaBooks) {
  const seoulToCrema = {}; // seoulId -> cremaBookId
  const cremaToSeoul = {}; // cremaBookId -> seoulId

  const findCremaByTitle = buildTitleIndex(cremaBooks);

  for (const sb of seoulBooks) {
    const matched = findCremaByTitle(sb.title, sb.author || '');
    if (matched) {
      seoulToCrema[sb.id] = matched.bookId;
      cremaToSeoul[matched.bookId] = sb.id;
    }
  }

  return { seoulToCrema, cremaToSeoul };
}

app.get('/api/seoul/data', (req, res) => {
  const full = loadSeoul();
  // Send slim version - strip large fields
  const books = (full.books || []).map(b => ({
    id: b.id,
    title: b.title,
    author: b.author,
    publisher: b.publisher,
    cover: b.cover,
    type: b.type,
    typeCode: b.typeCode,
    loanCnt: b.loanCnt,
    recommendCnt: b.recommendCnt,
    genre: b.genre,
    ownerCode: b.ownerCode,
  }));
  res.json({
    books,
    lastSync: full.lastSync,
    crossMatch: full.crossMatch || {},
  });
});


// ─── 구립 전자도서관 ───
const LIBS_FILE = path.join(__dirname, 'data-libs.json');
function loadLibs() {
  try { return JSON.parse(fs.readFileSync(LIBS_FILE, 'utf8')); }
  catch { return { libs: {}, books: {}, cremaToLibs: {} }; }
}
function saveLibs(d) { fs.writeFileSync(LIBS_FILE, JSON.stringify(d)); }

// 크레마 책 → 소장 구립도서관 key 목록 + 도서관별 책 ID (제목 매칭)
function buildLibMatch(libsData, cremaBooks) {
  const findCremaByTitle = buildTitleIndex(cremaBooks);
  const cremaToLibs = {};
  const cremaLibIds = {}; // bookId → { libKey: 도서관의 책 ID } (상세 페이지 링크용)
  for (const [key, rows] of Object.entries(libsData.books || {})) {
    for (const [id, title, author] of rows) {
      const cb = findCremaByTitle(title, author || '');
      if (!cb) continue;
      const list = (cremaToLibs[cb.bookId] ||= []);
      if (!list.includes(key)) list.push(key);
      (cremaLibIds[cb.bookId] ||= {})[key] ??= id;
    }
  }
  return { cremaToLibs, cremaLibIds };
}

// 모든 도서관(구립 + 서울도서관) 책을 하나로 합친 통합 목록.
// 같은 책 = 판본 표시를 뗀 제목(workKey) + 첫 저자 키가 같음. 각 항목에 소장 도서관과 도서관별 책 ID를 기록한다.
function buildMergedCatalog(libsData, seoulBooks, cremaBooks) {
  const groups = new Map();
  const add = (libKey, id, title, author, publisher, isbn) => {
    const key = workKey(title) + '|' + authorKey(author);
    let e = groups.get(key);
    if (!e) groups.set(key, e = { title, author, publisher, isbn: '', ids: {} });
    else if (title.length < e.title.length) e.title = title; // 판본이 여럿이면 가장 짧은(꾸밈 없는) 제목으로
    e.ids[libKey] ??= id;
    if (isbn && !e.isbn) e.isbn = isbn;
  };
  for (const [key, rows] of Object.entries(libsData.books || {})) {
    for (const [id, title, author, publisher, isbn] of rows) add(key, id, title, author, publisher, isbn);
  }
  for (const b of seoulBooks) add('seoul', b.id, b.title, b.author, b.publisher, b.isbn);

  const findCremaByTitle = buildTitleIndex(cremaBooks);
  return [...groups.values()].map(e => ({
    ...e,
    libs: Object.keys(e.ids),
    cremaId: findCremaByTitle(e.title, e.author || '')?.bookId || null,
  }));
}

function rebuildLibMatch() {
  const libsData = loadLibs();
  const cremaBooks = loadData().books || [];
  // 크레마 bookId → 밀리 책 ID
  libsData.cremaToMillie = {};
  for (const b of cremaBooks) { const m = findMillie(b.title, b.author || ''); if (m) libsData.cremaToMillie[b.bookId] = m; }
  // 크레마 bookId → 리디셀렉트 책 ID, 밀리 책 ID → 리디셀렉트 책 ID
  libsData.cremaToRidi = {};
  for (const b of cremaBooks) { const r = findRidi(b.title, b.author || ''); if (r) libsData.cremaToRidi[b.bookId] = r; }
  libsData.millieToRidi = {};
  for (const [id, title, author] of loadMillie().books || []) { const r = findRidi(title, author || ''); if (r) libsData.millieToRidi[id] = r; }
  if (!Object.keys(libsData.books || {}).length) { saveLibs(libsData); return rematchBestsellers(); }
  Object.assign(libsData, buildLibMatch(libsData, cremaBooks));
  libsData.merged = buildMergedCatalog(libsData, loadSeoul().books || [], cremaBooks);
  for (const e of libsData.merged) { const m = findMillie(e.title, e.author || ''); if (m) e.millieId = m; const r = findRidi(e.title, e.author || ''); if (r) e.ridiId = r; }
  // 밀리 책 → 크레마 bookId / 소장 도서관 (밀리 탭용)
  const findCrema = buildTitleIndex(cremaBooks);
  const findMerged = buildTitleIndex(libsData.merged);
  libsData.millieMatch = {};
  for (const [id, title, author] of loadMillie().books || []) {
    const c = findCrema(title, author || '')?.bookId || null;
    const ids = findMerged(title, author || '')?.ids || {};
    if (c || Object.keys(ids).length) libsData.millieMatch[id] = { cremaId: c, libIds: ids };
  }
  // 리디 책 → 크레마 bookId / 밀리 책 ID / 소장 도서관 (리디 탭용)
  const findMillieRow = buildTitleIndex((loadMillie().books || []).map(([id, title, author]) => ({ id, title, author })));
  libsData.ridiMatch = {};
  for (const [id, title, author] of loadRidi().books || []) {
    const c = findCrema(title, author || '')?.bookId || null;
    const m = findMillieRow(title, author || '')?.id || null;
    const ids = findMerged(title, author || '')?.ids || {};
    if (c || m || Object.keys(ids).length) libsData.ridiMatch[id] = { cremaId: c, millieId: m, libIds: ids };
  }
  saveLibs(libsData);
  console.log(`Lib match: crema ${Object.keys(libsData.cremaToLibs).length}, merged ${libsData.merged.length}, millie↔crema ${Object.keys(libsData.cremaToMillie).length}`);
  favIndex = null; // 즐겨찾기 조회용 색인도 새로
  rematchBestsellers();
}

// 24곳 전체 크롤링은 30분 이상 걸리므로 브라우저 연결과 분리된 백그라운드 작업으로 돌린다.
// /api/libs/sync는 작업이 없으면 시작하고, 있으면 진행 상황만 구독한다. 연결을 끊어도 작업은 계속된다.
const libJob = { running: false, state: {}, listeners: new Set() };

function libJobSnapshot() {
  const states = Object.values(libJob.state);
  const done = states.filter(s => s.done).length;
  const active = states.filter(s => !s.done && s.totalPages)
    .sort((a, b) => (b.totalPages - b.page) - (a.totalPages - a.page))
    .slice(0, 3)
    .map(s => `${s.name} ${s.page}/${s.totalPages}`);
  return {
    status: `구립도서관 ${done}/${states.length}곳 완료` + (active.length ? ` · 진행 중: ${active.join(', ')}` : ''),
    phase: 'libs',
    // 진행률: 도서관별 페이지 진행률의 평균
    page: states.reduce((sum, s) => sum + (s.done ? 1 : s.totalPages ? s.page / s.totalPages : 0), 0),
    totalPages: states.length,
  };
}

function libJobBroadcast(obj) {
  for (const send of libJob.listeners) send(obj);
}

// 서울도서관은 구립도서관과 같은 작업에서 함께 받는다 (key 'seoul')
const SEOUL_LIB = { key: 'seoul', name: '서울도서관' };

async function runLibJob(libs = [SEOUL_LIB, ...LIBRARIES]) {
  libJob.running = true;
  libJob.state = Object.fromEntries(libs.map(l => [l.key, { name: l.name, page: 0, totalPages: 0, done: false }]));
  const ticker = setInterval(() => libJobBroadcast(libJobSnapshot()), 1000);
  const errors = [];
  try {
    // 도서관마다 서버가 달라서 동시에 돌린다 (각 도서관 안에서는 순차 + 지연)
    await Promise.all(libs.map(async (lib) => {
      const st = libJob.state[lib.key];
      try {
        if (lib.key === 'seoul') {
          const r = await crawlSeoulElib((p) => Object.assign(st, p));
          if (!r.books.length) throw new Error('받은 책이 없음');
          const ch = saveSeoulCrawl(r.books, r.failed);
          const d = loadLibs();
          d.libs.seoul = { name: lib.name, count: r.books.length, total: r.books.length, failedPages: r.failed, lastSync: new Date().toISOString(), changes: ch };
          saveLibs(d);
          console.log(`[${lib.name}] ${r.books.length} books (failed pages: ${r.failed}, +${ch.added} -${ch.removed} 남김 ${ch.kept})`);
          return;
        }
        const r = await crawlLibrary(lib, { onProgress: (p) => Object.assign(st, p) });
        // 도서관 하나 끝날 때마다 저장 (다른 도서관 데이터는 유지)
        const d = loadLibs();
        // 없어진 책 처리 규칙은 retention.js (실패한 페이지가 있으면 지우지 않음)
        const rows = r.books.map(b => [b.id, b.title, b.author, b.publisher, b.isbn || '']);
        d.missing ||= {};
        const rc = reconcile(d.books[lib.key] || [], rows, { idOf: x => x[0], titleOf: x => x[1], complete: !r.failed, prevMissing: d.missing[lib.key] });
        d.books[lib.key] = rc.items;
        d.missing[lib.key] = rc.missing;
        d.libs[lib.key] = { name: lib.name, base: lib.base, platform: lib.platform, total: r.total, count: rc.items.length, received: r.books.length, failedPages: r.failed, lastSync: new Date().toISOString(), changes: rc.changes };
        saveLibs(d);
        console.log(`[${lib.name}] ${r.books.length}/${r.total} books (failed pages: ${r.failed}, +${rc.changes.added} -${rc.changes.removed} 남김 ${rc.changes.kept})`);
      } catch (e) {
        console.error(`[${lib.name}] failed:`, e.message);
        errors.push(`${lib.name}: ${e.message}`);
        const d = loadLibs();
        d.libs[lib.key] = { ...(d.libs[lib.key] || { name: lib.name, base: lib.base, platform: lib.platform }), error: e.message, errorAt: new Date().toISOString() };
        saveLibs(d);
      } finally {
        st.done = true;
      }
    }));

    libJobBroadcast({ status: '크레마클럽 매칭 중...', phase: 'match' });
    rebuildLibMatch();
    const matched = Object.keys(loadLibs().cremaToLibs || {}).length;
    const errNote = errors.length ? ` (실패 ${errors.length}곳: ${errors.join(' / ')})` : '';
    libJobBroadcast({ status: `완료! 크레마 ${matched.toLocaleString()}권이 구립도서관에 있음${errNote}` });
    libJobBroadcast({ done: true });
  } catch (e) {
    libJobBroadcast({ error: e.message });
  } finally {
    clearInterval(ticker);
    libJob.running = false;
    libJob.listeners.clear();
  }
}

app.get('/api/libs/sync', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (obj) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {}
    if (obj.done || obj.error) res.end();
  };
  libJob.listeners.add(send);
  res.on('close', () => libJob.listeners.delete(send));
  if (libJob.running) send({ ...libJobSnapshot(), status: '이미 진행 중인 동기화에 연결됨 · ' + libJobSnapshot().status });
  else {
    // ?keys=jongno,guro 또는 ?platform=kyobo 로 일부 도서관만 다시 받을 수 있음
    const keys = (req.query.keys || '').split(',').filter(Boolean);
    const libs = [SEOUL_LIB, ...LIBRARIES].filter(l => (!keys.length || keys.includes(l.key)) && (!req.query.platform || l.platform === req.query.platform));
    send({ status: `구립도서관 동기화 시작... (${libs.length}곳)`, phase: 'libs', page: 0, totalPages: libs.length });
    runLibJob(libs);
  }
});

app.get('/api/libs/data', (req, res) => {
  const d = loadLibs();
  const seoul = loadSeoul();
  const libs = [
    { key: 'seoul', name: '서울도서관', base: 'https://elib.seoul.go.kr', detail: 'https://elib.seoul.go.kr/contents/detail.do?no={id}',
      count: (seoul.books || []).length, total: (seoul.books || []).length, lastSync: seoul.lastSync, failedPages: seoul.failedPages || 0, changes: seoul.changes || null, ...(d.libs.seoul?.error ? { error: d.libs.seoul.error, errorAt: d.libs.seoul.errorAt } : {}) },
    ...LIBRARIES.map(l => ({ key: l.key, name: l.name, base: l.base, detail: detailUrlTemplate(l), ...(l.group ? { group: l.group } : {}), ...(d.libs[l.key] || {}) })),
  ];
  res.json({ libs, cremaToLibs: d.cremaToLibs || {}, cremaLibIds: d.cremaLibIds || {}, running: libJob.running, status: libJob.running ? libJobSnapshot().status : null });
});

// 도서관 통합 목록 (크기가 커서 /api/libs/data와 분리)
app.get('/api/libs/merged', (req, res) => {
  res.json({ merged: loadLibs().merged || [] });
});

// 매칭 로직이 바뀌었을 수 있으니 시작할 때 크레마·통합 매칭을 다시 만든다 (수 초)
rebuildLibMatch();

// 끌 때 십진분류 조회 결과 저장 (자동 동기화가 끝나고 서버를 끌 때)
process.on('SIGINT', () => { try { saveKdc(true); } finally { process.exit(0); } });

app.listen(PORT, () => {
  console.log(`\n  전자책 검색`);
  console.log(`  http://localhost:${PORT}\n`);
});
