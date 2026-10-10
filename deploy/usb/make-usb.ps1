<#
  Concord Nova — установочная флешка сервера (Windows).

  1. Скачивает Ubuntu Server 24.04 (сверяя контрольную сумму) в deploy\usb\.cache.
  2. Добавляет к нему файлы флешки (stage.mjs): ответы установщику, меню загрузки,
     установку Concord Nova при первом запуске, Node.js и LiveKit для Linux.
  3. С правами администратора (Windows спросит) СТИРАЕТ выбранный USB-диск, делает на нём
     раздел NOVA (FAT32, 16 ГБ, загрузка UEFI) и раздел NOVA-FILES (exFAT, остальное) и копирует всё.

  powershell -ExecutionPolicy Bypass -File deploy\usb\make-usb.ps1 -Disk <номер>
  (номер — из списка USB-дисков, который скрипт покажет, если его не указать)
#>
param(
  [int]$Disk = -1,
  [string]$Key = "$env:USERPROFILE\.ssh\concord_nova_server.pub",
  # Внутреннее: вторая половина, с правами администратора.
  [switch]$Write,
  [string]$Serial = "",
  [string]$Image = ""
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$cache = Join-Path $here ".cache"
$log = Join-Path $cache "write-usb.log"

$ISO_NAME = "ubuntu-24.04.5-live-server-amd64.iso"
$ISO_URL = "https://releases.ubuntu.com/24.04/$ISO_NAME"
$ISO_SHA256 = "97f3d7ffb032c3eb3b23d2c8be9cc76e60c2c1f2c0146ba5ba9fe01cafae0fd8"

function Usb-Disks { Get-Disk | Where-Object { $_.BusType -eq "USB" -and -not $_.IsBoot -and -not $_.IsSystem } }

# ── вторая половина: диск (запускается с правами администратора) ─────────────
if ($Write) {
  Start-Transcript -Path $log -Force | Out-Null
  try {
    $d = Get-Disk -Number $Disk
    if ($d.BusType -ne "USB" -or $d.IsBoot -or $d.IsSystem) { throw "Диск $Disk — не USB-флешка" }
    if ($d.SerialNumber -ne $Serial) { throw "Диск $Disk уже не тот (серийный номер изменился) — ничего не стёрто" }
    Write-Host "Стираю $($d.FriendlyName) ($([math]::Round($d.Size / 1GB)) ГБ)…"
    if ($d.IsOffline) { Set-Disk -Number $Disk -IsOffline $false }
    if ($d.IsReadOnly) { Set-Disk -Number $Disk -IsReadOnly $false }
    Clear-Disk -Number $Disk -RemoveData -RemoveOEM -Confirm:$false -ErrorAction SilentlyContinue
    Initialize-Disk -Number $Disk -PartitionStyle MBR -ErrorAction SilentlyContinue
    if ((Get-Disk -Number $Disk).PartitionStyle -ne "MBR") { Set-Disk -Number $Disk -PartitionStyle MBR }
    $boot = New-Partition -DiskNumber $Disk -Size 16GB -IsActive -AssignDriveLetter
    Format-Volume -Partition $boot -FileSystem FAT32 -NewFileSystemLabel "NOVA" -Confirm:$false -Force | Out-Null
    $rest = New-Partition -DiskNumber $Disk -UseMaximumSize -AssignDriveLetter
    Format-Volume -Partition $rest -FileSystem exFAT -NewFileSystemLabel "NOVA-FILES" -Confirm:$false -Force | Out-Null
    $to = "$((Get-Partition -DiskNumber $Disk -PartitionNumber $boot.PartitionNumber).DriveLetter):\"
    Write-Host "Копирую на $to (несколько минут)…"
    robocopy $Image $to /E /R:2 /W:2 /NFL /NDL /NJH /NP | Out-Host
    if ($LASTEXITCODE -ge 8) { throw "Копирование не удалось (robocopy $LASTEXITCODE)" }
    # Сверка: то, что легло на флешку, совпадает с образом.
    foreach ($f in @("casper\ubuntu-server-minimal.ubuntu-server.installer.squashfs", "EFI\boot\bootx64.efi", "autoinstall.yaml", "nova\src.tar.gz")) {
      if ((Get-FileHash (Join-Path $Image $f)).Hash -ne (Get-FileHash (Join-Path $to $f)).Hash) { throw "Файл $f записался с ошибкой" }
    }
    Write-Host "ГОТОВО: флешка $to записана и проверена." -ForegroundColor Green
    "OK $to" | Out-File -Encoding utf8 (Join-Path $cache "write-usb.result")
  } catch {
    Write-Host "ОШИБКА: $_" -ForegroundColor Red
    "FAIL $_" | Out-File -Encoding utf8 (Join-Path $cache "write-usb.result")
  } finally {
    Stop-Transcript | Out-Null
  }
  Start-Sleep -Seconds 5
  exit
}

# ── первая половина: образ ───────────────────────────────────────────────────
if ($Disk -lt 0) {
  Write-Host "USB-диски:"
  Usb-Disks | Format-Table Number, FriendlyName, SerialNumber, @{ n = "ГБ"; e = { [math]::Round($_.Size / 1GB) } } | Out-Host
  Write-Host "Запустите снова с -Disk <номер>. ВСЁ на этом диске будет стёрто."
  exit 1
}
$target = Usb-Disks | Where-Object Number -eq $Disk
if (-not $target) { throw "Диск $Disk — не USB-флешка (или системный)" }
New-Item -ItemType Directory -Force $cache | Out-Null

$iso = Join-Path $cache $ISO_NAME
if (-not (Test-Path $iso) -or (Get-FileHash $iso).Hash -ne $ISO_SHA256.ToUpper()) {
  Write-Host "Скачиваю $ISO_NAME (4 ГБ)…"
  curl.exe -fL --retry 5 -C - -o $iso $ISO_URL
  if ((Get-FileHash $iso).Hash -ne $ISO_SHA256.ToUpper()) { throw "Образ Ubuntu скачался с ошибкой (контрольная сумма)" }
}

$image = Join-Path $cache "image"
Write-Host "Распаковываю Ubuntu…"
if (Test-Path $image) { Remove-Item -Recurse -Force $image }
New-Item -ItemType Directory $image | Out-Null
# (Три ссылки образа — ubuntu, dists/stable, dists/unstable — на FAT32 не нужны и не ложатся:
# tar сообщит о них ошибкой; проверяем сами файлы загрузки.)
& "$env:SystemRoot\System32\tar.exe" -xf $iso -C $image 2>$null
foreach ($f in @(".disk\info", "EFI\boot\bootx64.efi", "boot\grub\grub.cfg", "casper\vmlinuz", "casper\initrd")) {
  if (-not (Test-Path (Join-Path $image $f))) { throw "Образ Ubuntu не распаковался ($f)" }
}
attrib -R "$image\*" /S /D | Out-Null

Write-Host "Файлы Concord Nova…"
$stage = Join-Path $cache "stage"
$stageArgs = @("$here\stage.mjs", "--out", $stage, "--cache", $cache)
if (Test-Path $Key) { $stageArgs += @("--key", $Key) }
node @stageArgs
if ($LASTEXITCODE -ne 0) { throw "stage.mjs не отработал" }
robocopy $stage $image /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Не удалось сложить образ флешки" }

Remove-Item -Force (Join-Path $cache "write-usb.result") -ErrorAction SilentlyContinue
Write-Host "Записываю на $($target.FriendlyName) — Windows попросит права администратора…"
$self = $PSCommandPath
Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList @(
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$self`"",
  "-Write", "-Disk", $Disk, "-Serial", "`"$($target.SerialNumber)`"", "-Image", "`"$image`""
)
$result = Get-Content (Join-Path $cache "write-usb.result") -ErrorAction SilentlyContinue
Write-Host $result
if ($result -notlike "OK*") { exit 1 }
