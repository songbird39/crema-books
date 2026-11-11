#!/bin/bash
# 지금 데이터(크레마·도서관·밀리·베스트셀러)를 담은 배포용 zip을 만듭니다. 즐겨찾기는 비워서 넣습니다.
cd "$(dirname "$0")"
OUT="dist/BookBrowser"
rm -rf dist && mkdir -p "$OUT"
cp -R server.js libraries.js match.js retention.js index.html package.json package-lock.json certs awards node_modules start.command start.bat "$OUT/"
for f in data.json data-libs.json data-seoul.json data-millie.json; do [ -f "$f" ] && cp "$f" "$OUT/"; done
echo '{ "items": [] }' > "$OUT/data-favorites.json"
cat > "$OUT/README.txt" <<'TXT'
도서 브라우저 — 크레마클럽 · 밀리의 서재 · 서울 도서관 25곳 전자책을 한 번에 찾아보기

1. Node.js가 필요해요 (https://nodejs.org 에서 LTS 설치).
2. Mac: "start.command"를 더블클릭 (처음엔 우클릭 → 열기).
   Windows: "start.bat"을 더블클릭.
3. 브라우저가 http://localhost:3456 으로 열려요. 터미널 창을 닫으면 꺼져요.

데이터는 배포 시점 기준이에요. 화면 오른쪽 위 동기화 메뉴에서 새로 받을 수 있어요.
TXT
(cd dist && zip -qry BookBrowser.zip BookBrowser)
echo "만들었어요: $(pwd)/dist/BookBrowser.zip ($(du -h "dist/BookBrowser.zip" | cut -f1))"

