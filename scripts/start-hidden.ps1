param(
  [string]$ProjectRoot = "D:\codex\AIchat"
)

$ErrorActionPreference = "SilentlyContinue"
$serverUrl = "http://127.0.0.1:5174"
$appUrl = "http://127.0.0.1:5174"
$logDir = Join-Path $ProjectRoot "logs"
$profileDir = Join-Path $ProjectRoot ".launcher-profile"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

function Stop-ProjectPorts {
  $ids = netstat -ano |
    Select-String ':5173|:5174' |
    ForEach-Object { ($_ -split '\s+')[-1] } |
    Where-Object { $_ -match '^\d+$' -and $_ -ne '0' } |
    Sort-Object -Unique

  foreach ($id in $ids) {
    Stop-Process -Id ([int]$id) -Force
  }
}

function Wait-Server {
  for ($i = 0; $i -lt 80; $i++) {
    try {
      Invoke-WebRequest "$serverUrl/api/network" -UseBasicParsing -TimeoutSec 2 | Out-Null
      return $true
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  return $false
}

Stop-ProjectPorts

$env:PUBLIC_PORT = "5174"
$env:HOST = "0.0.0.0"

$server = Start-Process -FilePath "node" `
  -ArgumentList "server/index.js" `
  -WorkingDirectory $ProjectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir "server.out.log") `
  -RedirectStandardError (Join-Path $logDir "server.err.log") `
  -PassThru

if (-not (Wait-Server)) {
  Stop-Process -Id $server.Id -Force
  exit 1
}

$browserPath = $null
$candidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles(x86)\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles(x86)\Microsoft\Edge\Application\msedge.exe"
)

foreach ($candidate in $candidates) {
  if (Test-Path -LiteralPath $candidate) {
    $browserPath = $candidate
    break
  }
}

if (-not $browserPath) {
  Start-Process $appUrl | Out-Null
  exit 0
}

$browser = Start-Process -FilePath $browserPath `
  -ArgumentList "--new-window --user-data-dir=`"$profileDir`" --app=`"$appUrl`"" `
  -PassThru

Wait-Process -Id $browser.Id

try {
  Invoke-WebRequest "$serverUrl/api/app/shutdown" -Method POST -UseBasicParsing -TimeoutSec 3 | Out-Null
} catch {}

Start-Sleep -Seconds 2

if (-not $server.HasExited) {
  Stop-Process -Id $server.Id -Force
}

Stop-ProjectPorts
