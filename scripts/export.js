// 켜져 있는 서버(BASE)의 API 응답을 정적 파일로 저장 → GitHub Pages에 올릴 site/ 폴더
// 사용: node scripts/export.js [http://localhost:3456] [site]
const fs = require('fs');
const path = require('path');
const BASE = process.argv[2] || 'http://localhost:3456';
const OUT = path.resolve(process.argv[3] || 'site');
const ROOT = path.join(__dirname, '..');
// API 경로 → 파일 (index.html의 STATIC_API와 같아야 함)
const ENDPOINTS = {
  '/api/data': 'api/data.json',
  '/api/millie/data': 'api/millie-data.json',
  '/api/ridi/data': 'api/ridi-data.json',
  '/api/libs/data': 'api/libs-data.json',
  '/api/libs/merged': 'api/libs-merged.json',
  '/api/seoul/data': 'api/seoul-data.json',
  '/api/seoul/kinds': 'api/seoul-kinds.json',
  '/api/awards': 'api/awards.json',
  '/api/kdc': 'api/kdc.json',
};
(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'api'), { recursive: true });
  const got = {};
  for (const [ep, file] of Object.entries(ENDPOINTS)) {
    const r = await fetch(BASE + ep);
    if (!r.ok) throw new Error(`${ep}: HTTP ${r.status}`);
    const j = await r.json();
    if (ep === '/api/millie/data' || ep === '/api/ridi/data' || ep === '/api/libs/data') { j.running = false; j.status = null; }
    if (ep === '/api/kdc') j.job = { running: false, stage: '완료', done: 0, total: 0 };
    got[ep] = j;
    const s = JSON.stringify(j);
    fs.writeFileSync(path.join(OUT, file), s);
    console.log(`${file}: ${(s.length / 1e6).toFixed(1)}MB`);
  }
  // 관리자 화면용 데이터 현황 (작은 파일)
  const d = got['/api/data'], m = got['/api/millie/data'], r = got['/api/ridi/data'];
  const status = {
    crema: { count: d.books?.length || 0, lastSync: d.lastSync || null, lastCrawl: d.lastCremaCrawl || null, changes: d.cremaChanges || null },
    bestsellers: { lists: Object.fromEntries(Object.entries(d.bestsellerLists || {}).map(([k, v]) => [k, v.length])), lastSync: d.bestsellerSync || null },
    millie: { count: m.count || 0, lastSync: m.lastSync || null, changes: m.changes || null },
    ridi: { count: r.count || 0, lastSync: r.lastSync || null, changes: r.changes || null },
    kdc: { count: Object.keys(got['/api/kdc'].map || {}).length },
    libs: Object.fromEntries(got['/api/libs/data'].libs.map(x => [x.key, { name: x.name, count: x.count || 0, total: x.total || 0, lastSync: x.lastSync || null, failedPages: x.failedPages || 0, error: x.error || null, detail: x.detail || null, changes: x.changes || null }])),
  };
  fs.writeFileSync(path.join(OUT, 'api', 'status.json'), JSON.stringify(status));
  for (const f of ['match.js', 'web.js', 'google-login.js', 'admin.html']) fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
  fs.copyFileSync(path.join(ROOT, 'manifest.webmanifest'), path.join(OUT, 'manifest.webmanifest'));
  fs.cpSync(path.join(ROOT, 'icons'), path.join(OUT, 'icons'), { recursive: true });
  // 웹 버전 설정 (Supabase URL·publishable key는 브라우저용 공개 값)
  const version = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, 'config.js'), 'window.SITE = ' + JSON.stringify({
    version,
    supabaseUrl: process.env.SUPABASE_URL || 'https://plbloozabksouhacpsbz.supabase.co',
    supabaseKey: process.env.SUPABASE_KEY || 'sb_publishable_ZujJquUTwyqCQA7JNFVP4g_KK3a782g',
    googleClientId: process.env.GOOGLE_CLIENT_ID || '', // 구글 로그인 버튼용 (공개 값, 저장소 변수 GOOGLE_CLIENT_ID)
  }) + ';\n');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const tags = `<script src="config.js?v=${version}"></script>\n<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>\n<script src="google-login.js?v=${version}"></script>\n<script src="match.js?v=${version}"></script>\n<script src="web.js?v=${version}"></script>\n</head>`;
  if (!html.includes('</head>')) throw new Error('index.html에 </head>가 없음');
  fs.writeFileSync(path.join(OUT, 'index.html'), html.replace('</head>', tags));
  fs.writeFileSync(path.join(OUT, 'api', 'meta.json'), JSON.stringify({ exportedAt: version }));
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
})().catch(e => { console.error(e); process.exit(1); });
