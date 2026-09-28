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
echo  Concord Nova: установка на %SERVER%
echo  Старый Concord (если он есть) будет сохранён в архив /root/concord-backup-*.tar.gz,
echo  его аккаунты и сообщения перенесутся в Nova, затем он будет удалён.
echo  Когда ssh спросит пароль, введите пароль root (символы не отображаются).
echo  Установка занимает 5-15 минут.
echo.
node deploy\push.mjs %SERVER% --purge-old
echo.
if errorlevel 1 (echo  Установка не завершилась. Скопируйте текст выше и пришлите его.) else (echo  Готово: https://138-16-224-172.sslip.io)
pause
