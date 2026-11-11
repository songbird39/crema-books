// ─── 서울 구립 전자도서관 크롤러 ───
// 구마다 전자도서관 업체 시스템이 달라서 플랫폼별 크롤러를 두고 도서관 목록에서 플랫폼을 지정한다.
// 각 크롤러는 { id, title, author, publisher } 목록을 반환한다. (ECO만 isbn 제공)
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const { parse } = require('node-html-parser');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// 구로구 서버는 중간 인증서를 보내지 않아 Node 기본 검증이 실패함 → 중간 인증서를 추가해 검증
const EXTRA_CA = [...tls.rootCertificates, fs.readFileSync(path.join(__dirname, 'certs/thawte-tls-rsa-ca-g1.pem'), 'utf8')];

const LIBRARIES = [
  { key: 'jongno', name: '종로구', platform: 'yes24', base: 'https://elib.jongno.go.kr' },
  { key: 'jung', name: '중구', platform: 'kyobo', base: 'https://ebook.junggulib.or.kr' },
  { key: 'yongsan', name: '용산구', platform: 'kyobo', base: 'https://ebook.yslibrary.or.kr' },
  { key: 'seongdong', name: '성동구', platform: 'fxlibrary', base: 'https://ebook.sdlib.or.kr' },
  { key: 'gwangjin', name: '광진구', platform: 'kyobo', base: 'https://ebook.gwangjinlib.seoul.kr:446' },
  { key: 'dongdaemun', name: '동대문구', platform: 'kyobo', base: 'https://e-book.l4d.or.kr' },
  { key: 'jungnang', name: '중랑구', platform: 'kyobo', base: 'https://ebook.jungnanglib.seoul.kr' },
  { key: 'seongbuk', name: '성북구', platform: 'kyobo', base: 'https://elibrary.sblib.seoul.kr' },
  { key: 'gangbuk', name: '강북구', platform: 'kyobo', base: 'https://ebook.gblib.or.kr' },
  { key: 'dobong', name: '도봉구', platform: 'kyobo', base: 'https://elib.dobong.kr' },
  { key: 'nowon', name: '노원구', platform: 'kyobo', base: 'https://eb.nowonlib.kr' },
  { key: 'eunpyeong', name: '은평구', platform: 'eco', base: 'https://epbook.eplib.or.kr' },
  { key: 'seodaemun', name: '서대문구', platform: 'kyobo', base: 'https://ebook.sdm.or.kr' },
  { key: 'mapo', name: '마포구', platform: 'kyobo', base: 'https://ebook.mapo.go.kr' },
  { key: 'yangcheon', name: '양천구', platform: 'kyobo', base: 'https://ebook.yangcheon.or.kr' },
  // 강서구 소장형 사이트(ebook.gangseo.seoul.kr)는 접속 불가(연결 타임아웃)라 제외
  { key: 'guro', name: '구로구', platform: 'kyobo', base: 'https://ebook.guro.go.kr', ca: EXTRA_CA },
  { key: 'geumcheon', name: '금천구', platform: 'fxlibrary', base: 'https://elib.geumcheonlib.seoul.kr' },
  { key: 'yeongdeungpo', name: '영등포구', platform: 'yes24', base: 'https://ebook.ydplib.or.kr' },
  { key: 'dongjak', name: '동작구', platform: 'kyobo', base: 'https://ebook.dongjak.go.kr' },
  { key: 'gwanak', name: '관악구', platform: 'yes24', base: 'https://e-lib.gwanak.go.kr' },
  // 서초구는 교보 사이트와 같은 장서를 ECO 사이트가 1000권 단위 JSON으로 제공 → ECO 사용
  { key: 'seocho', name: '서초구', platform: 'eco', base: 'https://e-book.seocholib.or.kr' },
  { key: 'gangnam', name: '강남구', platform: 'gangnam', base: 'https://ebook.gangnam.go.kr' },
  { key: 'songpa', name: '송파구', platform: 'yes24', base: 'https://ebook.splib.or.kr' },
  { key: 'gangdong', name: '강동구', platform: 'yes24', base: 'https://ebook.gdlibrary.or.kr' },
  // 서울대학교 전자도서관 (재학생·교직원만 대출). 목록은 로그인 없이 보임. 화면에선 설정에서 켠 사람만 보임 (key가 snu로 시작)
  { key: 'snu_kyobo', name: '서울대(교보)', platform: 'kyobo', base: 'https://snu.dkyobobook.co.kr', group: 'snu' },
  { key: 'snu_yes24', name: '서울대(YES24)', platform: 'yes24', base: 'https://snu.yes24library.com', group: 'snu' },
  { key: 'snu_bookcube', name: '서울대(북큐브)', platform: 'fxlibrary', base: 'https://snu.bookcube.biz', group: 'snu' },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function httpGet(url, { ca, encoding = 'utf-8', timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/json', 'Accept-Language': 'ko-KR,ko;q=0.9' },
      ...(ca ? { ca } : {}),
      timeout,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpGet(new URL(res.headers.location, url).href, { ca, encoding, timeout }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(new TextDecoder(encoding).decode(Buffer.concat(chunks))));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function get(url, opts, retries = 2) {
  for (let i = 0; ; i++) {
    try { return await httpGet(url, opts); }
    catch (e) {
      if (i >= retries) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

const text = (el) => (el?.text || '').replace(/\s+/g, ' ').trim();
// HTML 조각 → 엔티티 해제된 텍스트
const decode = (frag) => text(parse(frag));

// ─── 교보문고 전자도서관 (elibrary-front) ───
const kyobo = {
  detail: (lib, id) => `${lib.base}/elibrary-front/content/contentView.ink?cttsDvsnCode=001&brcd=${id}`,
  pageSize: 80, // 20/40/60/80만 허용
  url: (lib, page) => `${lib.base}/elibrary-front/content/contentList.ink?cttsDvsnCode=001&contentAll=Y&pageIndex=${page}&recordCount=80`,
  total: (html) => +(html.match(/totalCount\s*:\s*"(\d+)"/)?.[1] || 0),
  // 책 소개(li.txt)에 깨진 마크업이 섞인 페이지가 있어 HTML 파서가 목록 전체를 놓친다 →
  // 형식이 일정한 제목/저자 줄만 정규식으로 뽑는다.
  items(html) {
    const re = /<li class="tit"><a [^>]*fnContentClick\(this,\s*'[^']*',\s*'([^']+)'[^>]*>([\s\S]*?)<\/a><\/li>\s*<li class="writer">([\s\S]*?)<span>([\s\S]*?)<\/span>/g;
    return [...html.matchAll(re)].map(m => ({
      id: m[1], title: decode(m[2]), author: decode(m[3]), publisher: decode(m[4]),
    }));
  },
};

// ─── YES24 전자도서관 (페이지당 10권 고정) ───
const yes24 = {
  detail: (lib, id) => `${lib.base}/ebook/detail/?goods_id=${id}`,
  pageSize: 10,
  // 사이트 응답이 페이지당 ~4.5초로 느려 순차로 받으면 종로구(2040페이지)가 2시간 넘게 걸림 → 동시에 여러 페이지
  concurrency: 6,
  url: (lib, page) => `${lib.base}/ebook/?mode=total&sort=title&page_num=${page}`,
  total: (html) => +(html.match(/class="total"[^>]*>[\s\S]*?<em>([\d,]+)<\/em>/)?.[1]?.replace(/,/g, '') || 0),
  // 깨진 마크업 때문에 HTML 파서가 목록을 놓치는 페이지가 있어 정규식으로 뽑는다.
  // (상단 슬라이드는 /ebook/detail/?goods_id 형식이라 제외됨)
  items(html) {
    const re = /<p class="tit">(?:\s*<strong>[^<]*<\/strong>)?\s*<a href="\/ebook\/detail\?goods_id=(\w+)">([\s\S]*?)<\/a><\/p>\s*<p class="writer">([\s\S]*?)<\/p>\s*<p class="detail">\s*<span>([\s\S]*?)<\/span>/g;
    return [...html.matchAll(re)].map(m => ({
      id: m[1], title: decode(m[2]), author: decode(m[3]), publisher: decode(m[4]),
    }));
  },
};

// ─── 북큐브 FxLibrary ───
const fxlibrary = {
  detail: (lib, id) => `${lib.base}/FxLibrary/product/view/?num=${id}`,
  pageSize: 500,
  url: (lib, page) => `${lib.base}/FxLibrary/product/list/?category_type=book&cateopt=total&sort=3&itemCount=500&page=${page}`,
  total: (html) => +(parse(html).querySelector('h2 em')?.text.match(/([\d,]+)\s*종/)?.[1]?.replace(/,/g, '') || 0),
  items(html) {
    // 마크업에 항목이 두 번씩 나옴 → id로 중복 제거
    const seen = new Set();
    const out = [];
    for (const li of parse(html).querySelectorAll('li.item')) {
      const id = (li.innerHTML.match(/goView\('([^']+)'/) || [])[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      // 첫 ul.i1: [저자 a, 출판사 a, 날짜]
      const meta = li.querySelector('ul.i1')?.querySelectorAll('li') || [];
      out.push({ id, title: text(li.querySelector('.subject a')), author: text(meta[0]?.querySelector('a')), publisher: text(meta[1]) });
    }
    return out;
  },
};

// ─── ECO (JSON API, ISBN 제공) ───
const eco = {
  detail: (lib, id) => `${lib.base}/content/detail?id=${id}&contentType=EB`,
  pageSize: 1000,
  json: true,
  url: (lib, page) => `${lib.base}/api/service/content/category?contentType=EB&sort=title&asc=asc&page=${page}&size=1000`,
  total: (json) => json?.data?.totalElements || 0,
  items: (json) => (json?.data?.content || []).map(c => ({
    id: c.contentKey, title: (c.title || '').trim(), author: (c.author || '').trim(), publisher: (c.publisher || '').trim(), isbn: c.isbn || '',
  })),
};

// ─── 강남구 자체 사이트 (EUC-KR, 페이지당 20권 고정) ───
const gangnam = {
  detail: (lib, id) => `${lib.base}/elibbook/book_detail.asp?book_num=${id}`,
  pageSize: 20,
  concurrency: 3,
  encoding: 'euc-kr',
  url: (lib, page) => `${lib.base}/elibbook/book_category.asp?branch=99&page_num=${page}`,
  total: (html) => +(html.match(/<strong>([\d,]+)<\/strong>\s*건/)?.[1]?.replace(/,/g, '') || 0),
  // 깨진 마크업 때문에 HTML 파서가 목록을 놓치는 페이지가 있어 정규식으로 뽑는다.
  items(html) {
    const re = /<div class="book_title"><a href="book_detail\.asp\?book_num=([^"&]+)[^"]*">([\s\S]*?)<\/a><\/div>\s*<div class="writer">([\s\S]*?)<\/div>\s*<div class="publish_date">([\s\S]*?)<\/div>/g;
    return [...html.matchAll(re)].map(m => ({
      id: m[1], title: decode(m[2]), author: decode(m[3]), publisher: decode(m[4]).split('·')[0].trim(),
    }));
  },
};

const PLATFORMS = { kyobo, yes24, fxlibrary, eco, gangnam };

async function fetchPage(lib, p, page) {
  const body = await get(p.url(lib, page), { ca: lib.ca, encoding: p.encoding });
  return p.json ? JSON.parse(body) : body;
}

// 한 도서관의 전체 전자책 목록 크롤링. onProgress({ page, totalPages, count })
async function crawlLibrary(lib, { onProgress, delay = 300, shouldStop = () => false } = {}) {
  const p = PLATFORMS[lib.platform];
  const start = 1;
  const first = await fetchPage(lib, p, start);
  const total = p.total(first);
  if (!total) throw new Error('총 권수를 찾지 못함 (사이트 구조 변경?)');
  const totalPages = Math.ceil(total / p.pageSize);
  const books = new Map();
  const add = (items) => { for (const b of items) if (b.id && b.title) books.set(b.id, b); };
  add(p.items(first));
  let failed = 0;
  let done = 1;
  onProgress?.({ page: done, totalPages, count: books.size });
  // 남은 페이지를 concurrency개 워커가 나눠 받음 (각 워커는 순차 + 지연)
  let next = 1;
  const worker = async () => {
    while (next < totalPages) {
      const i = next++;
      if (shouldStop()) throw new Error('중단됨');
      await sleep(delay);
      try {
        add(p.items(await fetchPage(lib, p, start + i)));
      } catch (e) {
        failed++;
        console.error(`[${lib.name}] p${start + i} failed:`, e.message);
      }
      onProgress?.({ page: ++done, totalPages, count: books.size });
    }
  };
  await Promise.all(Array.from({ length: p.concurrency || 1 }, worker));
  return { books: [...books.values()], total, failed };
}

// 책 상세 페이지 주소 템플릿 ({id} 자리에 도서관별 책 ID)
const detailUrlTemplate = (lib) => PLATFORMS[lib.platform].detail(lib, '{id}');

module.exports = { LIBRARIES, crawlLibrary, fetchPage, PLATFORMS, detailUrlTemplate };

// 테스트: node libraries.js [key...] → 각 도서관 첫 페이지 파싱 결과 출력
if (require.main === module) {
  (async () => {
    const keys = process.argv.slice(2);
    const libs = keys.length ? LIBRARIES.filter(l => keys.includes(l.key)) : LIBRARIES;
    await Promise.all(libs.map(async lib => {
      const p = PLATFORMS[lib.platform];
      try {
        const page = await fetchPage(lib, p, 1);
        const items = p.items(page);
        console.log(`${lib.name} [${lib.platform}] total=${p.total(page)} items=${items.length}`, JSON.stringify(items[0]));
      } catch (e) {
        console.log(`${lib.name} [${lib.platform}] ERROR ${e.message}`);
      }
    }));
  })();
}
