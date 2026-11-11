#!/bin/bash
# 더블클릭하면 전자책 검색 서버를 켜고 브라우저를 엽니다. 이 창을 닫으면 서버가 꺼집니다.
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
URL="http://localhost:3456"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js가 없어요. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요."
  open "https://nodejs.org"
  read -n 1 -s -r -p "아무 키나 누르면 닫혀요"
  exit 1
fi

# 이미 켜져 있으면 브라우저만 연다
if curl -s -o /dev/null "$URL/api/millie/data"; then
  echo "이미 실행 중이에요. 브라우저를 엽니다: $URL"
  open "$URL"
  exit 0
fi

[ -d node_modules ] || { echo "처음 실행 — 필요한 패키지 설치 중..."; npm install --omit=dev || exit 1; }

# 서버가 뜨면 브라우저 열기
( for i in $(seq 1 60); do sleep 1; curl -s -o /dev/null "$URL/api/millie/data" && { open "$URL"; break; }; done ) &
echo "전자책 검색를 켜는 중... (이 창을 닫으면 꺼져요)"
exec node server.js
