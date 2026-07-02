@echo off
title DRM Bridge - SafeSeal
cd /d "%~dp0"
echo.
echo  DRM 파일 처리 서버를 시작합니다...
echo  GitHub Pages 앱에서 DRM 파일 업로드 시 자동으로 사용됩니다.
echo.
node drm-bridge.js
pause
