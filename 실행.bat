@echo off
chcp 65001 > nul
echo.
echo ========================================
echo    파트 단가 관리 시스템 시작 중...
echo ========================================
echo.
cd /d "%~dp0"

if not exist node_modules (
  echo 처음 실행 - 패키지 설치 중...
  npm install
  echo.
)

echo 브라우저가 자동으로 열립니다.
echo 이 창을 닫으면 시스템이 종료됩니다.
echo.
start http://localhost:3000
node app.js
pause
