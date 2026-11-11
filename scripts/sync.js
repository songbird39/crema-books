// GitHub Actions용 자동 동기화: 서버를 띄우고 화면의 동기화 버튼과 같은 API를 차례로 부른 뒤 site/로 내보낸다.
// 환경 변수
//   MODE=full|export   full: 크롤링 후 내보내기 (기본), export: 지금 데이터로 내보내기만
//   MILLIE=1           밀리의 서재도 받기 (2시간 넘게 걸려서 주 1회). 비우면 일요일(KST)에만
//   SKIP_LIBS=a,b      해외 IP를 막는 도서관 (kr-libs.json으로 따로 받음)
//   NL_API_KEY         국립중앙도서관 키 (십진분류)
//   KDC_MINUTES=60     십진분류 조회를 기다리는 최대 시간
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3456;
const BASE = `http://localhost:${PORT}`;
const MODE = process.env.MODE || 'full';
const SKIP = (process.env.SKIP_LIBS || '').split(',').filter(Boolean);
const kstDay = new Date(Date.now() + 9 * 3600e3).getUTCDay();
const MILLIE = process.env.MILLIE ? process.env.MILLIE === '1' || process.env.MILLIE === 'true' : kstDay === 0;
const report = require('./report');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Mac에서 받은 도서관(kr-libs.json)을 data-libs.json에 합침 (서버가 켜질 때 매칭을 다시 만든다)
function mergeKrLibs() {
  const kf = path.join(ROOT, 'kr-libs.json'), lf = path.join(ROOT, 'data-libs.json');
  if (!fs.existsSync(kf) || !fs.existsSync(lf)) return 0;
  const kr = JSON.parse(fs.readFileSync(kf, 'utf8')), libs = JSON.parse(fs.readFileSync(lf, 'utf8'));
  let n = 0;
  for (const [key, meta] of Object.entries(kr.libs || {})) {
    if (!kr.books?.[key]?.length) continue;
    if (libs.libs[key]?.lastSync && !libs.libs[key].error && libs.libs[key].lastSync >= meta.lastSync) continue;
    libs.books[key] = kr.books[key];
    libs.libs[key] = meta;
    n++;
  }
  if (n) { fs.writeFileSync(lf, JSON.stringify(libs)); log(`Mac에서 받은 도서관 ${n}곳 합침`); }
  return n;
}

// SSE 동기화 API를 끝날 때까지 읽음 → { ok, status }
async function runSse(url, label) {
  log(`▶ ${label}`);
  const r = await fetch(BASE + url);
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '', last = 0, lastStatus = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (!line.startsWith('data: ')) continue;
      const m = JSON.parse(line.slice(6));
      if (m.error) { log(`✗ ${label}: ${m.error}`); return { ok: false, status: m.error }; }
      if (m.status) lastStatus = m.status;
      if (m.done) { log(`✓ ${label}: ${lastStatus}`); return { ok: true, status: lastStatus }; }
      if (Date.now() - last > 60000) { last = Date.now(); log(`  ${lastStatus}`); }
    }
  }
  log(`? ${label}: 연결이 끊김 (${lastStatus})`);
  return { ok: false, status: '연결이 끊김 · ' + lastStatus };
}

// 데이터 현황 (동기화 전후 비교용)
async function snapshot() {
  const get = async (p) => (await fetch(BASE + p)).json();
  const [d, l, m, k] = await Promise.all([get('/api/data'), get('/api/libs/data'), get('/api/millie/data'), get('/api/kdc')]);
  return {
    crema: { count: d.books?.length || 0, lastSync: d.lastSync || null, lastCrawl: d.lastCremaCrawl || null, changes: d.cremaChanges || null },
    bestsellers: { lists: Object.fromEntries(Object.entries(d.bestsellerLists || {}).map(([k, v]) => [k, v.length])), lastSync: d.bestsellerSync || null },
    millie: { count: m.count || 0, lastSync: m.lastSync || null, changes: m.changes || null },
    kdc: { count: Object.keys(k.map || {}).length },
    libs: Object.fromEntries(l.libs.map(x => [x.key, { name: x.name, count: x.count || 0, total: x.total || 0, lastSync: x.lastSync || null, failedPages: x.failedPages || 0, error: x.error || null, detail: x.detail || null, changes: x.changes || null }])),
  };
}

(async () => {
  const t0 = Date.now();
  const steps = [];
  const runId = await report.start('sync', MODE, { millie: MILLIE, skipLibs: SKIP });
  let before = null, after = null, status = 'success';
  let server;
  try {
    const kr = mergeKrLibs();
    if (kr) steps.push({ name: 'Mac에서 받은 도서관 합치기', ok: true, status: `${kr}곳`, ms: 0 });
    server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT }, stdio: ['ignore', 'inherit', 'inherit'] });
    server.on('exit', (c) => { if (c) { console.error('서버가 꺼짐', c); process.exit(1); } });
    for (let i = 0; ; i++) {
      try { if ((await fetch(BASE + '/api/kdc')).ok) break; } catch {}
      if (i > 120) throw new Error('서버가 켜지지 않음');
      await sleep(1000);
    }
    before = await snapshot();
    // 이전 동기화의 변화 기록은 빼고 (이번 기록은 after에)
    delete before.crema.changes; delete before.millie.changes; for (const l of Object.values(before.libs)) delete l.changes;
    const step = async (name, fn) => {
      const s0 = Date.now();
      const r = await fn().catch(e => ({ ok: false, status: e.message }));
      steps.push({ name, ...r, ms: Date.now() - s0 });
      if (!r.ok) status = 'partial';
      await report.update(runId, { summary: { millie: MILLIE, skipLibs: SKIP, steps, before } });
    };
    if (MODE === 'full') {
      await step('크레마클럽·베스트셀러', () => runSse('/api/sync', '크레마클럽·베스트셀러'));
      const keys = Object.keys(before.libs).filter(k => !SKIP.includes(k));
      await step(`도서관 ${keys.length}곳`, () => runSse('/api/libs/sync?keys=' + keys.join(','), `도서관 ${keys.length}곳`));
      if (MILLIE) await step('밀리의 서재', () => runSse('/api/millie/sync', '밀리의 서재'));
      // 십진분류: 서버가 켜지고 20초 뒤 새 책들을 백그라운드로 조회함 → 끝나길 기다림
      await step('십진분류', async () => {
        const until = Date.now() + (+process.env.KDC_MINUTES || 60) * 60e3;
        await sleep(25000);
        let j;
        while ((j = (await (await fetch(BASE + '/api/kdc')).json()).job).running && Date.now() < until) {
          log(`  십진분류 ${j.stage} ${j.done}/${j.total}`);
          await sleep(60000);
        }
        return { ok: true, status: j.running ? `시간 초과로 중간까지 (${j.stage} ${j.done}/${j.total})` : '완료' };
      });
    }
    after = await snapshot();
    await step('내보내기', async () => {
      const exp = spawn(process.execPath, [path.join(__dirname, 'export.js'), BASE, path.join(ROOT, 'site')], { stdio: 'inherit' });
      const code = await new Promise(r => exp.on('exit', r));
      if (code) throw new Error('내보내기 실패 (exit ' + code + ')');
      return { ok: true, status: '완료' };
    });
    if (steps.at(-1).ok === false) status = 'failed';
  } catch (e) {
    console.error(e);
    status = 'failed';
    steps.push({ name: '오류', ok: false, status: e.message, ms: 0 });
  } finally {
    server?.kill('SIGINT'); // SIGINT에 십진분류 파일 저장
    await sleep(3000);
  }
  // 배포 결과는 워크플로 마지막 job(report)에서 덧붙임
  await report.finish(runId, status, { millie: MILLIE, skipLibs: SKIP, steps, before, after, ms: Date.now() - t0 });
  if (status === 'partial') log('일부 동기화가 실패했지만 받은 데이터로 배포합니다');
  if (status === 'failed') process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
