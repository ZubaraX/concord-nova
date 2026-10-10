<#
  Concord Nova — перенос сервера на другой компьютер (запускается в Windows).

  1. Новый сервер (вход по SSH-ключу): проверка, что он работает, пуст и той же версии.
  2. Старый сервер: пароль root спрашивается ОДИН раз, до любых изменений — на время переноса
     туда кладётся временный ключ (в конце он удаляется). Неверный пароль = ничего не изменилось.
     Concord Nova там останавливается, все данные скачиваются на этот компьютер; копия
     остаётся в папке «Concord Nova перенос».
  3. Новый сервер: данные встают на место, Concord Nova запускается с ними.
  4. Старый сервер: дальше он только пересылает всё на новый, так что приложения со старым
     адресом продолжают работать.
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
# The old server: its root password once (to put a temporary key there), then that key.
# ({ echo; cat; }: a file without a final newline would glue the key onto its last line.)
$moveKey = Join-Path $dir "move-key-$stamp"
$keyTag = "nova-move-$stamp"
$toOldPassword = @("-o", "ConnectTimeout=20", "-o", "StrictHostKeyChecking=accept-new", "-o", "PubkeyAuthentication=no", "-o", "NumberOfPasswordPrompts=3", $Old)
$toOld = @("-i", $moveKey, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", $Old)

function Step([string]$text) { Write-Host ""; Write-Host "■ $text" -ForegroundColor Cyan }

# ssh with stdin/stdout from/to files: Start-Process hands it the files themselves, byte for byte
# (a PowerShell 5 pipe would garble the archive); a password prompt stays in this window.
# (import.sh waits in the admin's home, not in /tmp where another local user could swap it before sudo runs it.)
# (Start-Process joins its arguments as they are: one with spaces — the key in «Concord Nova перенос» — is quoted.)
# Exit code 255 = the connection itself failed, the remote command never ran: with $tries it's
# tried again — a home router may drop a quick new connection to a forwarded port.
function Run([string[]]$target, [string]$remote, [string]$in = "", [string]$out = "", [int]$tries = 1) {
  for ($i = 1; ; $i++) {
    $p = @{ FilePath = $ssh; ArgumentList = (@($target | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }) + "`"$remote`""); NoNewWindow = $true; Wait = $true; PassThru = $true }
    if ($in) { $p.RedirectStandardInput = $in }
    if ($out) { $p.RedirectStandardOutput = $out }
    $rc = (Start-Process @p).ExitCode
    if ($rc -ne 255 -or $i -ge $tries) { return $rc }
    Write-Host "   (соединение оборвалось — пробую снова через $(5 * $i) с)"
    Start-Sleep -Seconds (5 * $i)
  }
}
# (A few tries, up to half a minute: a home router may drop new connections for a while after a burst.)
function Health([string]$domain) {
  foreach ($i in 1..5) {
    try { return (Invoke-RestMethod -Uri "https://$domain/health" -TimeoutSec 15).version } catch { Start-Sleep -Seconds (3 * $i) }
  }
  $null
}

$keyPlaced = $false
$oldStopped = $false
try {
  Step "1/4 Проверка: старый $oldDomain, новый $NewDomain"
  $vOld = Health $oldDomain
  $vNew = Health $NewDomain
  Write-Host "   версии: старый $vOld, новый $vNew"
  if (-not $vOld -or -not $vNew) { throw "один из серверов не отвечает по https" }
  if ($vOld -ne $vNew) { throw "версии разные ($vOld и $vNew): сначала обновите сервер с более старой версией" }
  $count = Join-Path $dir "users-$stamp.txt"
  $rc = Run $toNew "cat > ~/nova-import.sh && chmod 700 ~/nova-import.sh && sudo -n sqlite3 /var/lib/nova/nova.db 'SELECT COUNT(*) FROM User;'" "$here\import.sh" $count 4
  $users = "$(Get-Content $count -ErrorAction SilentlyContinue)".Trim()
  Remove-Item $count -ErrorAction SilentlyContinue
  if ($rc -ne 0) { throw "нет доступа к новому серверу по ключу (или sudo там просит пароль)" }
  if ($users -ne "0") { throw "на новом сервере уже есть аккаунты ($users) — перенос остановлен, ничего не тронуто" }
  Write-Host "   новый сервер готов: работает, пуст, версия та же"
  if ($CheckOnly) { Write-Host ""; Write-Host "Проверка пройдена — можно переносить." -ForegroundColor Green; exit 0 }

  Step "2/4 Старый сервер — введите пароль root от $oldHost (один раз)"
  Write-Host "   Раскладка должна быть английской, Caps Lock выключен. Вставить пароль можно правой кнопкой мыши."
  Remove-Item -Force "$moveKey", "$moveKey.pub" -ErrorAction SilentlyContinue
  & "$env:SystemRoot\System32\OpenSSH\ssh-keygen.exe" -q -t ed25519 -N '""' -C $keyTag -f $moveKey
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$moveKey.pub")) { throw "не удалось создать временный ключ" }
  if ((Run $toOldPassword "umask 077; mkdir -p ~/.ssh && { echo; cat; } >> ~/.ssh/authorized_keys" "$moveKey.pub") -ne 0) {
    throw "вход на старый сервер не удался (пароль не подошёл?) — там ничего не изменилось, всё работает как раньше"
  }
  $keyPlaced = $true
  if ((Run $toOld "true" "" "" 3) -ne 0) { throw "временный ключ на старом сервере не сработал — там ничего не изменилось" }
  Write-Host "   вход есть; останавливаю Concord Nova на старом сервере и выгружаю данные…"
  $oldStopped = $true
  if ((Run $toOld "bash -s" "$here\export.sh" $archive 3) -ne 0) { throw "выгрузка со старого сервера не удалась" }
  $size = (Get-Item $archive).Length
  $list = & "$env:SystemRoot\System32\tar.exe" -tzf $archive 2>$null
  if ($size -lt 1024 -or -not ($list -contains "./move.db")) { throw "архив с данными неполный" }
  Write-Host ("   скачано {0:N1} МБ → {1}" -f ($size / 1MB), $archive)

  Step "3/4 Новый сервер: данные на место"
  if ((Run $toNew "sudo -n bash ~/nova-import.sh && rm -f ~/nova-import.sh" $archive "" 4) -ne 0) { throw "новый сервер не принял данные" }

  Step "4/4 Старый сервер: пересылка на новый"
  if ((Run $toOld "bash -s -- $NewDomain $newHost" "$here\forward.sh" "" 3) -ne 0) {
    $oldStopped = $false # (the data is on the new server now: the old one must not come back as it was)
    throw "пересылка не включилась. Данные уже на новом сервере, старый остановлен — напишите Claude, этот шаг можно повторить отдельно"
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
    Write-Host "Возвращаю старый сервер…" -ForegroundColor Yellow
    if ((Run $toOld "systemctl start nova && echo 'Concord Nova on the old server is running again'" "" "" 3) -ne 0) {
      Write-Host "Не получилось — на старом сервере выполните: systemctl start nova" -ForegroundColor Red
    }
  }
  $failed = $true
} finally {
  # The temporary key leaves the old server and this computer.
  if ($keyPlaced -and (Run $toOld "sed -i '/$keyTag/d' ~/.ssh/authorized_keys" "" "" 3) -ne 0) {
    Write-Host "   (временный ключ $keyTag остался в /root/.ssh/authorized_keys старого сервера — его можно удалить)" -ForegroundColor Yellow
  }
  Remove-Item -Force "$moveKey", "$moveKey.pub" -ErrorAction SilentlyContinue
  Stop-Transcript | Out-Null
}
if ($failed) { exit 1 }
