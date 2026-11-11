// 동기화 기록을 Supabase sync_runs에 남김 (관리자 화면에서 봄)
// SUPABASE_SECRET_KEY가 없으면(로컬 실행 등) 아무것도 안 함
const URL_ = (process.env.SUPABASE_URL || 'https://plbloozabksouhacpsbz.supabase.co') + '/rest/v1/sync_runs';
const KEY = process.env.SUPABASE_SECRET_KEY;
const H = { apikey: KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const gh = process.env.GITHUB_RUN_ID ? {
  run_id: +process.env.GITHUB_RUN_ID,
  url: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  trigger: process.env.GITHUB_EVENT_NAME,
} : { trigger: 'local' };

async function call(method, url, body) {
  if (!KEY) return null;
  try {
    const r = await fetch(url, { method, headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    if (!r.ok) { console.error('동기화 기록 실패:', r.status, await r.text()); return null; }
    return (await r.json())[0];
  } catch (e) { console.error('동기화 기록 실패:', e.message); return null; }
}
exports.start = async (workflow, mode, summary = {}) => (await call('POST', URL_, { workflow, mode, ...gh, summary }))?.id || null;
exports.update = (id, fields) => id && call('PATCH', `${URL_}?id=eq.${id}`, fields);
exports.finish = (id, status, summary) => id && call('PATCH', `${URL_}?id=eq.${id}`, { status, summary, finished_at: new Date().toISOString() });

// 워크플로 마지막 job: node scripts/report.js <sync 결과> <deploy 결과>
// 시간 초과·취소·배포 실패도 기록 (sync.js가 끝까지 못 갔으면 'running'으로 남아 있음)
if (require.main === module) {
  const [syncResult, deployResult] = process.argv.slice(2);
  (async () => {
    if (!KEY || !gh.run_id) return;
    const row = (await (await fetch(`${URL_}?run_id=eq.${gh.run_id}&workflow=eq.sync&select=id,status,summary&order=id.desc&limit=1`, { headers: H })).json())[0];
    if (!row) return;
    const summary = { ...row.summary, jobs: { sync: syncResult, deploy: deployResult } };
    const bad = [syncResult, deployResult].find(r => r !== 'success' && r !== 'skipped');
    if (!bad && row.status !== 'running') return exports.update(row.id, { summary });
    await exports.finish(row.id, bad === 'cancelled' ? 'cancelled' : bad ? 'failed' : row.status === 'running' ? 'failed' : row.status, summary);
  })();
}
