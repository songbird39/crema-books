const { LIBRARIES, PLATFORMS, fetchPage } = require('./libraries');
const H = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept-Language': 'ko-KR,ko;q=0.9' };
const others = [
  ['크레마클럽', 'https://cremaclub.yes24.com/BookClub/Category?dispNo=017001&order=TITLE&pageNo=1&pageSize=20', 'text/html', t => /totalCnt/.test(t)],
  ['YES24 베스트', 'https://www.yes24.com/Product/Category/BestSeller?pageNumber=1&pageSize=24', 'text/html', t => t.length > 5000],
  ['알라딘 베스트', 'https://www.aladin.co.kr/shop/common/wbest.aspx?BestType=Bestseller&BranchType=1&CID=0&page=1&cnt=50&SortOrder=1', 'text/html', t => t.length > 5000],
  ['밀리', 'https://apis.millie.co.kr/public/content/search/category/?category_seq=1194', 'application/json', t => /sub_categories/.test(t)],
  ['서울도서관', 'https://elib.seoul.go.kr/api/category/main?contentType=EB', 'application/json', t => /ContentDataList/.test(t)],
  ['국립중앙도서관', 'https://www.nl.go.kr/NL/search/openApi/search.do?key=x&apiType=json&kwd=test', 'application/json', t => t.length > 0],
];
(async () => {
  const rows = await Promise.all([
    ...others.map(async ([name, url, accept, ok]) => {
      const t0 = Date.now();
      try {
        const r = await fetch(url, { headers: { ...H, Accept: accept, Referer: 'https://elib.seoul.go.kr/' }, signal: AbortSignal.timeout(30000) });
        const t = await r.text();
        return [name, r.ok && ok(t) ? 'OK' : `FAIL HTTP ${r.status} len ${t.length}`, Date.now() - t0];
      } catch (e) { return [name, 'FAIL ' + (e.cause?.code || e.message), Date.now() - t0]; }
    }),
    ...LIBRARIES.map(async lib => {
      const t0 = Date.now(); const p = PLATFORMS[lib.platform];
      try { const b = await fetchPage(lib, p, 1); const n = p.total(b); return [lib.name + ' (' + lib.platform + ')', n ? 'OK ' + n : 'FAIL total=0', Date.now() - t0]; }
      catch (e) { return [lib.name + ' (' + lib.platform + ')', 'FAIL ' + (e.code || e.message), Date.now() - t0]; }
    }),
  ]);
  for (const [n, s, ms] of rows) console.log(`${s.startsWith('OK') ? '✅' : '❌'} ${n}: ${s} (${ms}ms)`);
  console.log(`\n${rows.filter(r => r[1].startsWith('OK')).length}/${rows.length} OK`);
})();
