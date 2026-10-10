<#
  Concord Nova — перенос сервера на другой компьютер (запускается в Windows).

  1. Новый сервер (вход по SSH-ключу): проверка, что он работает, пуст и той же версии.
  2. Старый сервер (пароль root — 1-й раз): Concord Nova там останавливается, все данные
     скачиваются на этот компьютер. Копия остаётся в папке «Concord Nova перенос».
  3. Новый сервер: данные встают на место, Concord Nova запускается с ними.
  4. Старый сервер (пароль root — 2-й раз): дальше он только пересылает всё на новый,
     так что приложения со старым адресом продолжают работать.
  Если шаги 2–3 не получатся, старый сервер запускается снова, как был.
  -CheckOnly: только шаг 1 (ничего не меняет).

  powershell -ExecutionPolicy Bypass -File deploy\move\move-server.ps1 `
    -Old root@<старый IP> -New <логин>@<новый IP> -NewPort 2222 -NewDomain <новый-ip>.sslip.io
#>
param(
  [Parameter(Mandatory = $true)] [string]$Old,
  [Parameter(Mandatory = $true)] [string]$New,
  [Parameter(Mandatory = $true)] [string]$NewDomain,
  [int]$NewPort = 22,
  [string]$NewKey = "$env:USERPROFILE\.ssh\concord_nova_server",
  [switch]$CheckOnly
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$ssh = "$env:SystemRoot\System32\OpenSSH\ssh.exe"
$oldHost = ($Old -split "@")[-1]
$newHost = ($New -split "@")[-1]
$oldDomain = ($oldHost -replace "\.", "-") + ".sslip.io"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dir = Join-Path $env:USERPROFILE "Concord Nova перенос"
New-Item -ItemType Directory -Force $dir | Out-Null
$archive = Join-Path $dir "nova-move-$stamp.tar.gz"
Start-Transcript -Path (Join-Path $dir "move-$stamp.log") | Out-Null

$toNew = @("-i", $NewKey, "-p", $NewPort, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", $New)
$toOld = @("-o", "ConnectTimeout=20", "-o", "StrictHostKeyChecking=accept-new", $Old)

function Step([string]$text) { Write-Host ""; Write-Host "■ $text" -ForegroundColor Cyan }

# ssh with stdin/stdout from/to files: Start-Process hands it the files themselves, byte for byte
# (a PowerShell 5 pipe would garble the archive); the password prompt stays in this window.
# Exit code 255 = the connection itself failed, the remote command never ran: with $tries it's
# tried again — a home router may drop a quick new connection to a forwarded port.
function Run([string[]]$target, [string]$remote, [string]$in = "", [string]$out = "", [int]$tries = 1) {
  for ($i = 1; ; $i++) {
    $p = @{ FilePath = $ssh; ArgumentList = ($target + "`"$remote`""); NoNewWindow = $true; Wait = $true; PassThru = $true }
    if ($in) { $p.RedirectStandardInput = $in }
    if ($out) { $p.RedirectStandardOutput = $out }
    $rc = (Start-Process @p).ExitCode
    if ($rc -ne 255 -or $i -ge $tries) { return $rc }
    Write-Host "   (соединение оборвалось — пробую снова через $(5 * $i) с)"
    Start-Sleep -Seconds (5 * $i)
  }
}
function Health([string]$domain) {
  try { (Invoke-RestMethod -Uri "https://$domain/health" -TimeoutSec 15).version } catch { $null }
}

$oldStopped = $false
try {
  Step "1/4 Проверка: старый $oldDomain, новый $NewDomain"
  $vOld = Health $oldDomain
  $vNew = Health $NewDomain
  Write-Host "   версии: старый $vOld, новый $vNew"
  if (-not $vOld -or -not $vNew) { throw "один из серверов не отвечает по https" }
  if ($vOld -ne $vNew) { throw "версии разные ($vOld и $vNew): сначала обновите сервер с более старой версией" }
  $count = Join-Path $dir "users-$stamp.txt"
  $rc = Run $toNew "cat > /tmp/nova-import.sh && sudo -n sqlite3 /var/lib/nova/nova.db 'SELECT COUNT(*) FROM User;'" "$here\import.sh" $count 4
  $users = "$(Get-Content $count -ErrorAction SilentlyContinue)".Trim()
  Remove-Item $count -ErrorAction SilentlyContinue
  if ($rc -ne 0) { throw "нет доступа к новому серверу по ключу (или sudo там просит пароль)" }
  if ($users -ne "0") { throw "на новом сервере уже есть аккаунты ($users) — перенос остановлен, ничего не тронуто" }
  Write-Host "   новый сервер готов: работает, пуст, версия та же"
  if ($CheckOnly) { Write-Host ""; Write-Host "Проверка пройдена — можно переносить." -ForegroundColor Green; exit 0 }

  Step "2/4 Старый сервер: остановка и выгрузка данных — введите пароль root от $oldHost"
  $oldStopped = $true
  if ((Run $toOld "bash -s" "$here\export.sh" $archive) -ne 0) { throw "выгрузка со старого сервера не удалась" }
  $size = (Get-Item $archive).Length
  $list = & "$env:SystemRoot\System32\tar.exe" -tzf $archive 2>$null
  if ($size -lt 1024 -or -not ($list -contains "./move.db")) { throw "архив с данными неполный" }
  Write-Host ("   скачано {0:N1} МБ → {1}" -f ($size / 1MB), $archive)

  Step "3/4 Новый сервер: данные на место"
  if ((Run $toNew "sudo -n bash /tmp/nova-import.sh" $archive "" 4) -ne 0) { throw "новый сервер не принял данные" }

  Step "4/4 Старый сервер: пересылка на новый — введите пароль root от $oldHost ещё раз"
  if ((Run $toOld "bash -s -- $NewDomain $newHost" "$here\forward.sh") -ne 0) {
    Write-Host "   Пересылка не включилась. Данные уже на новом сервере, старый остановлен." -ForegroundColor Yellow
    Write-Host "   Напишите Claude — этот шаг можно повторить отдельно." -ForegroundColor Yellow
    exit 1
  }
  $oldStopped = $false

  Start-Sleep -Seconds 2
  try {
    $r = Invoke-WebRequest -Uri "https://$oldDomain/health" -UseBasicParsing -TimeoutSec 15
    Write-Host "   https://$oldDomain → $($r.Headers['X-Nova-Forwarded-To']): $($r.Content)"
  } catch { Write-Host "   (проверка старого адреса не ответила: $_)" -ForegroundColor Yellow }
  Write-Host ""
  Write-Host "ГОТОВО: Concord Nova теперь на https://$NewDomain, старый адрес пересылает туда." -ForegroundColor Green
  Write-Host "Копия данных: $archive (храните её или удалите — в ней база и секрет сервера)."
} catch {
  Write-Host ""
  Write-Host "ОШИБКА: $_" -ForegroundColor Red
  if ($oldStopped) {
    Write-Host "Возвращаю старый сервер — введите пароль root от ${oldHost}:" -ForegroundColor Yellow
    if ((Run $toOld "systemctl start nova && echo 'Concord Nova on the old server is running again'") -ne 0) {
      Write-Host "Не получилось — на старом сервере выполните: systemctl start nova" -ForegroundColor Red
    }
  }
  exit 1
} finally {
  Stop-Transcript | Out-Null
}
