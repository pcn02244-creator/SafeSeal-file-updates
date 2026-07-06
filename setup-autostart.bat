@echo off
title DRM Bridge 자동시작 등록
cd /d "%~dp0"

echo DRM Bridge 자동시작을 등록합니다...

schtasks /delete /tn "SafeSeal DRM Bridge" /f >nul 2>&1

schtasks /create /tn "SafeSeal DRM Bridge" /tr "wscript.exe \"%~dp0drm-bridge-silent.vbs\"" /sc onlogon /rl limited /f

if %errorlevel% == 0 (
  echo.
  echo  [완료] 등록됐습니다. 지금 바로 백그라운드 실행도 시작합니다.
  wscript.exe "%~dp0drm-bridge-silent.vbs"
  echo  DRM Bridge가 백그라운드에서 실행 중입니다.
  echo  앞으로 PC를 켤 때마다 자동으로 실행됩니다.
) else (
  echo.
  echo  [오류] 관리자 권한으로 다시 실행해 주세요.
)

pause
