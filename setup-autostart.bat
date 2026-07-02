@echo off
title DRM Bridge 자동시작 등록
cd /d "%~dp0"

echo DRM Bridge를 Windows 시작 시 자동 실행으로 등록합니다...

schtasks /create /tn "SafeSeal DRM Bridge" /tr "node \"%~dp0drm-bridge.js\"" /sc onlogon /rl limited /f

if %errorlevel% == 0 (
  echo.
  echo  [완료] 다음 로그인부터 자동 실행됩니다.
  echo  - 작업 스케줄러에서 "SafeSeal DRM Bridge" 로 확인 가능
  echo  - 제거하려면 remove-autostart.bat 실행
) else (
  echo.
  echo  [오류] 등록 실패. 관리자 권한으로 다시 실행해 주세요.
)

pause
