@echo off
rem Concord Nova: the server USB stick. Shows the USB disks, asks which one to ERASE,
rem then Windows asks for administrator rights to write it.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-usb.ps1"
pause
