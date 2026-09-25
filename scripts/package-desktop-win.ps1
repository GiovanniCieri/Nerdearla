$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'dist'))
$outputDirectory = [System.IO.Path]::GetFullPath((Join-Path $distRoot "Nerdearla-Live-win32-x64-v$($package.version)"))
$distPrefix = $distRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $outputDirectory.StartsWith($distPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'El destino de compilación debe permanecer dentro de dist.'
}

$electronDistribution = Join-Path $repoRoot 'node_modules\electron\dist'
$extensionSource = Join-Path $repoRoot 'extension'
$chromiumInstallerSource = Join-Path $repoRoot 'scripts\install-chromium-win.ps1'
if (-not (Test-Path -LiteralPath (Join-Path $electronDistribution 'electron.exe'))) {
  throw 'No encontramos Electron. Ejecutá corepack pnpm install antes de empaquetar.'
}
if (-not (Test-Path -LiteralPath (Join-Path $extensionSource 'manifest.json'))) {
  throw 'No encontramos la extensión de captura.'
}

if (Test-Path -LiteralPath $outputDirectory) {
  Remove-Item -LiteralPath $outputDirectory -Recurse -Force
}
New-Item -ItemType Directory -Path $outputDirectory | Out-Null
Copy-Item -Path (Join-Path $electronDistribution '*') -Destination $outputDirectory -Recurse -Force
Rename-Item -LiteralPath (Join-Path $outputDirectory 'electron.exe') -NewName 'Nerdearla Live.exe'

$resourcesDirectory = Join-Path $outputDirectory 'resources'
$runtimeAppDirectory = Join-Path $resourcesDirectory 'app'
New-Item -ItemType Directory -Path $runtimeAppDirectory -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repoRoot 'desktop') -Destination $runtimeAppDirectory -Recurse -Force
Copy-Item -LiteralPath $extensionSource -Destination $resourcesDirectory -Recurse -Force
Copy-Item -LiteralPath $chromiumInstallerSource -Destination (Join-Path $outputDirectory 'Instalar-Chromium.ps1') -Force

$runtimePackage = [ordered]@{
  name = $package.name
  productName = $package.productName
  version = $package.version
  main = $package.main
}
$runtimePackage | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeAppDirectory 'package.json') -Encoding utf8

$readme = @"
Nerdearla Live $($package.version) · aplicación nativa Windows x64

Abrí "Nerdearla Live.exe". El servidor Docker debe estar disponible en http://localhost:3001.
En Nueva transmisión, pegá el link de la charla para abrirlo en una ventana de Chromium con perfil aislado.
Si no tenés Chromium instalado, ejecutá "Instalar-Chromium.ps1". También acepta Brave, Edge o Chrome.
Cada sala usa una instancia de captura independiente, así podés procesar varias salas al mismo tiempo.
El paquete portable incluye y carga automáticamente la extensión de captura.
"@
$readme | Set-Content -LiteralPath (Join-Path $outputDirectory 'LEEME.txt') -Encoding utf8

$zipPath = "$outputDirectory.zip"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -Path (Join-Path $outputDirectory '*') -DestinationPath $zipPath -CompressionLevel Optimal

Write-Output "Ejecutable: $(Join-Path $outputDirectory 'Nerdearla Live.exe')"
Write-Output "Paquete portable: $zipPath"
