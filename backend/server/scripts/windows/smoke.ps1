# D-178 S1 -- boot smoke for the Windows binaries. Runs ON the Windows machine.
#
# !! --version AND --help ARE NOT A SMOKE TEST. Neither opens the database, so
# both pass on a binary whose native addon is missing or the wrong architecture
# -- which is exactly what a cross-arch build invites, and exactly what a silent
# `npm rebuild` no-op produced once. Measured: a binary printed its version
# correctly and then failed D178_SIDECAR_MISSING on the first real command.
#
# So this BOOTS each binary and asserts on the two things a broken addon cannot
# fake: the SQLite file appears on disk, and the port accepts a connection.
#
# Each triple gets its own port and data directory, so a stale listener or a
# leftover keyfile can never make a failure look like a pass.
#
# ASCII only; the driver adds a UTF-8 BOM.

param(
  [string] $Triples   = 'windows-x64,windows-arm64',
  [string] $Artifacts = 'C:\artifacts',
  [int]    $BasePort  = 7791,
  [int]    $TimeoutSec= 45,
  # PROTOTYPE (single-file): '1' INVERTS the sidecar assertion below. A binary
  # carrying the addon as a SEA asset must boot with NO lib\better_sqlite3.node
  # present -- and if one were lying around, the run would prove nothing about
  # the embedded path, because createRequire would happily load the file.
  # !! [string] not [switch]: `powershell -File` passes args literally.
  [string] $EmbedAddon = '0'
)

$ErrorActionPreference = 'Continue'
$results = @()
$port = $BasePort

foreach ($triple in ($Triples -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
  $bin  = Join-Path $Artifacts "$triple\recued-$triple.exe"
  $root = Join-Path $env:USERPROFILE "smoke-$triple"
  Write-Output "== $triple =="

  if (-not (Test-Path $bin)) { Write-Output '  MISSING BINARY'; $results += "$triple=MISSING"; $port++; continue }
  $sidecar = Join-Path $Artifacts "$triple\lib\better_sqlite3.node"
  if ($EmbedAddon -eq '1') {
    # Single-file prototype: the sidecar must be ABSENT. Present, it would load
    # normally and the run would say nothing about the embedded asset -- the
    # test would pass for the wrong reason, which is worse than failing.
    if (Test-Path $sidecar) {
      Remove-Item -Force $sidecar -ErrorAction SilentlyContinue
      Write-Output '  removed a stray sidecar so the embedded path is what gets exercised'
    }
    Write-Output '  sidecar ABSENT by design (addon must come from the SEA asset)'
  } else {
    # The sidecar must sit at lib\better_sqlite3.node BESIDE the exe -- that is what
    # the binary's createRequire looks for, and its absence is the failure this
    # whole script exists to catch.
    if (-not (Test-Path $sidecar)) {
      Write-Output '  MISSING SIDECAR'; $results += "$triple=MISSING"; $port++; continue
    }
  }

  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $db  = Join-Path $root 'recued-server.db'
  $out = Join-Path $root 'boot.out'
  $err = Join-Path $root 'boot.err'

  $p = Start-Process -FilePath $bin -ArgumentList @('--db', $db, '--port', "$port") `
       -WorkingDirectory $root -PassThru -NoNewWindow `
       -RedirectStandardOutput $out -RedirectStandardError $err

  # Poll rather than sleep-then-check: a merely slow boot should still pass, and
  # a dead one should be reported as dead rather than as a timeout.
  $dbSeen = $false; $portSeen = $false; $exited = $false
  foreach ($i in 1..$TimeoutSec) {
    Start-Sleep -Milliseconds 1000
    if (-not $dbSeen) { $dbSeen = Test-Path $db }
    if (-not $portSeen) {
      try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $port); $portSeen = $c.Connected; $c.Close() } catch {}
    }
    if ($p.HasExited) { $exited = $true; break }
    if ($dbSeen -and $portSeen) { break }
  }

  Write-Output ('  db-created   = ' + $dbSeen)
  Write-Output ('  port-listens = ' + $portSeen)
  Write-Output ('  exited-early = ' + $exited)
  if ($exited) { Write-Output ('  exit-code    = ' + $p.ExitCode) }

  # The banner is UTF-8 box drawing and the SSH transport mangles it; pull the
  # few ASCII facts that matter instead of dumping it.
  if (Test-Path $out) {
    Get-Content $out | Select-String -Pattern 'Version:|Recipes:|Status:' | ForEach-Object { Write-Output ('  | ' + $_.Line.Trim()) }
  }
  if (Test-Path $err) {
    Get-Content $err | Select-String -Pattern 'Error|FATAL|MISSING' | Select-Object -First 3 | ForEach-Object { Write-Output ('  ! ' + $_.Line.Trim()) }
  }

  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
  $results += ("$triple=" + $(if ($dbSeen -and $portSeen) { 'OK' } else { 'FAILED' }))
  $port++
}

Write-Output '== summary =='
$results | ForEach-Object { Write-Output ('  ' + $_) }
if (($results -join ' ') -match 'FAILED|MISSING') { Write-Output 'SMOKE-FAILED' } else { Write-Output 'SMOKE-OK' }
