param([int]$Port = 8787)

$ErrorActionPreference = 'Stop'
$taskRepository = Split-Path -Parent $PSScriptRoot
$taskStateDirectory = Join-Path ([IO.Path]::GetTempPath()) 'freeegg-worker-preview-state'

# Wrangler 4.148.0 watches all of assets.directory, even .assetsignore paths.
# Keep Miniflare's SQLite files outside this repository to avoid self-reloads.
# .gitignore keeps generated/private files out of Git; it does not fix the watcher.
Push-Location -LiteralPath $taskRepository
try {
  & pnpm dlx 'wrangler@4.148.0' dev --local --port $Port --ip 127.0.0.1 `
    --show-interactive-dev-session=false --persist-to $taskStateDirectory
  if ($LASTEXITCODE -ne 0) { throw "Local Worker exited with code $LASTEXITCODE." }
} finally {
  Pop-Location
}
