# D-178 S1 -- boot smoke for the Windows binaries. Runs ON the Windows machine.
#
# !! --version AND --help ARE NOT A SMOKE TEST. Neither opens the database, so
# both pass on a binary whose native addon is missing or the wrong architecture
# -- which is exactly what a cross-arch build invites, and exactly what a silent
# `npm rebuild` no-op produced once. Measured: a binary printed its version
# correctly and then failed D178_SIDECAR_MISSING on the first real command.
#
# So this BOOTS each binary and asserts on the two things a broken addon cannot
# fake: the SQLite file appears on disk, the port accepts a connection, and the
# WebSocket endpoint answers a real upgrade.
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
  [string] $ExpectedVersion = '',
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

  $reportedVersion = ''
  $versionOk = $false
  try {
    $reportedVersion = ((& $bin --version 2>&1 | Out-String).Trim())
    $versionOk = ($LASTEXITCODE -eq 0) -and ($ExpectedVersion -ne '') -and ($reportedVersion -ceq $ExpectedVersion)
  } catch { $versionOk = $false }
  Write-Output ('  version      = ' + $(if ($versionOk) { $reportedVersion } else { "FAILED (got '$reportedVersion', expected '$ExpectedVersion')" }))

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

  # !! A TCP CONNECT IS NOT A WORKING SERVER. `port-listens` only proves the
  # HTTP listener bound; a binary whose WebSocket layer is dead passes it every
  # time. That shipped: `ws-server` reached the socket library through a
  # createRequire() shadow the bundler cannot see, so the SEA had no `ws` at
  # runtime, a stub handle took over, and its upgrade callback destroyed every
  # socket without writing a byte. Servers booted, printed a pairing code,
  # served /health 200 -- and could not be paired to by anything, for four
  # weeks of releases. Speak a real upgrade instead.
  $wsStatus = ''
  try {
    $wc = New-Object Net.Sockets.TcpClient
    $wc.Connect('127.0.0.1', $port)
    $ws = $wc.GetStream()
    $ws.ReadTimeout = 15000
    $req = "GET /ws HTTP/1.1`r`nHost: 127.0.0.1`r`nConnection: Upgrade`r`n" +
           "Upgrade: websocket`r`nSec-WebSocket-Version: 13`r`n" +
           "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==`r`n`r`n"
    $reqBytes = [Text.Encoding]::ASCII.GetBytes($req)
    $ws.Write($reqBytes, 0, $reqBytes.Length)
    $ws.Flush()
    $buf = New-Object byte[] 256
    $read = $ws.Read($buf, 0, $buf.Length)
    if ($read -gt 0) {
      $wsStatus = (([Text.Encoding]::ASCII.GetString($buf, 0, $read)) -split "`r`n")[0]
    }
    $wc.Close()
  } catch { $wsStatus = '' }
  # Two fatal shapes: EMPTY (socket destroyed in silence -- the original bug)
  # and 503 (that same dead layer after it was taught to answer). A live handler
  # refuses an unauthenticated upgrade with 401.
  $wsOk = ($wsStatus -like 'HTTP/*') -and ($wsStatus -notmatch '503')

  Write-Output ('  db-created   = ' + $dbSeen)
  Write-Output ('  port-listens = ' + $portSeen)
  Write-Output ('  ws-upgrade   = ' + $(if ($wsStatus -eq '') { '(no reply -- socket destroyed)' } else { $wsStatus }))
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

  # !! AND `recued start` -- THE SAME DEFECT CLASS AS THE ws PROBE ABOVE.
  # daemon.ts built its child command one way only: `npx tsx <dir>/bin.ts`.
  # That is right from a source checkout and impossible in a packaged binary --
  # there is no bin.ts on disk, import.meta.dirname is not a directory, so the
  # path fell back to the process CWD and the daemon spawned whatever node and
  # tsx were on PATH. On a Windows box with no Node installed, npx is not even
  # spawnable. `recued status` then said "stopped", accurately, which is why it
  # read as a status bug. Foreground serve cannot see this: the whole defect is
  # in the step where the process re-launches ITSELF.
  # !! ITS OWN DIRECTORY, not just its own db file. The realm lock is
  # {data_path}\recued-server.lock, keyed on the DIRECTORY -- and the foreground
  # server above is still running out of $root, so a sibling db there is refused
  # with "already running against this data folder" and this gate would report a
  # defect that is not there.
  $dmnRoot = Join-Path $root 'daemon'
  New-Item -ItemType Directory -Force -Path $dmnRoot | Out-Null
  $dmnDb = Join-Path $dmnRoot 'daemon-smoke.db'
  $dmnPort = $port + 100
  $dmnOk = $false
  try {
    & $bin start --db $dmnDb --port "$dmnPort" 2>&1 | Out-Null
    $dmnOut = (& $bin status --db $dmnDb --port "$dmnPort" 2>&1 | Out-String)
    # The banner prints 'Status:    Running'; the status VERB prints 'Status:  running'.
    $dmnOk = $dmnOut -match 'Status:\s*running'
    & $bin stop --db $dmnDb 2>&1 | Out-Null
  } catch { $dmnOk = $false }
  Write-Output ('  daemon-start = ' + $(if ($dmnOk) { 'start -> status: running' } else { 'FAILED (start produced nothing status can see)' }))

  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
  $results += ("$triple=" + $(if ($versionOk -and $dbSeen -and $portSeen -and $wsOk -and $dmnOk) { 'OK' } else { 'FAILED' }))
  $port++
}

Write-Output '== summary =='
$results | ForEach-Object { Write-Output ('  ' + $_) }
if (($results -join ' ') -match 'FAILED|MISSING') { Write-Output 'SMOKE-FAILED' } else { Write-Output 'SMOKE-OK' }
