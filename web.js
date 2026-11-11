// 웹(GitHub Pages) 버전 어댑터. scripts/export.js가 index.html에 넣는다 (로컬 서버로 열 때는 안 들어감).
// 앱 코드는 그대로 두고 fetch('/api/...')만 가로채서
//  - 데이터: GitHub Actions가 미리 만들어 둔 api/*.json
//  - 즐겨찾기: Supabase (구글 로그인, 사용자별)
//  - 동기화·실시간 분류 조회: 자동 동기화로 대신하므로 막음
(function () {
  const SITE = window.SITE;
  document.documentElement.classList.add('static-site');
  const sb = window.supabase.createClient(SITE.supabaseUrl, SITE.supabaseKey);
  let user = null;

  const STATIC_API = {
    '/api/data': 'api/data.json',
    '/api/millie/data': 'api/millie-data.json',
    '/api/ridi/data': 'api/ridi-data.json',
    '/api/libs/data': 'api/libs-data.json',
    '/api/libs/merged': 'api/libs-merged.json',
    '/api/seoul/data': 'api/seoul-data.json',
    '/api/awards': 'api/awards.json',
    '/api/kdc': 'api/kdc.json',
  };
  const realFetch = window.fetch.bind(window);
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

  window.fetch = async (url, opts = {}) => {
    if (typeof url !== 'string' || !url.startsWith('/api/')) return realFetch(url, opts);
    const u = new URL(url, 'http://x');
    const p = u.pathname;
    if (STATIC_API[p]) return realFetch(`${STATIC_API[p]}?v=${encodeURIComponent(SITE.version)}`);
    if (p === '/api/favorites') return favApi((opts.method || 'GET').toUpperCase(), u, opts.body);
    if (p === '/api/kdc/lookup') return json({ map: {} }); // 분류는 동기화 때 전부 미리 조회해 둠
    if (p.startsWith('/api/millie/book/')) { // 밀리 공개 API는 브라우저에서 바로 부를 수 있음 (CORS 허용)
      const id = p.split('/').pop().replace(/[^0-9a-f]/gi, '');
      try {
        const r = await realFetch(`https://apis.millie.co.kr/v3/content/detail/book/${id}/`, { headers: { Accept: 'application/json' } });
        const d = r.ok ? await r.json() : null;
        return json({ totalPage: d?.total_page || null });
      } catch (e) { return json({ error: e.message }); }
    }
    return json({ error: '웹 버전은 매일 자동으로 동기화돼요' }, 404);
  };

  // ─── 즐겨찾기 ───
  const favKey = (title, author) => 't:' + Match.workKey(title) + '|' + Match.authorKey(author);
  const fromRow = (r) => ({ key: r.key, title: r.title, author: r.author, publisher: r.publisher, cremaId: r.crema_id, addedAt: r.added_at });

  // 서버의 enrichFav와 같은 일: 크레마·밀리·도서관 소장 정보를 지금 데이터로 붙인다
  let ix = null, ixSrc = [];
  function index() {
    const src = [data.books, mergedData, millieData.books, libsData.cremaLibIds, ridiData.books];
    if (!ix || src.some((s, i) => s !== ixSrc[i])) {
      ixSrc = src;
      ix = {
        cremaById: new Map(data.books.map(b => [b.bookId, b])),
        findCrema: Match.buildTitleIndex(data.books),
        findMerged: mergedData ? Match.buildTitleIndex(mergedData) : () => null,
        findRidi: ridiData.books ? Match.buildTitleIndex(ridiData.books.map(([id, title, author]) => ({ id, title, author }))) : () => null,
        findMillie: millieData.books ? Match.buildTitleIndex(millieData.books.map(([id, title, author]) => ({ id, title, author }))) : () => null,
      };
    }
    return ix;
  }
  function enrich(f) {
    const x = index();
    const cremaLibIds = libsData.cremaLibIds || {}, seoulMatch = data.seoulMatch || {};
    const saved = f.cremaId && x.cremaById.get(f.cremaId);
    const cb = (saved && Match.authorsMatch(f.author, saved.author) ? saved : null) || x.findCrema(f.title, f.author || '');
    let libIds;
    if (cb && (cremaLibIds[cb.bookId] || seoulMatch[cb.bookId])) {
      libIds = { ...(cremaLibIds[cb.bookId] || {}) };
      if (seoulMatch[cb.bookId]) libIds.seoul = seoulMatch[cb.bookId];
    } else libIds = x.findMerged(f.title, f.author || '')?.ids || {};
    return { ...f, millieId: x.findMillie(cb?.title || f.title, cb?.author || f.author || '')?.id || null, ridiId: x.findRidi(cb?.title || f.title, cb?.author || f.author || '')?.id || null, cremaId: cb?.bookId || null,
      crema: cb ? { rating: cb.rating, reviews: cb.reviews, cover: cb.cover } : null, libIds };
  }
  // 즐겨찾기 탭에선 도서관 통합 목록·밀리 목록까지 받은 뒤에 붙인다 (다른 탭에선 별 표시만 필요해서 기다리지 않음)
  const waitFor = (cond) => new Promise(res => { const t = setInterval(() => { if (cond()) { clearInterval(t); res(); } }, 200); });
  async function ready() {
    if (currentTab !== 'favs') return;
    await Promise.all([ensureMerged(), waitFor(() => millieData.books), waitFor(() => libsData.cremaLibIds)]);
  }

  async function favApi(method, u, body) {
    if (method === 'GET') {
      if (!user) return json({ items: [] });
      const { data: rows, error } = await sb.from('favorites').select('*').order('added_at', { ascending: false });
      if (error) return json({ error: error.message }, 500);
      await ready().catch(() => {});
      return json({ items: rows.map(fromRow).map(enrich) });
    }
    if (!user) {
      if (confirm('즐겨찾기는 로그인해야 쓸 수 있어요. 구글로 로그인할까요?')) login();
      return json({ error: '로그인이 필요해요' }, 401);
    }
    if (method === 'POST') {
      const { title, author = '', publisher = '', cremaId = null } = JSON.parse(body || '{}');
      if (!title) return json({ error: 'title이 필요합니다' }, 400);
      const row = { key: favKey(title, author), title, author, publisher, crema_id: cremaId };
      const { error } = await sb.from('favorites').upsert(row, { onConflict: 'user_id,key', ignoreDuplicates: true });
      if (error) return json({ error: error.message }, 500);
      return json({ item: enrich({ ...fromRow(row), addedAt: new Date().toISOString() }) });
    }
    if (method === 'DELETE') {
      const { error } = await sb.from('favorites').delete().eq('key', u.searchParams.get('key'));
      return error ? json({ error: error.message }, 500) : json({ ok: true });
    }
    return json({ error: 'bad method' }, 405);
  }

  // 로컬 버전의 data-favorites.json 가져오기
  async function importFavs(file) {
    try {
      const items = JSON.parse(await file.text()).items || [];
      const rows = items.filter(f => f.title).map(f => ({ key: favKey(f.title, f.author || ''), title: f.title, author: f.author || '', publisher: f.publisher || '', crema_id: f.cremaId || null, added_at: f.addedAt || new Date().toISOString() }));
      const uniq = [...new Map(rows.map(r => [r.key, r])).values()];
      const { error } = await sb.from('favorites').upsert(uniq, { onConflict: 'user_id,key', ignoreDuplicates: true });
      if (error) throw error;
      alert(`${uniq.length}권을 가져왔어요`);
      refresh();
    } catch (e) { alert('가져오기 실패: ' + e.message); }
  }

  // ─── 로그인 ───
  const login = () => googleLogin(sb); // google-login.js
  const logout = () => sb.auth.signOut();
  function refresh() {
    if (typeof loadFavorites !== 'function') return;
    loadFavorites().then(() => render());
  }

  function renderAccount() {
    let btn = document.getElementById('btnAccount');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'btnAccount';
      btn.className = 'tab-sync';
      btn.onclick = (ev) => { ev.stopPropagation(); user ? toggleMenu() : login(); };
      document.getElementById('btnSettings').before(btn);
      const adm = document.createElement('a'); // 관리자에게만 보이는 탭 줄 버튼
      adm.id = 'btnAdmin'; adm.className = 'tab-sync'; adm.href = 'admin.html'; adm.textContent = '관리자'; adm.hidden = true;
      adm.style.cssText = 'display:flex;align-items:center;text-decoration:none';
      btn.before(adm);
      const menu = document.createElement('div');
      menu.id = 'accountMenu';
      menu.innerHTML = `<button id="accAdmin" hidden>관리자 화면 (동기화 기록)</button><button id="accImport">기존 즐겨찾기 가져오기 (data-favorites.json)</button><button id="accSettings">설정 · 탈퇴</button><button id="accLogout">로그아웃</button><input type="file" id="accFile" accept=".json,application/json" hidden>`;
      document.body.appendChild(menu);
      menu.querySelector('#accAdmin').onclick = () => { location.href = 'admin.html'; };
      menu.querySelector('#accImport').onclick = () => menu.querySelector('#accFile').click();
      menu.querySelector('#accFile').onchange = (e) => { if (e.target.files[0]) importFavs(e.target.files[0]); e.target.value = ''; toggleMenu(false); };
      menu.querySelector('#accSettings').onclick = () => { toggleMenu(false); openSettings(); };
      menu.querySelector('#accLogout').onclick = () => { logout(); toggleMenu(false); };
      document.addEventListener('click', (e) => { if (!menu.contains(e.target)) toggleMenu(false); });
    }
    document.getElementById('accAdmin').hidden = !isAdmin;
    const adm = document.getElementById('btnAdmin');
    adm.hidden = !isAdmin; adm.style.display = isAdmin ? 'flex' : 'none';
    btn.textContent = user ? (user.user_metadata?.name || user.email) + ' ▾' : '구글 로그인';
    btn.title = user ? user.email : '로그인하면 즐겨찾기를 저장할 수 있어요';
  }
  function toggleMenu(open) {
    const m = document.getElementById('accountMenu');
    const show = open ?? !m.classList.contains('open');
    m.classList.toggle('open', show);
    if (show) { const r = document.getElementById('btnAccount').getBoundingClientRect(); m.style.top = r.bottom + 'px'; m.style.right = Math.max(8, innerWidth - r.right) + 'px'; }
  }

  // 즐겨찾기 탭이 비었을 때 (index.html에서 부름)
  window.favEmptyHtml = () => user
    ? '<div class="empty"><p>목록에서 ☆를 눌러 관심 책을 추가하세요</p><p style="margin-top:8px"><a href="#" onclick="event.preventDefault();document.getElementById(\'accFile\').click()">기존 즐겨찾기 파일 가져오기</a></p></div>'
    : '<div class="empty"><p>로그인하면 나만의 즐겨찾기를 저장하고 어디서나 볼 수 있어요</p><p style="margin-top:12px"><button class="btn-sync" onclick="document.getElementById(\'btnAccount\').click()">구글로 로그인</button></p></div>';

  const style = document.createElement('style');
  style.textContent = `
    .static-site #btnSync, .static-site .sync-summary .btn-mini { display: none !important; }
    #accountMenu { position: fixed; display: none; flex-direction: column; z-index: 1000; background: var(--c222, #222); border: 1px solid var(--c444, #444); border-radius: 6px; padding: 4px; }
    #accountMenu.open { display: flex; }
    #accountMenu button { background: none; border: none; color: var(--caaa, #aaa); text-align: left; padding: 8px 12px; cursor: pointer; font-size: 13px; }
    #accountMenu button:hover { color: var(--cfff, #fff); background: var(--c333, #333); }`;
  document.head.appendChild(style);

  let isAdmin = false;
  const whenReady = (fn) => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', fn, { once: true }) : fn();
  // 로그인하면: 미리 넣어 둔 즐겨찾기(pending_favorites) 가져오기 + 관리자인지 확인
  // (onAuthStateChange 안에서 바로 Supabase를 부르면 막힐 수 있어서 setTimeout으로 밖에서)
  // 설정(쓰는 플랫폼 등)을 계정에 저장 → 다른 기기에서도 같게
  // 계정에 저장된 게 있으면 그걸 쓰고, 없으면 이 기기 설정을 올림
  async function loadAccountSettings() {
    const { data, error } = await sb.from('user_settings').select('settings').maybeSingle();
    if (error) return; // 테이블이 아직 없을 때 등
    if (data?.settings && Object.keys(data.settings).length) whenReady(() => window.setSettings?.(data.settings, { silent: true }));
    else if (window.getSettings) saveAccountSettings(window.getSettings());
  }
  let saveTimer = null;
  function saveAccountSettings(st) {
    if (!user) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => sb.from('user_settings').upsert({ user_id: user.id, settings: st, updated_at: new Date().toISOString() }).then(({ error }) => { if (error) console.warn('설정 저장 실패', error.message); }), 500);
  }
  window.onSettingsChange = saveAccountSettings;

  // 설정 창의 계정 부분 (index.html openSettings가 부름)
  window.accountSettingsHtml = () => `<div class="settings-sec"><h4>계정</h4>${user
    ? `<p class="settings-note">${esc(user.email)} 로 로그인 중 · 설정과 즐겨찾기가 계정에 저장돼요</p>
       <button class="settings-btn" onclick="accountLogout()">로그아웃</button><button class="settings-btn danger" onclick="accountDelete()">탈퇴</button>`
    : `<p class="settings-note">로그인하면 설정과 즐겨찾기를 계정에 저장해서 다른 기기에서도 볼 수 있어요</p>
       <button class="settings-btn" onclick="closePopup(); accountLogin()">구글로 로그인</button>`}</div>`;
  window.accountLogin = () => login();
  window.accountLogout = async () => { await logout(); closePopup(); };
  // 탈퇴: 한 번 확인 → 즐겨찾기·설정·계정 삭제 (Supabase delete_my_account)
  window.accountDelete = async () => {
    if (!user) return;
    if (!confirm(`정말 탈퇴할까요?\n\n${user.email} 계정과 즐겨찾기 ${favorites.length}권, 설정이 모두 지워지고 되돌릴 수 없어요.`)) return;
    const { error } = await sb.rpc('delete_my_account');
    if (error) { alert('탈퇴 실패: ' + error.message); return; }
    await sb.auth.signOut().catch(() => {});
    localStorage.removeItem('settings');
    closePopup();
    alert('탈퇴했어요. 그동안 이용해 주셔서 고마워요.');
    location.reload();
  };
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function onLogin() {
    loadAccountSettings();
    const [claim, admin] = await Promise.all([sb.rpc('claim_pending_favorites'), sb.rpc('is_admin')]);
    isAdmin = admin.data === true;
    whenReady(renderAccount);
    if (claim.data > 0) { refresh(); alert(`미리 옮겨 둔 즐겨찾기 ${claim.data}권을 가져왔어요`); }
  }
  sb.auth.onAuthStateChange((event, session) => {
    const prev = user?.id;
    user = session?.user || null;
    if (!user) isAdmin = false;
    whenReady(renderAccount);
    if ((user?.id || null) !== (prev || null)) { refresh(); if (user) setTimeout(onLogin, 0); }
  });
})();
