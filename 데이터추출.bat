@echo off
chcp 65001 > nul
echo.
echo ========================================
echo    엑셀 데이터 추출 중...
echo ========================================
echo.
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0data\extract.ps1"

echo.
echo 완료! 이제 앱에서 [엑셀 최신화] 버튼을 누르세요.
echo.
pause
