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
  '/api/libs/data': 'api/libs-data.json',
  '/api/libs/merged': 'api/libs-merged.json',
  '/api/seoul/data': 'api/seoul-data.json',
  '/api/awards': 'api/awards.json',
  '/api/kdc': 'api/kdc.json',
};
(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'api'), { recursive: true });
  for (const [ep, file] of Object.entries(ENDPOINTS)) {
    const r = await fetch(BASE + ep);
    if (!r.ok) throw new Error(`${ep}: HTTP ${r.status}`);
    const j = await r.json();
    if (ep === '/api/millie/data' || ep === '/api/libs/data') { j.running = false; j.status = null; }
    if (ep === '/api/kdc') j.job = { running: false, stage: '완료', done: 0, total: 0 };
    const s = JSON.stringify(j);
    fs.writeFileSync(path.join(OUT, file), s);
    console.log(`${file}: ${(s.length / 1e6).toFixed(1)}MB`);
  }
  for (const f of ['match.js', 'web.js']) fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
  // 웹 버전 설정 (Supabase URL·publishable key는 브라우저용 공개 값)
  const version = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, 'config.js'), 'window.SITE = ' + JSON.stringify({
    version,
    supabaseUrl: process.env.SUPABASE_URL || 'https://plbloozabksouhacpsbz.supabase.co',
    supabaseKey: process.env.SUPABASE_KEY || 'sb_publishable_ZujJquUTwyqCQA7JNFVP4g_KK3a782g',
  }) + ';\n');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const tags = `<script src="config.js?v=${version}"></script>\n<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>\n<script src="match.js?v=${version}"></script>\n<script src="web.js?v=${version}"></script>\n</head>`;
  if (!html.includes('</head>')) throw new Error('index.html에 </head>가 없음');
  fs.writeFileSync(path.join(OUT, 'index.html'), html.replace('</head>', tags));
  fs.writeFileSync(path.join(OUT, 'api', 'meta.json'), JSON.stringify({ exportedAt: version }));
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
})().catch(e => { console.error(e); process.exit(1); });
