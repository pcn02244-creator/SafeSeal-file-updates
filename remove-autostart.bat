@echo off
schtasks /delete /tn "SafeSeal DRM Bridge" /f
echo 자동시작 등록이 제거되었습니다.
pause
