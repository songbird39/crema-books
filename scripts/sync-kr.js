// 해외 IP를 막는 도서관만 받기 (Mac의 self-hosted runner에서 실행) → kr-libs.json
// KR_RIDI=1 이면 리디셀렉트도 (서버를 띄워 /api/ridi/sync) → kr-ridi.json
// 메인 동기화(sync.js)가 이 파일을 data-libs.json에 합친다.
// 사용: KR_LIBS=seongdong,seongbuk node scripts/sync-kr.js
const fs = require('fs');
const path = require('path');
const { LIBRARIES, crawlLibrary } = require('../libraries');
const report = require('./report');
const { reconcile } = require('../retention');
// 나눠 받기: 요일(한국 시간)마다 일부만 → 일주일에 한 바퀴. KR_DAY=all 이면 전부, 0~6이면 그 요일 몫
const DAYS = 7;
const DAY = process.env.KR_DAY === 'all' ? null : process.env.KR_DAY ? +process.env.KR_DAY : new Date(Date.now() + 9 * 3600e3).getUTCDay();
const allKeys = (process.env.KR_LIBS || '').split(',').filter(Boolean);
// 도서관은 이틀에 한 곳씩 (4곳: 일·화·목·토)
const keys = DAY == null ? allKeys : allKeys.filter((_, i) => (i * 2) % DAYS === DAY);
const ridiQuery = DAY == null ? '' : `?part=${DAY}&parts=${DAYS}`;
const OUT = path.join(__dirname, '..', 'kr-libs.json');
(async () => {
  const t0 = Date.now();
  console.log(`오늘 몫: ${DAY == null ? '전부' : '요일 ' + DAY} · 도서관 ${keys.join(',') || '없음'} · 리디 ${ridiQuery || '전부'}`);
  const runId = await report.start('sync-kr', DAY == null ? 'full' : 'part', { libs: keys, day: DAY });
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
  if (process.env.KR_RIDI === '1') {
    try { results.ridi = { name: '리디셀렉트', ...(await syncRidi()) }; console.log(`[리디셀렉트] ${results.ridi.count}권`); }
    catch (e) { fail++; results.ridi = { name: '리디셀렉트', ok: false, error: e.message }; console.error(`[리디셀렉트] 실패: ${e.message}`); }
  }
  await report.finish(runId, !fail ? 'success' : fail === keys.length + (process.env.KR_RIDI === '1' ? 1 : 0) ? 'failed' : 'partial', { libs: keys, results, ms: Date.now() - t0 });
  if (fail && fail === keys.length + (process.env.KR_RIDI === '1' ? 1 : 0)) process.exit(1);
  process.exit(0);
})();

// 리디셀렉트: 이전 결과(kr-ridi.json)를 data-ridi.json으로 두고 서버의 동기화를 그대로 돌림 (없어진 책 확인 규칙 같음)
async function syncRidi() {
  const { spawn } = require('child_process');
  const ROOT = path.join(__dirname, '..'), KF = path.join(ROOT, 'kr-ridi.json'), RF = path.join(ROOT, 'data-ridi.json');
  if (fs.existsSync(KF)) fs.copyFileSync(KF, RF);
  const PORT = 3457, BASE = `http://localhost:${PORT}`;
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(BASE + '/api/ridi/data')).ok) break; } catch {}
      if (i > 120) throw new Error('서버가 켜지지 않음');
      await new Promise(r => setTimeout(r, 1000));
    }
    const r = await fetch(BASE + '/api/ridi/sync' + ridiQuery);
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '', ok = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!line.startsWith('data: ')) continue;
        const m = JSON.parse(line.slice(6));
        if (m.error) throw new Error(m.error);
        if (m.done) ok = true;
      }
      if (ok) break;
    }
    if (!ok) throw new Error('연결이 끊김');
    const d = JSON.parse(fs.readFileSync(RF, 'utf8'));
    fs.copyFileSync(RF, KF);
    return { ok: true, count: d.books.length, changes: d.changes };
  } finally { server.kill(); }
}
