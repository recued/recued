# D-178 S1 -- Windows SEA build, both triples, one host.
#
# Driven by scripts/build-binary-windows.mjs. Runs ON the Windows machine.
#
# Windows-on-ARM executes x64 under emulation, so ONE arm64 box builds BOTH
# triples: build-binary.mjs copies process.execPath as the SEA base and
# currentPlatformTriple() reads process.arch, so the architecture of the node
# that drives the build is the architecture of the binary that comes out. An x64
# host can only produce windows-x64 -- emulation runs down, not up.
#
# ASCII ONLY, and the driver writes it with a UTF-8 BOM. A single non-ASCII byte
# breaks the ANSI parse Windows applies to a downloaded .ps1, and the error it
# gives points nowhere near the character.
#
# $ErrorActionPreference stays Continue on purpose: npm writes progress to
# stderr, and Stop treats that as fatal. Every step is gated explicitly instead,
# and the run ends with one marker so a partial run can never read as success.

param(
  [string] $Triples  = 'windows-x64,windows-arm64',
  [string] $Root     = 'C:\build',
  [string] $Artifacts= 'C:\artifacts',
  [string] $NodeVersion = '',      # blank = read it off THIS machine's node
  [string] $UploadTo = '',         # http://10.0.2.2:PORT/upload -- empty = keep on the VM
  # PROTOTYPE (single-file): embed better_sqlite3.node into the SEA blob as an
  # asset instead of shipping it beside the exe. build-binary.mjs reads this as
  # RECUED_EMBED_ADDON. Off by default -- the sidecar layout stays the shipping
  # one until this is proven on every triple.
  # !! A [switch] would arrive as the STRING '-EmbedAddon' through `powershell
  # -File`, which passes args literally; a [string] compared to '1' survives it.
  [string] $EmbedAddon = '0'
)

$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'   # Invoke-WebRequest is ~10x faster without it

$SRV      = Join-Path $Root 'backend\server'
$BIN      = Join-Path $SRV  'dist\binary'
$PKG      = Join-Path $Root 'node_modules\better-sqlite3-multiple-ciphers'
$ADDON    = Join-Path $PKG  'build\Release\better_sqlite3.node'

function Fail($m) { Write-Output "FATAL: $m"; Write-Output 'WINBUILD-FAILED'; exit 1 }
function Say($m)  { Write-Output $m }

# PE machine type from the COFF header. 0x8664 = x64, 0xAA64 = ARM64.
#
# !! ASSERT THIS, NEVER THE SUCCESS STRING. `npm rebuild` is a NO-OP when
# build/Release is already populated -- prebuild-install skips -- and it still
# prints "rebuilt dependencies successfully". Measured: driving it with an x64
# node returned the ARM64 addon, same bytes, same length. That pairing yields a
# binary that starts fine and dies at the first database open, which is far past
# where anyone is still watching.
function Get-Machine($path) {
  $b = [IO.File]::ReadAllBytes($path)
  return [BitConverter]::ToUInt16($b, ([BitConverter]::ToInt32($b, 0x3C) + 4))
}

# !! Copy-Item DOES NOT SET $LASTEXITCODE -- that tracks native commands only. A
# run that gated on it printed BUILD-OK while two copies had failed and an
# artifact had been destroyed. Verify the destination instead.
function Assert-Copy($src, $dst) {
  Copy-Item $src $dst -Force
  if (-not (Test-Path $dst)) { Fail "copy did not land: $dst" }
  if ((Get-Item $dst).Length -ne (Get-Item $src).Length) { Fail "copy truncated: $dst" }
}

# !! THE FOREIGN RUNTIME MUST MATCH THIS MACHINE'S NODE, NOT THE DRIVER'S.
# Read it here rather than accepting it from the caller: the driver runs on
# macOS, and passing ITS process.versions.node once fetched a v25 runtime for the
# foreign triple against a v24 host. The two binaries would then embed different
# Node majors -- different ABIs -- so an addon built under one cannot load in the
# other, and nothing about the build would say so.
#
# !! AND DO NOT GATE THIS ON $LASTEXITCODE -- SECOND TIME IN THIS FILE.
# Piping a native command through Select-Object leaves $LASTEXITCODE at -1
# because the pipeline stopped early, so the first cut refused a perfectly good
# read of "24.10.0". Measured all three forms: the VALUE was right in every one,
# only the exit code lied. Validate the value; it is the thing being asserted.
if (-not $NodeVersion) {
  $NodeVersion = ((& node --version) -replace '^v', '').Trim()
}
if ($NodeVersion -notmatch '^\d+\.\d+\.\d+$') { Fail "could not read a node version from this machine (got '$NodeVersion')" }
Say "  node on this machine: v$NodeVersion (the foreign runtime will match it)"
$hostArch = if ([Environment]::Is64BitOperatingSystem -and $env:PROCESSOR_ARCHITECTURE -match 'ARM') { 'arm64' } else { 'x64' }
Say "== host: $env:PROCESSOR_ARCHITECTURE (treating as $hostArch), node $NodeVersion =="

# -- resolve a node.exe per triple --------------------------------------------
# The host's own node serves its native triple. The foreign triple needs a
# matching runtime installed side by side; the ZIP, never the MSI, so it does not
# touch PATH or displace the host's node.
#
# !! NOTHING IN HERE MAY USE Say/Write-Output. In PowerShell EVERY uncaptured
# output inside a function is part of its RETURN VALUE, so a progress line comes
# back concatenated onto the path. Measured: $nodeExe became
# "  installing node v24.10.0 x64 ...`nC:\node-x64\...\node.exe", which then blew
# up in ReadAllBytes, in Split-Path, and finally in the call operator -- three
# errors, none of them naming the actual cause. Write-Host goes to the host, not
# the pipeline, so it is safe here.
function Resolve-Node($arch) {
  if ($arch -eq $hostArch) { return (Get-Command node).Source }
  $dir = "C:\node-$arch\node-v$NodeVersion-win-$arch"
  $exe = Join-Path $dir 'node.exe'
  if (-not (Test-Path $exe)) {
    Write-Host "  installing node v$NodeVersion $arch (foreign triple, runs under emulation)"
    $zip = "C:\node-$arch.zip"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-$arch.zip" -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath "C:\node-$arch" -Force
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
  }
  if (-not (Test-Path $exe)) { Fail "no node for $arch at $exe" }
  return $exe
}

# Not every node can host a SEA: injection needs the fuse sentinel compiled in,
# and homebrew/distro builds omit it. Official nodejs.org builds carry it. Check
# before spending a build on a runtime that cannot be a base.
function Assert-SeaCapable($exe) {
  $sentinel = 'NODE_SEA_FUSE_' + 'fce680ab2cc467b6e072b8b5df1996b2'
  $bytes = [IO.File]::ReadAllBytes($exe)
  $text  = [Text.Encoding]::ASCII.GetString($bytes)
  if (-not $text.Contains($sentinel)) { Fail "$exe has no SEA fuse sentinel -- not an official nodejs.org build" }
}

# -- one-time: install + bundle ----------------------------------------------
# --ignore-scripts is deliberate, matching the docker path: esbuild and the SEA
# step need no native addon at all, so the platform install is deferred to the
# single package that needs it, once per triple.
Set-Location $Root
Say '== npm ci (no scripts) =='
& npm ci --ignore-scripts --no-audit --no-fund 2>&1 | Select-Object -Last 3
if (-not (Test-Path (Join-Path $Root 'node_modules'))) { Fail 'npm ci produced no node_modules' }

Say '== bundle (esbuild -> dist/bin.cjs) =='
Set-Location $SRV
& npm run build 2>&1 | Select-Object -Last 3
$bundle = Join-Path $SRV 'dist\bin.cjs'
if (-not (Test-Path $bundle)) { Fail "no bundle at $bundle" }
Say ("  bin.cjs " + (Get-Item $bundle).Length)

# -- per triple ---------------------------------------------------------------
$built = @()
foreach ($triple in ($Triples -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
  if ($triple -notmatch '^windows-(x64|arm64)$') { Fail "bad triple '$triple' (quoting damage?)" }
  $arch = $triple -replace '^windows-', ''
  Say ''
  Say "== $triple =="
  $nodeExe = Resolve-Node $arch
  if ($nodeExe -isnot [string] -or -not (Test-Path -LiteralPath $nodeExe)) {
    Fail "Resolve-Node did not return a single usable path for ${arch}: $($nodeExe | Out-String)"
  }
  Assert-SeaCapable $nodeExe
  Say "  node: $nodeExe"

  # !! DELETE build/ FIRST. This is required, not hygiene -- see Get-Machine.
  Remove-Item -Recurse -Force (Join-Path $PKG 'build') -ErrorAction SilentlyContinue
  $env:npm_config_arch = $arch
  $env:npm_config_target_arch = $arch
  Set-Location $Root
  # npm as a SCRIPT under the intended node, never npm.cmd: the shim resolves
  # node from PATH, i.e. the HOST arch, and prebuild-install would then fetch a
  # prebuild for the wrong architecture.
  $npmCli = Join-Path (Split-Path $nodeExe) 'node_modules\npm\bin\npm-cli.js'
  & $nodeExe $npmCli rebuild better-sqlite3-multiple-ciphers --foreground-scripts 2>&1 | Select-Object -Last 2
  Remove-Item Env:\npm_config_arch, Env:\npm_config_target_arch -ErrorAction SilentlyContinue

  # !!! tsx IS esbuild, AND esbuild IS NATIVE. build-binary.mjs must run under the
  # TARGET node (it copies process.execPath as the SEA base), and it imports
  # @recued/release whose `main` is a .ts file -- so tsx, so esbuild. `npm ci` on
  # this ARM64 host installs only @esbuild/win32-arm64, and the x64 node then
  # dies with "You installed esbuild for another platform than the one you're
  # currently using".
  #
  # !! The platform gate is on the PACKAGE, so `--os/--cpu` are not enough on
  # this npm ("notsup Valid cpu: x64, Actual cpu: arm64") -- it takes --force.
  # That is safe here: the package is a single prebuilt esbuild binary for a
  # platform this machine genuinely runs under emulation.
  #
  # !! Installed INSIDE the per-triple loop, after `npm ci` has already run --
  # ci wipes node_modules, so doing it once up front would be undone.
  # !! Derive the version from the esbuild tsx will actually LOAD, and FAIL if
  # it cannot be found. This read node_modules\tsx\node_modules\@esbuild until
  # 26.8.18 -- except the path had been corrupted into a literal tab plus
  # newline, so it never resolved and $ebVer was ALWAYS null. The old guard
  # was `if ($ebVer -and ...)`, so a null version SKIPPED the install without
  # a word, and the build died much later under tsx with 'The package
  # @esbuild/win32-x64 could not be found'. It survived because tsx used to
  # carry its own nested esbuild; the moment tsx deduped onto the hoisted one
  # the mask came off. Check both layouts, nested first -- that is what tsx
  # resolves when it has its own copy.
  $ebVer = $null
  foreach ($rel in @('node_modules\tsx\node_modules\esbuild\package.json',
                     'node_modules\esbuild\package.json')) {
    $cand = Join-Path $Root $rel
    if (Test-Path $cand) { $ebVer = (Get-Content $cand -Raw | ConvertFrom-Json).version; break }
  }
  if (-not $ebVer) { Fail 'could not determine the esbuild version tsx will load (looked nested under tsx, then hoisted)' }
  if (-not (Test-Path (Join-Path $Root "node_modules\@esbuild\win32-$arch\esbuild.exe"))) {
    Say "  installing @esbuild/win32-$arch@$ebVer (tsx needs a native binary matching the TARGET node)"
    & $nodeExe $npmCli install --no-save --no-audit --no-fund --force "@esbuild/win32-$arch@$ebVer" 2>&1 | Select-Object -Last 1
    if (-not (Test-Path (Join-Path $Root "node_modules\@esbuild\win32-$arch\esbuild.exe"))) {
      Fail "could not install @esbuild/win32-$arch@$ebVer -- tsx cannot run under the $arch node without it"
    }
  }

  if (-not (Test-Path $ADDON)) { Fail "no addon at $ADDON (no prebuild for $arch at this ABI?)" }
  $want = if ($arch -eq 'x64') { 0x8664 } else { 0xAA64 }
  $got  = Get-Machine $ADDON
  Say ("  addon machine 0x" + $got.ToString('X4') + "  " + (Get-Item $ADDON).Length)
  if ($got -ne $want) { Fail ("addon is 0x" + $got.ToString('X4') + ", expected 0x" + $want.ToString('X4') + " for $triple") }

  Set-Location $SRV
  # PROTOTYPE (single-file): hand build-binary.mjs the addon to EMBED.
  # Deliberately $ADDON -- the path this script just verified is 0x8664/0xAA64
  # for THIS triple -- rather than letting the build re-resolve it. Embedding the
  # wrong-arch addon would produce a binary that starts and then dies at the
  # first database open, which is the exact failure the machine check above
  # exists to prevent; re-resolving would step around that check.
  # !! Cleared in the else branch: the loop runs once per triple, and a leaked
  # RECUED_ADDON_PATH would embed the x64 addon into the arm64 binary.
  if ($EmbedAddon -eq '1') {
    $env:RECUED_EMBED_ADDON = '1'
    $env:RECUED_ADDON_PATH  = $ADDON
    Say "  embedding addon into the blob (single-file prototype)"
  } else {
    Remove-Item Env:\RECUED_EMBED_ADDON, Env:\RECUED_ADDON_PATH -ErrorAction SilentlyContinue
  }
  & $nodeExe (Join-Path $Root 'node_modules\tsx\dist\cli.mjs') 'scripts\build-binary.mjs' 2>&1 | ForEach-Object { Say ("  " + $_) }
  if ($LASTEXITCODE -ne 0) { Fail "build-binary exited $LASTEXITCODE for $triple" }

  $exe = Join-Path $BIN "recued-$triple.exe"
  if (-not (Test-Path $exe)) { Fail "no binary at $exe" }

  # !! STAGE OUTSIDE dist\binary. build-binary.mjs rm -rf's its whole output
  # directory on every run, so anything staged inside it is destroyed by the NEXT
  # triple. That cost a finished arm64 binary once.
  $stage = Join-Path $Artifacts $triple
  New-Item -ItemType Directory -Force -Path (Join-Path $stage 'lib') | Out-Null
  Assert-Copy $exe   (Join-Path $stage "recued-$triple.exe")
  Assert-Copy $ADDON (Join-Path $stage 'lib\better_sqlite3.node')
  # Triple-qualified copy too, matching the docker layout release-build expects.
  Assert-Copy $ADDON (Join-Path $Artifacts "better_sqlite3-$triple.node")

  $sha = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
  Say ("  exe    " + (Get-Item $exe).Length)
  Say ("  sha256 " + $sha)
  $built += $triple
}

# -- report -------------------------------------------------------------------
Say ''
Say '== artifacts =='
foreach ($t in $built) {
  $e = Join-Path $Artifacts "$t\recued-$t.exe"
  $l = Join-Path $Artifacts "$t\lib\better_sqlite3.node"
  Say ("  " + $t)
  Say ("    exe    " + (Get-Item $e).Length + "  sha256 " + (Get-FileHash $e -Algorithm SHA256).Hash.ToLower())
  Say ("    addon  0x" + (Get-Machine $l).ToString('X4') + "  " + (Get-Item $l).Length)
}

# -- hand the artifacts back --------------------------------------------------
if ($UploadTo) {
  Say ''
  Say '== upload =='
  # FLAT names, exactly what release-build.mjs looks for in the staging dir:
  # binaryFileName(triple) and better_sqlite3-<triple>.node. Anything else means
  # a hand-rename between here and the release, which is where a sidecar gets
  # dropped -- and release-build REFUSES a binary with no sidecar precisely
  # because that pair installs cleanly and dies at the first database open.
  foreach ($t in $built) {
    foreach ($pair in @(
      @{ src = "$t\recued-$t.exe";            name = "recued-$t.exe" },
      @{ src = "$t\lib\better_sqlite3.node"; name = "better_sqlite3-$t.node" }
    )) {
      $src  = Join-Path $Artifacts $pair.src
      $name = $pair.name
      try {
        Invoke-WebRequest -Uri ($UploadTo + '?path=' + [Uri]::EscapeDataString($name)) `
          -Method PUT -InFile $src -ContentType 'application/octet-stream' -UseBasicParsing | Out-Null
        Say ("  sent " + $name + "  " + (Get-Item $src).Length)
      } catch {
        Fail ("upload failed for " + $name + ": " + $_.Exception.Message)
      }
    }
  }
}

Say ''
Write-Output 'WINBUILD-OK'
