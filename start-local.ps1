$ErrorActionPreference = 'Stop'

$port = if ($env:PORT) { [int]$env:PORT } else { 3000 }
$healthUrl = "http://127.0.0.1:$port/api/health"
$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existing) {
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
    if ($health.ok) {
      Write-Output "Nerdearla Live ya está activo en http://localhost:$port (PID $($existing.OwningProcess))."
      exit 0
    }
  } catch {
    throw "El puerto $port ya está ocupado por otro proceso (PID $($existing.OwningProcess))."
  }
}

$node = Get-Command node -ErrorAction SilentlyContinue
$bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if (Test-Path $bundledNode) {
  $nodePath = $bundledNode
} elseif ($node) {
  $nodePath = $node.Source
} else {
  throw 'No encontramos Node.js. Instalá Node.js 20 o posterior y volvé a iniciar.'
}

$nodeVersion = (& $nodePath --version).Trim()
if ($nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) {
  throw "Esta app necesita Node.js 20 o posterior; encontramos $nodeVersion."
}

$process = Start-Process -FilePath $nodePath -ArgumentList 'server.js' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  Start-Sleep -Milliseconds 300
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
    if ($health.ok) {
      Write-Output "Nerdearla Live está activo en http://localhost:$port (PID $($process.Id))."
      exit 0
    }
  } catch { }
  if ($process.HasExited) { throw "El servidor se cerró al iniciar (código $($process.ExitCode)). Revisá que .env y las dependencias estén configurados." }
}

throw "El servidor no respondió en $healthUrl. Revisá Node.js, .env y el puerto $port."
