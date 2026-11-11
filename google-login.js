// 구글 로그인 (Google Identity Services 버튼 → 받은 ID 토큰을 Supabase에 넘김)
// Supabase OAuth 리디렉션을 쓰면 구글 화면에 'xxxx.supabase.co에 로그인'이라고 나와서,
// 사이트 안에서 구글 버튼으로 로그인하면 'songbird39.github.io'로 나온다.
// 사용: googleLogin(supabaseClient)  (SITE.googleClientId가 없으면 예전 리디렉션 방식)
(function () {
  let gsiLoading = null;
  const loadGsi = () => gsiLoading ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = res; s.onerror = () => rej(new Error('구글 로그인 스크립트를 못 불러옴'));
    document.head.appendChild(s);
  });
  // 재사용 공격 방지용 nonce: 구글엔 SHA-256 해시, Supabase엔 원래 값
  async function makeNonce() {
    const raw = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    return { raw, hashed: [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('') };
  }

  function modal() {
    let m = document.getElementById('gLoginModal');
    if (m) return m;
    const st = document.createElement('style');
    st.textContent = `
      #gLoginModal { position: fixed; inset: 0; z-index: 2000; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,.55); }
      #gLoginModal.open { display: flex; }
      #gLoginModal .box { background: var(--c1a1a1a, #1a1a1a); color: var(--cddd, #ddd); border: 1px solid var(--c333, #333); border-radius: 10px; padding: 22px 26px; min-width: 300px; text-align: center; font-size: 14px; }
      [data-theme="light"] #gLoginModal .box { background: #fff; color: #222; border-color: #ddd; }
      #gLoginModal .msg { margin: 0 0 14px; }
      #gLoginModal .err { color: #e74c3c; font-size: 12px; margin-top: 10px; min-height: 1em; }
      #gLoginModal .close { margin-top: 12px; background: none; border: none; color: #888; cursor: pointer; font-size: 13px; }
      #gLoginModal .gbtn { display: flex; justify-content: center; min-height: 44px; }`;
    document.head.appendChild(st);
    m = document.createElement('div');
    m.id = 'gLoginModal';
    m.innerHTML = `<div class="box"><p class="msg">구글 계정으로 로그인</p><div class="gbtn"></div><div class="err"></div><button class="close">닫기</button></div>`;
    m.onclick = (e) => { if (e.target === m) m.classList.remove('open'); };
    m.querySelector('.close').onclick = () => m.classList.remove('open');
    document.body.appendChild(m);
    return m;
  }

  window.googleLogin = async function (sb, redirectTo = location.origin + location.pathname) {
    if (!window.SITE?.googleClientId) return sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
    const m = modal();
    const err = m.querySelector('.err');
    err.textContent = '';
    m.classList.add('open');
    try {
      await loadGsi();
      const nonce = await makeNonce();
      google.accounts.id.initialize({
        client_id: SITE.googleClientId,
        nonce: nonce.hashed,
        use_fedcm_for_prompt: true,
        callback: async ({ credential }) => {
          const { error } = await sb.auth.signInWithIdToken({ provider: 'google', token: credential, nonce: nonce.raw });
          if (error) { err.textContent = '로그인 실패: ' + error.message; return; }
          m.classList.remove('open');
        },
      });
      const box = m.querySelector('.gbtn');
      box.innerHTML = '';
      const dark = document.documentElement.dataset.theme !== 'light';
      google.accounts.id.renderButton(box, { theme: dark ? 'filled_black' : 'outline', size: 'large', text: 'signin_with', shape: 'pill', locale: 'ko' });
    } catch (e) { err.textContent = e.message; }
  };
})();
