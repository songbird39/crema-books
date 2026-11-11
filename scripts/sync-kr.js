// 해외 IP를 막는 도서관만 받기 (Mac의 self-hosted runner에서 실행) → kr-libs.json
// 메인 동기화(sync.js)가 이 파일을 data-libs.json에 합친다.
// 사용: KR_LIBS=seongdong,seongbuk node scripts/sync-kr.js
const fs = require('fs');
const path = require('path');
const { LIBRARIES, crawlLibrary } = require('../libraries');
const keys = (process.env.KR_LIBS || '').split(',').filter(Boolean);
const OUT = path.join(__dirname, '..', 'kr-libs.json');
(async () => {
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { libs: {}, books: {} };
  let fail = 0;
  await Promise.all(LIBRARIES.filter(l => keys.includes(l.key)).map(async (lib) => {
    try {
      const r = await crawlLibrary(lib);
      if (r.failed > r.books.length / 10) throw new Error(`실패한 페이지가 너무 많음 (${r.failed})`);
      prev.books[lib.key] = r.books.map(b => [b.id, b.title, b.author, b.publisher, b.isbn || '']);
      prev.libs[lib.key] = { name: lib.name, base: lib.base, platform: lib.platform, total: r.total, count: r.books.length, failedPages: r.failed, lastSync: new Date().toISOString() };
      console.log(`[${lib.name}] ${r.books.length}/${r.total}`);
    } catch (e) { fail++; console.error(`[${lib.name}] 실패: ${e.message}`); }
  }));
  fs.writeFileSync(OUT, JSON.stringify(prev));
  if (fail === keys.length) process.exit(1);
})();
