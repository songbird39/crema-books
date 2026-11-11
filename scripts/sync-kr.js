// 해외 IP를 막는 도서관만 받기 (Mac의 self-hosted runner에서 실행) → kr-libs.json
// 메인 동기화(sync.js)가 이 파일을 data-libs.json에 합친다.
// 사용: KR_LIBS=seongdong,seongbuk node scripts/sync-kr.js
const fs = require('fs');
const path = require('path');
const { LIBRARIES, crawlLibrary } = require('../libraries');
const report = require('./report');
const { reconcile } = require('../retention');
const keys = (process.env.KR_LIBS || '').split(',').filter(Boolean);
const OUT = path.join(__dirname, '..', 'kr-libs.json');
(async () => {
  const t0 = Date.now();
  const runId = await report.start('sync-kr', 'full', { libs: keys });
  const results = {};
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { libs: {}, books: {} };
  let fail = 0;
  await Promise.all(LIBRARIES.filter(l => keys.includes(l.key)).map(async (lib) => {
    try {
      const r = await crawlLibrary(lib);
      if (r.failed > r.books.length / 10) throw new Error(`실패한 페이지가 너무 많음 (${r.failed})`);
      // 없어진 책 처리 규칙은 retention.js (메인 동기화와 같음)
      const rows = r.books.map(b => [b.id, b.title, b.author, b.publisher, b.isbn || '']);
      prev.missing ||= {};
      const rc = reconcile(prev.books[lib.key] || [], rows, { idOf: x => x[0], titleOf: x => x[1], complete: !r.failed, prevMissing: prev.missing[lib.key] });
      prev.books[lib.key] = rc.items;
      prev.missing[lib.key] = rc.missing;
      prev.libs[lib.key] = { name: lib.name, base: lib.base, platform: lib.platform, total: r.total, count: rc.items.length, received: r.books.length, failedPages: r.failed, lastSync: new Date().toISOString(), changes: rc.changes };
      results[lib.key] = { name: lib.name, ok: true, count: rc.items.length, total: r.total, failedPages: r.failed, changes: rc.changes };
      console.log(`[${lib.name}] ${r.books.length}/${r.total}`);
    } catch (e) { fail++; results[lib.key] = { name: lib.name, ok: false, error: e.message }; console.error(`[${lib.name}] 실패: ${e.message}`); }
  }));
  fs.writeFileSync(OUT, JSON.stringify(prev));
  await report.finish(runId, !fail ? 'success' : fail === keys.length ? 'failed' : 'partial', { libs: keys, results, ms: Date.now() - t0 });
  if (fail === keys.length) process.exit(1);
})();
