$ErrorActionPreference = 'Stop'

$revisionUrl = 'https://storage.googleapis.com/chromium-browser-snapshots/Win_x64/LAST_CHANGE'
$installDirectory = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Nerdearla\Chromium'))
$installParent = [System.IO.Path]::GetDirectoryName($installDirectory)
if (Test-Path -LiteralPath $installDirectory) {
  throw "Ya existe una instalación en $installDirectory. No se modificó."
}
New-Item -ItemType Directory -Path $installParent -Force | Out-Null

$temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$temporaryDirectory = [System.IO.Path]::GetFullPath((Join-Path $temporaryRoot "nerdearla-chromium-$([guid]::NewGuid().ToString('N'))"))
$temporaryPrefix = $temporaryRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $temporaryDirectory.StartsWith($temporaryPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'El directorio temporal no quedó dentro de la carpeta temporal del sistema.'
}
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
$installedByScript = $false

try {
  $revision = [string](Invoke-RestMethod -Uri $revisionUrl -TimeoutSec 30)
  $revision = $revision.Trim()
  if ($revision -notmatch '^\d{6,}$') { throw 'El servidor de Chromium devolvió una revisión inválida.' }
  $archive = Join-Path $temporaryDirectory 'chromium.zip'
  $archiveUrl = "https://storage.googleapis.com/chromium-browser-snapshots/Win_x64/$revision/chrome-win.zip"
  Write-Output "Descargando Chromium oficial, revisión $revision. El archivo ocupa aproximadamente 360 MB."
  Invoke-WebRequest -Uri $archiveUrl -OutFile $archive -TimeoutSec 600

  $unpackDirectory = Join-Path $temporaryDirectory 'unpacked'
  Expand-Archive -LiteralPath $archive -DestinationPath $unpackDirectory
  $browserDirectory = Join-Path $unpackDirectory 'chrome-win'
  $browserExecutable = Join-Path $browserDirectory 'chrome.exe'
  if (-not (Test-Path -LiteralPath $browserExecutable)) { throw 'El paquete descargado no contiene chrome-win\chrome.exe.' }

  New-Item -ItemType Directory -Path $installDirectory | Out-Null
  $installedByScript = $true
  Get-ChildItem -LiteralPath $browserDirectory -Force | Move-Item -Destination $installDirectory
  $installedExecutable = Join-Path $installDirectory 'chrome.exe'
  if (-not (Test-Path -LiteralPath $installedExecutable)) { throw 'No se pudo completar la instalación de Chromium.' }
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new($installedExecutable)
  $startInfo.Arguments = '--version'
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $probe = [System.Diagnostics.Process]::Start($startInfo)
  if (-not $probe.WaitForExit(5000) -or $probe.ExitCode -ne 0) {
    if (-not $probe.HasExited) { $probe.Kill() }
    throw 'Esta compilación de Chromium no pudo iniciarse en Windows. Probá otra revisión o usá Brave/Edge.'
  }
  Write-Output "Chromium instalado: $installedExecutable"
  Write-Output 'Esta compilación de desarrollo no se actualiza automáticamente; instalá una revisión nueva periódicamente.'
} catch {
  $installPrefix = $installParent.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  if ($installedByScript -and $installDirectory.StartsWith($installPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $installDirectory)) {
    Remove-Item -LiteralPath $installDirectory -Recurse -Force
  }
  throw
} finally {
  if (Test-Path -LiteralPath $temporaryDirectory) {
    $resolvedTemporary = [System.IO.Path]::GetFullPath($temporaryDirectory)
    if (-not $resolvedTemporary.StartsWith($temporaryPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'Se canceló la limpieza porque el destino temporal salió del directorio esperado.'
    }
    Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
  }
}
