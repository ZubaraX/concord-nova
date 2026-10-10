@echo off
chcp 65001 >nul
rem Concord Nova moved to another server (deploy/move). The old VPS only forwards to it, and
rem every release updates the new server by itself (GitHub Actions, deploy.yml: DEPLOY_HOST / DEPLOY_PORT).
rem The old installer run against the VPS would bring its stale copy back, so this no longer runs it.
echo.
echo  Concord Nova переехала на новый сервер. Старый VPS только пересылает на него.
echo  Обновления сервера ставятся сами при каждом выпуске (GitHub Actions) - запускать этот файл больше не нужно.
echo  Если обновление не пришло, напишите Claude.
echo.
pause
