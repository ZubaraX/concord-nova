@echo off
chcp 65001 >nul
rem Concord Nova: install / update the server with a double click.
rem First run removes the old Concord (archived to /root first, data imported).
rem Later runs just update Nova. Change the address below for another server.
set SERVER=root@138.16.224.172
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
where node >nul 2>nul || (echo Нужен Node.js 24: https://nodejs.org & pause & exit /b 1)
where ssh >nul 2>nul || (echo Нет ssh. Включите "Клиент OpenSSH" в Параметры - Приложения - Дополнительные компоненты. & pause & exit /b 1)
echo.
echo  Concord Nova: установка или обновление на %SERVER%
echo  Перед обновлением база данных копируется в /var/lib/nova/backups.
echo  Старый Concord (если он ещё есть) сохраняется в архив /root/concord-backup-*.tar.gz,
echo  его аккаунты и сообщения переносятся в Nova, затем он удаляется.
echo  Когда ssh спросит пароль, введите пароль root (символы не отображаются).
echo  Обновление занимает 5-15 минут.
echo.
set NOVA_ADMIN=
set /p NOVA_ADMIN= Ваш логин или email в Nova - он получит права администратора (Enter - пропустить):
echo.
if defined NOVA_ADMIN (node deploy\push.mjs %SERVER% --purge-old --admin "%NOVA_ADMIN%") else (node deploy\push.mjs %SERVER% --purge-old)
echo.
if errorlevel 1 (echo  Установка не завершилась. Скопируйте текст выше и пришлите его.) else (echo  Готово: https://138-16-224-172.sslip.io)
pause
