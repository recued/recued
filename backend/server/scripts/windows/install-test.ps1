# Drives distribution/install/install.ps1 against a local feed on a real Windows
# host. Run by backend/server/scripts/test-install-windows.mjs, never by hand --
# the driver builds the feed, signs it, and serves it.
#
# !!! SAVE-AND-RUN, NOT `irm | iex`. install.ps1 once shipped unparseable: PS 5.1
# reads a .ps1 FILE as ANSI, and an em-dash's UTF-8 bytes end in U+201D, a string
# delimiter. `irm | iex` decodes UTF-8 into a string first and hid it completely,
# so the break reached only the users careful enough to read the installer first.
# Downloading to disk and invoking the FILE is the path that shows the defect.
#
# !!! ASCII ONLY, for the same reason. The driver asserts this.
param([string]$Base, [string]$PubKey)

$root = Join-Path $env:TEMP 'recued-ps1-test'
Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $root | Out-Null
$installer = Join-Path $root 'install.ps1'
Invoke-WebRequest "$Base/install.ps1" -OutFile $installer -UseBasicParsing

$startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Recued.lnk'
$programsLnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'Recued.lnk'
Remove-Item -Force $startupLnk, $programsLnk -ErrorAction SilentlyContinue

# !! NOTHING UNCAPTURED INSIDE A VALUE-RETURNING FUNCTION. In PowerShell every
# uncaptured expression becomes part of the return value, so a stray progress
# line comes back concatenated onto the result. All installer output goes to a
# file via `*>`, which also keeps $LASTEXITCODE meaningful -- piping a native
# command can leave it at -1 on success.
function Invoke-Install($feed, $prefix, $autostart = '0') {
  $env:RECUED_BASE_URL = "$Base/$feed"
  $env:RECUED_PREFIX = $prefix
  $env:RECUED_AUTOSTART = $autostart
  $env:RECUED_RELEASE_PUBKEY = $PubKey
  $log = Join-Path $root "$feed.log"
  & powershell -NoProfile -ExecutionPolicy Bypass -File $installer *> $log
  $code = $LASTEXITCODE
  $text = ''
  if (Test-Path $log) { $text = (Get-Content $log -Raw) }
  if ($null -eq $text) { $text = '' }
  return @{ Code = $code; Out = $text }
}

function Report($name, $ok, $detail) {
  $verdict = 'FAIL'
  if ($ok) { $verdict = 'PASS' }
  Write-Host ("ARM {0} {1} {2}" -f $name, $verdict, $detail)
}

function Sha($p) {
  if (-not (Test-Path $p)) { return 'absent' }
  return (Get-FileHash $p -Algorithm SHA256).Hash
}

# -- 1. A signed release installs exe, addon and webclient together --------
$p1 = Join-Path $root 'p1'
$r = Invoke-Install 'good' $p1
$exe1 = Join-Path $p1 'recued.exe'
$addon1 = Join-Path $p1 'lib\better_sqlite3.node'
$webclientIndex1 = Join-Path $p1 'webclient\index.html'
$webclientManifest1 = Join-Path $p1 'webclient\webclient-bundle-manifest.json'
$webclientStamp1 = Join-Path $p1 'webclient\.recued-installed-version'
$verified = $r.Out -match 'signature VERIFIED'
$lockGone = -not (Test-Path (Join-Path $p1 'recued-update.lock'))
$webclientOk = (Test-Path $webclientIndex1) -and (Test-Path $webclientManifest1) -and `
               (Test-Path $webclientStamp1) -and ((Get-Content $webclientStamp1 -Raw).Trim() -eq '9.9.9')
$ok = ($r.Code -eq 0) -and (Test-Path $exe1) -and (Test-Path $addon1) -and `
      $webclientOk -and $verified -and $lockGone
$freshFailure = ''
if (-not $ok) {
  $freshFailure = (($r.Out -replace '\s+', ' ').Trim())
  if ($freshFailure.Length -gt 600) { $freshFailure = $freshFailure.Substring(0, 600) }
}
Report 'fresh-signed' $ok "code=$($r.Code) exe=$(Test-Path $exe1) addon=$(Test-Path $addon1) webclient=$webclientOk verified=$verified lock_released=$lockGone out=$freshFailure"
$firstHash = Sha $exe1

# The same-version branch must hash the installed bundle, not trust its stamp.
# Corrupt one served file and prove a re-run downloads only the signed UI again.
$firstWebclientHash = Sha $webclientIndex1
Set-Content -Path $webclientIndex1 -Value 'CORRUPT WEBCLIENT' -Encoding ASCII
$corruptWebclientHash = Sha $webclientIndex1
$rWebclientRepair = Invoke-Install 'good' $p1
$repairedWebclientHash = Sha $webclientIndex1
$saidWebclientRepair = (($rWebclientRepair.Out -replace '\s+', ' ') -match 'webclient 9.9.9 installed')
$ok = ($rWebclientRepair.Code -eq 0) -and ($corruptWebclientHash -ne $firstWebclientHash) -and `
      ($repairedWebclientHash -eq $firstWebclientHash) -and $saidWebclientRepair -and `
      (-not (Test-Path (Join-Path $p1 'recued-update.lock')))
Report 'same-version-webclient-repaired' $ok "code=$($rWebclientRepair.Code) restored=$($repairedWebclientHash -eq $firstWebclientHash) said_repair=$saidWebclientRepair"

# Model process death after the live bundle moved aside but before promotion.
# The next same-version run restores the backup under the host lease first.
$webclientDir1 = Join-Path $p1 'webclient'
$webclientBackup1 = "$webclientDir1.install-old"
Move-Item -LiteralPath $webclientDir1 -Destination $webclientBackup1
$rWebclientRecover = Invoke-Install 'good' $p1
$ok = ($rWebclientRecover.Code -eq 0) -and (Test-Path $webclientIndex1) -and `
      ((Sha $webclientIndex1) -eq $firstWebclientHash) -and (-not (Test-Path $webclientBackup1))
Report 'interrupted-webclient-swap-reconciled' $ok "code=$($rWebclientRecover.Code) restored=$(Test-Path $webclientIndex1) backup=$(Test-Path $webclientBackup1)"

# -- 1b. A deployed N-1 router can bootstrap lease/floor, then repair -----
# This fixture knows only --version. Every internal verb prints help/returns 0
# with no effect, matching the live 26.8.31 router rather than the modern test
# candidate that previously made this compatibility path invisible.
$pLegacy = Join-Path $root 'plegacy'
$rLegacy = Invoke-Install 'legacy' $pLegacy
$legacyExe = Join-Path $pLegacy 'recued.exe'
$legacyAddon = Join-Path $pLegacy 'lib\better_sqlite3.node'
$legacyFloor = Join-Path $pLegacy '.release-sequence'
$legacyLockGone = -not (Test-Path (Join-Path $pLegacy 'recued-update.lock'))
$legacyFloorOk = (Test-Path $legacyFloor) -and ((Get-Content $legacyFloor -Raw).Trim() -eq '100')
$ok = ($rLegacy.Code -eq 0) -and (Test-Path $legacyExe) -and (Test-Path $legacyAddon) -and `
      $legacyLockGone -and $legacyFloorOk
Report 'legacy-bootstrap-installs' $ok "code=$($rLegacy.Code) pair=$((Test-Path $legacyExe) -and (Test-Path $legacyAddon)) lock_released=$legacyLockGone floor=$legacyFloorOk"

# --version still works with the addon gone. The same-version fast path must
# test the complete pair and repair it instead of arming a broken autostart.
Remove-Item -Force $legacyAddon
$rLegacyRepair = Invoke-Install 'legacy' $pLegacy
$saidRepair = (($rLegacyRepair.Out -replace '\s+', ' ') -match 'pair is not healthy - repairing')
$ok = ($rLegacyRepair.Code -eq 0) -and (Test-Path $legacyAddon) -and $saidRepair -and `
      (-not (Test-Path (Join-Path $pLegacy 'recued-update.lock')))
Report 'same-version-addon-repaired' $ok "code=$($rLegacyRepair.Code) addon=$(Test-Path $legacyAddon) said_repair=$saidRepair"

# The deployed router's unknown self-test is also a no-op success, so existence
# is not enough. A signed-manifest hash mismatch must take the repair path too.
Set-Content -Path $legacyAddon -Value 'CORRUPT ADDON' -Encoding ASCII
$corruptHash = Sha $legacyAddon
$rLegacyRepair = Invoke-Install 'legacy' $pLegacy
$restoredHash = Sha $legacyAddon
$saidRepair = (($rLegacyRepair.Out -replace '\s+', ' ') -match 'pair is not healthy - repairing')
$ok = ($rLegacyRepair.Code -eq 0) -and ($restoredHash -ne 'absent') -and `
      ($restoredHash -ne $corruptHash) -and $saidRepair -and `
      (-not (Test-Path (Join-Path $pLegacy 'recued-update.lock')))
Report 'same-version-corrupt-addon-repaired' $ok "code=$($rLegacyRepair.Code) restored=$($restoredHash -ne $corruptHash) said_repair=$saidRepair"

# -- 2. Autostart opt-out honoured ----------------------------------------
# !! An opt-out regression would both create a .lnk and try to LAUNCH the stub.
# The launch is Start-RecuedNow at the install path's own call site, NOT
# Enable-RecuedAutoStart -- that function only writes the shortcut. (This comment
# named the wrong one until 2026-08-31; the distinction matters because arm 7
# below has to reason about which of the two it is exercising.)
$ok = -not (Test-Path $startupLnk)
Report 'autostart-off' $ok "startup_lnk_exists=$(Test-Path $startupLnk)"

# -- 3. A re-run replaces the binary in place ------------------------------
# The fixture is now a healthy executable, so the ordinary installer correctly
# refuses to act as an updater. Force here is deliberate: this arm exercises the
# installer's repair/replacement transaction, including preservation + runtime
# proof, without weakening the default healthy-install refusal.
$env:RECUED_FORCE = '1'
$r = Invoke-Install 'v2' $p1
Remove-Item Env:RECUED_FORCE -ErrorAction SilentlyContinue
$secondHash = Sha $exe1
# The commit-time re-check must not repeat the replace note for an unchanged
# version: this arm's output said it twice until 2026-10-04.
$replacingNotes = ([regex]::Matches($r.Out, 'RECUED_FORCE=1 - replacing')).Count
$ok = ($r.Code -eq 0) -and ($firstHash -ne 'absent') -and ($secondHash -ne $firstHash) -and ($replacingNotes -eq 1)
Report 'rerun-replaces' $ok "code=$($r.Code) changed=$($secondHash -ne $firstHash) replacing_notes=$replacingNotes"

# -- 3a. A late-current pair still repairs the separately committed UI -------
# Start from an empty prefix. The feed driver parks the first binary GET for
# three seconds; once the progress line proves the installer's initial read has
# already happened, plant the exact current executable/addon pair but no UI.
# This models another installer committing the native pair and then dying before
# its webclient swap. The waiting installer must finish all three parts before it
# reports that the concurrent install completed.
$pLate = Join-Path $root 'plate'
$lateLog = Join-Path $root 'latecurrent.log'
$lateJob = Start-Job -ScriptBlock {
  param($Installer, $Log, $BaseUrl, $Key, $Prefix)
  $env:RECUED_BASE_URL = "$BaseUrl/latecurrent"
  $env:RECUED_PREFIX = $Prefix
  $env:RECUED_AUTOSTART = '0'
  $env:RECUED_RELEASE_PUBKEY = $Key
  & powershell -NoProfile -ExecutionPolicy Bypass -File $Installer *> $Log
  return $LASTEXITCODE
} -ArgumentList $installer, $lateLog, $Base, $PubKey, $pLate

$downloadSeen = $false
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline -and $lateJob.State -eq 'Running') {
  if (Test-Path $lateLog) {
    $partial = ''
    try { $partial = Get-Content $lateLog -Raw -ErrorAction Stop } catch { $partial = '' }
    if ($partial -match 'downloading recued-windows-') { $downloadSeen = $true; break }
  }
  Start-Sleep -Milliseconds 100
}
if ($downloadSeen) {
  New-Item -ItemType Directory -Force -Path (Join-Path $pLate 'lib') | Out-Null
  Copy-Item -Force $exe1 (Join-Path $pLate 'recued.exe')
  Copy-Item -Force $addon1 (Join-Path $pLate 'lib\better_sqlite3.node')
}
[void](Wait-Job -Job $lateJob -Timeout 90)
$lateCode = -1
if ($lateJob.State -eq 'Completed') {
  $lateCode = [int](Receive-Job -Job $lateJob | Select-Object -Last 1)
} else {
  Stop-Job -Job $lateJob -ErrorAction SilentlyContinue
}
Remove-Job -Job $lateJob -Force -ErrorAction SilentlyContinue
$lateOut = ''
if (Test-Path $lateLog) { $lateOut = Get-Content $lateLog -Raw }
$lateWebclient = Join-Path $pLate 'webclient\index.html'
$lateUiOk = (Test-Path $lateWebclient) -and ((Get-Content $lateWebclient -Raw) -match '9.9.10')
$lateSaidCurrent = (($lateOut -replace '\s+', ' ') -match 'another installer completed 9.9.10')
$lateLockGone = -not (Test-Path (Join-Path $pLate 'recued-update.lock'))
$ok = $downloadSeen -and ($lateCode -eq 0) -and $lateUiOk -and $lateSaidCurrent -and $lateLockGone
Report 'late-current-repairs-webclient' $ok "signal=$downloadSeen code=$lateCode ui=$lateUiOk said_current=$lateSaidCurrent lock_released=$lateLockGone"

# -- 4. A sha256 mismatch installs nothing ---------------------------------
# The manifest here is VALIDLY SIGNED and declares a hash that does not match the
# object it names, which isolates the hash check from the signature check.
$p2 = Join-Path $root 'p2'
$r = Invoke-Install 'badsha' $p2
$exe2 = Join-Path $p2 'recued.exe'
$ok = ($r.Code -ne 0) -and (-not (Test-Path $exe2)) -and ($r.Out -match 'sha256 mismatch')
Report 'sha-mismatch-refused' $ok "code=$($r.Code) exe=$(Test-Path $exe2) said_mismatch=$($r.Out -match 'sha256 mismatch')"

# -- 5. A binary with no native addon is refused, not half-installed -------
$p3 = Join-Path $root 'p3'
$r = Invoke-Install 'noaddon' $p3
$exe3 = Join-Path $p3 'recued.exe'
$ok = ($r.Code -ne 0) -and (-not (Test-Path $exe3)) -and ($r.Out -match 'native addon')
Report 'no-addon-refused' $ok "code=$($r.Code) exe=$(Test-Path $exe3) said_addon=$($r.Out -match 'native addon')"

# A binaries-only release remains installable, but says the LAN UI is absent.
$pNoWebclient = Join-Path $root 'pnowebclient'
$r = Invoke-Install 'nowebclient' $pNoWebclient
$noWebPair = (Test-Path (Join-Path $pNoWebclient 'recued.exe')) -and `
             (Test-Path (Join-Path $pNoWebclient 'lib\better_sqlite3.node'))
$saidNoWebclient = (($r.Out -replace '\s+', ' ') -match 'publishes no webclient bundle')
$ok = ($r.Code -eq 0) -and $noWebPair -and $saidNoWebclient -and `
      (-not (Test-Path (Join-Path $pNoWebclient 'webclient')))
Report 'missing-webclient-is-graceful' $ok "code=$($r.Code) pair=$noWebPair said_absent=$saidNoWebclient webclient=$(Test-Path (Join-Path $pNoWebclient 'webclient'))"

# The outer archive is signed and its hash matches, but a climbing entry must
# never be written. The server pair commits independently; the run fails before
# advancing the replay floor and leaves no partial stage behind.
$pUnsafeWebclient = Join-Path $root 'punsafewebclient'
$r = Invoke-Install 'unsafewebclient' $pUnsafeWebclient
$unsafePair = (Test-Path (Join-Path $pUnsafeWebclient 'recued.exe')) -and `
              (Test-Path (Join-Path $pUnsafeWebclient 'lib\better_sqlite3.node'))
$unsafeStages = @(Get-ChildItem -LiteralPath $pUnsafeWebclient -Filter '.webclient-install-*' -ErrorAction SilentlyContinue)
$saidUnsafeWebclient = (($r.Out -replace '\s+', ' ') -match 'unsafe path')
$ok = ($r.Code -ne 0) -and $unsafePair -and $saidUnsafeWebclient -and `
      (-not (Test-Path (Join-Path $pUnsafeWebclient 'webclient'))) -and `
      (-not (Test-Path (Join-Path $pUnsafeWebclient '.release-sequence'))) -and ($unsafeStages.Count -eq 0)
Report 'unsafe-webclient-path-refused' $ok "code=$($r.Code) pair=$unsafePair said_unsafe=$saidUnsafeWebclient floor=$(Test-Path (Join-Path $pUnsafeWebclient '.release-sequence')) stages=$($unsafeStages.Count)"

# The signed outer archive cannot delegate trust to a lying inner allowlist.
$pBadInner = Join-Path $root 'pbadinnerwebclient'
$r = Invoke-Install 'badinnerwebclient' $pBadInner
$badInnerPair = (Test-Path (Join-Path $pBadInner 'recued.exe')) -and `
                (Test-Path (Join-Path $pBadInner 'lib\better_sqlite3.node'))
$saidBadInner = (($r.Out -replace '\s+', ' ') -match 'inner manifest does not match')
$ok = ($r.Code -ne 0) -and $badInnerPair -and $saidBadInner -and `
      (-not (Test-Path (Join-Path $pBadInner 'webclient'))) -and `
      (-not (Test-Path (Join-Path $pBadInner '.release-sequence')))
Report 'webclient-inner-manifest-refused' $ok "code=$($r.Code) pair=$badInnerPair said_inner=$saidBadInner floor=$(Test-Path (Join-Path $pBadInner '.release-sequence'))"

# -- 6. A manifest edited after signing is refused -------------------------
# The attack the signature exists to stop: the hashes come FROM the manifest, so
# rewriting it rewrites them to match whatever was served.
$p4 = Join-Path $root 'p4'
$r = Invoke-Install 'tampered' $p4
$exe4 = Join-Path $p4 'recued.exe'
# !!! -cmatch, AND THE WORD `for`. Mutation testing caught this assertion
# matching the WRONG SOURCE: minisign itself prints "Signature verification
# failed", so a case-insensitive match on that phrase passed even with
# install.ps1's own Die disabled. Only "signature verification FAILED for
# <path>" is install.ps1 speaking. The install does still refuse without the Die
# -- $ErrorActionPreference='Stop' plus `2>&1` on a native command turns
# minisign's stderr into a terminating error -- but that is incidental
# enforcement, and an assertion that cannot tell the two apart is not measuring
# the check it names.
$saidSig = $r.Out -cmatch 'signature verification FAILED for'
$ok = ($r.Code -ne 0) -and (-not (Test-Path $exe4)) -and $saidSig
Report 'tampered-manifest-refused' $ok "code=$($r.Code) exe=$(Test-Path $exe4) said_sig=$saidSig"

# -- 6b. A declared oversized response is refused before verification --------
# This route advertises 512 MiB + 1 and sends no payload. It proves the real
# manifest call site walks through the streaming ceiling rather than merely
# leaving an unused helper in the file.
$p4b = Join-Path $root 'p4b'
$r = Invoke-Install 'oversize' $p4b
$exe4b = Join-Path $p4b 'recued.exe'
$oversizeText = (($r.Out -replace '\s+', ' ').Trim())
$saidLimit = ($oversizeText -match 'cannot fetch release manifest') -and `
  ($oversizeText -match 'size 536870913 bytes exceeds the 512 MiB limit')
$ok = ($r.Code -ne 0) -and (-not (Test-Path $exe4b)) -and $saidLimit
$oversizeFailure = ''
if (-not $ok) {
  $oversizeFailure = $oversizeText
  if ($oversizeFailure.Length -gt 600) { $oversizeFailure = $oversizeFailure.Substring(0, 600) }
}
Report 'oversized-manifest-refused' $ok "code=$($r.Code) exe=$(Test-Path $exe4b) said_limit=$saidLimit out=$oversizeFailure"

# -- 7. Autostart ON writes a Startup shortcut, running the RIGHT command --
# Arms 1-6 all install with autostart off, so until this arm the ONLY thing
# asserted about start-at-login was arm 2's ABSENCE -- and absence is also what a
# broken Enable-RecuedAutoStart produces. The default path (autostart is ON
# unless opted out) had no coverage at all, on the one platform with no
# supervisor to fall back on.
#
# !!! THE ARGUMENTS ARE THE POINT, not merely that a .lnk appeared. Both halves
# are load-bearing and both are silent if they regress:
#   `start`, not `serve` -- Windows has no supervisor, so the shortcut must
#      daemonize; `serve` would hold a console for the whole login session.
#   `--require-enrolled` -- without it a login brings up an UNPAIRED server
#      listening and printing a pairing code nobody is there to read.
#
# !! NOTHING IS LAUNCHED HERE, and not by luck: Start-RecuedNow is gated on
# Test-RecuedUnitFirstRun, which wants version >= 26.8.29, and this feed serves
# 9.9.9. Keep fixture versions below that threshold unless this arm is updated
# to stop the test daemon it would start.
$p7 = Join-Path $root 'p7'
Remove-Item -Force $startupLnk -ErrorAction SilentlyContinue
$r = Invoke-Install 'good' $p7 '1'
$lnkExists = Test-Path $startupLnk
$target = ''
$lnkArgs = ''
if ($lnkExists) {
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($startupLnk)
  $target = $sc.TargetPath
  $lnkArgs = $sc.Arguments
}
# Compare through Get-Item so both sides get the same normalisation; $env:TEMP
# can be an 8.3 short path and a raw string compare would flake on it.
$targetOk = $false
if ($target -and (Test-Path $target)) {
  $targetOk = ((Get-Item $target).FullName -ieq (Get-Item (Join-Path $p7 'recued.exe')).FullName)
}
$argsOk = ($lnkArgs -eq 'start --require-enrolled')
$ok = ($r.Code -eq 0) -and $lnkExists -and $targetOk -and $argsOk
Report 'autostart-on-writes-lnk' $ok "code=$($r.Code) lnk=$lnkExists target_ok=$targetOk args=[$lnkArgs]"
Remove-Item -Force $startupLnk -ErrorAction SilentlyContinue

# -- 7b. The released install lease cannot strand first launch ---------------
# The fixture returns failure from its first `start` and succeeds on its second,
# reproducing the observable handoff when another installer owns the update
# lease for the first child boot. The shipped helper must retry rather than
# leave a successful install stopped until the next login.
$p7b = Join-Path $root 'p7b'
$r = Invoke-Install 'startretry' $p7b '1'
$attemptFile = Join-Path $p7b '.start-attempts'
$attempts = 0
if (Test-Path $attemptFile) { [void][int]::TryParse((Get-Content $attemptFile -Raw).Trim(), [ref]$attempts) }
$saidRetry = (($r.Out -replace '\s+', ' ') -match 'retrying after the update-lease handoff')
$ok = ($r.Code -eq 0) -and ($attempts -eq 2) -and $saidRetry
Report 'first-launch-lease-handoff-retried' $ok "code=$($r.Code) attempts=$attempts said_retry=$saidRetry"
Remove-Item -Force $startupLnk -ErrorAction SilentlyContinue

# -- 8. MANIFEST-LEVEL GATES: a valid signature is not a fresh one ---------
# !! MATCHED AGAINST WHITESPACE-NORMALISED OUTPUT. PowerShell wraps error text
# at the console width, so 'newer than this installer understands' arrived as
# 'installer  understands' and a literal match missed a gate that had fired
# correctly - a green-looking refusal reported as a failure, which is the same
# class of wrong signal as a failure reported as green.
# !!! WINDOWS ENFORCED NONE OF THESE. Every feed below is VALIDLY SIGNED by the
# same key as 'good', so only the manifest's own fields distinguish them. Without
# these gates a replayed or malformed feed installs. (Freshness is NOT among
# them any more - see the expired-feed arm below and D-260.)
# or a replayed capture installs a real, older release over a newer one.
$pGate = Join-Path $root 'pgate'
New-Item -ItemType Directory -Force -Path $pGate | Out-Null
# Seed an anti-replay floor ABOVE the replay feed's sequence (1).
Set-Content -Path (Join-Path $pGate '.release-sequence') -Value '100' -Encoding ASCII

$r = Invoke-Install 'replay' $pGate
$flat = ($r.Out -replace '\s+', ' ')
$said = $flat -match 'BELOW the highest this machine has accepted'
$noExe = -not (Test-Path (Join-Path $pGate 'recued.exe'))
$ok = ($r.Code -ne 0) -and $said -and $noExe
Report 'replay-refused' $ok "code=$($r.Code) said=$said noexe=$noExe out=$(($r.Out -split "`n" | Where-Object { $_ -match 'recued-install|error|Error' } | Select-Object -First 2) -join ' // ')"

# !!! INVERTED BY D-260, NOT DELETED. This asserted that an expired feed is
# REFUSED. That gate is gone from both installers now: an expiry answers "is this
# feed old" when the only question that matters is "is this release newer than
# what I have", and refusing on a DATE closed the repair path for everyone at
# once. install.sh lost the gate first and this file kept it for a day - the
# live manifest expires 2026-09-30, so Windows recovery installs would have begun
# refusing on 2026-10-07.
#
# !! PINNED AS AN ACCEPTANCE so re-adding a freshness refusal has to come past
# this arm and its reason. The anti-replay floor above is the half that defended
# and it still refuses a feed older than one this machine accepted.
$pStale = Join-Path $root 'pstale'
$r = Invoke-Install 'stale' $pStale
$flat = ($r.Out -replace '\s+', ' ')
$saidStale = $flat -match 'days stale'
$gotExe = Test-Path (Join-Path $pStale 'recued.exe')
$ok = ($r.Code -eq 0) -and $gotExe -and (-not $saidStale)
Report 'expired-feed-still-installs' $ok "code=$($r.Code) exe=$gotExe said_stale=$saidStale"

# !! AN OMITTED FIELD MUST NEVER BE THE WAY PAST A GATE.
$pNoSeq = Join-Path $root 'pnoseq'
$r = Invoke-Install 'noseq' $pNoSeq
$flat = ($r.Out -replace '\s+', ' ')
$said = $flat -match 'no usable sequence'
$noExe = -not (Test-Path (Join-Path $pNoSeq 'recued.exe'))
$ok = ($r.Code -ne 0) -and $said -and $noExe
Report 'missing-sequence-refused' $ok "code=$($r.Code) said=$said noexe=$noExe out=$(($r.Out -split "`n" | Where-Object { $_ -match 'recued-install|error|Error' } | Select-Object -First 2) -join ' // ')"

$pSchema = Join-Path $root 'pschema'
$r = Invoke-Install 'newschema' $pSchema
$flat = ($r.Out -replace '\s+', ' ')
$said = $flat -match 'newer than this installer understands'
$noExe = -not (Test-Path (Join-Path $pSchema 'recued.exe'))
$ok = ($r.Code -ne 0) -and $said -and $noExe
Report 'newer-schema-refused' $ok "code=$($r.Code) said=$said noexe=$noExe"

# A good install must still record the floor, or the replay gate above can never
# fire on a machine that has only ever installed successfully.
$ok = (Test-Path (Join-Path $p1 '.release-sequence')) -and `
      (((Get-Content (Join-Path $p1 '.release-sequence') -Raw) -replace '[^0-9]','') -eq '100')
Report 'sequence-floor-recorded' $ok "floor=$(if (Test-Path (Join-Path $p1 '.release-sequence')) { ((Get-Content (Join-Path $p1 '.release-sequence') -Raw).Trim()) } else { 'absent' })"

# !!! A VALID SIGNATURE AND A MATCHING HASH DO NOT MAKE THE BYTES THE RELEASE.
# The manifest here is correctly signed and its sha256 matches the object it
# names; only the VERSION is wrong (stub built 9.9.9, manifest says 9.9.11).
# Nothing bound the label to the bytes, so this installed 9.9.9 while reporting
# success for 9.9.11 -- the shape a stale staging dir publishes as a .n hotfix.
$pMis = Join-Path $root 'pmis'
$r = Invoke-Install 'mislabel' $pMis
$flat = ($r.Out -replace '\s+', ' ')
$said = $flat -match 'does not carry version'
$noExe = -not (Test-Path (Join-Path $pMis 'recued.exe'))
$ok = ($r.Code -ne 0) -and $said -and $noExe
Report 'mislabelled-binary-refused' $ok "code=$($r.Code) said=$said noexe=$noExe"

# -- 9. The installed-vs-release DECISION, on the real shipped code --------
# !!! THIS IS THE BRANCH SET NOTHING COVERED. install.ps1's `--version` probe
# used to need a real PE to report anything, and the old fixture was a text file,
# so every end-to-end arm took the "did not report a version" repair path. The
# harness now compiles a PE, while Get-RecuedInstallAction remains extracted from
# the SHIPPED installer via the
# AST and called directly, so these assert the real logic rather than a retyped
# copy of it.
$astToks = $null; $astErrs = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$astToks, [ref]$astErrs)
$want = @('Compare-RecuedVersion', 'Get-RecuedInstallAction')
$fns = $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) |
       Where-Object { $want -contains $_.Name }
foreach ($f in $fns) { . ([scriptblock]::Create($f.Extent.Text)) }
Report 'decision-fn-extracted' (@($fns).Count -eq $want.Count) "found=$(@($fns).Count) of $($want.Count)"

$cases = @(
  # installed,   release,     force, expected
  @('26.9.1.1', '26.9.1',     '',    'downgrade-refused'),
  @('26.9.1.2', '26.9.1.1',   '',    'downgrade-refused'),
  @('26.9.1.1', '26.9.1',     '1',   'downgrade-refused'),
  @('26.9.1',   '26.9.1',     '',    'current'),
  @('26.9.1.1', '26.9.1.1',   '',    'current'),
  @('',         '26.9.1',     '',    'repair'),
  @('26.9.1',   '26.9.1.1',   '',    'healthy-refused'),
  @('26.9.1',   '26.9.2',     '',    'healthy-refused'),
  @('26.9.1',   '26.9.1.1',   '1',   'replace')
)
$bad = @()
foreach ($c in $cases) {
  $got = Get-RecuedInstallAction $c[0] $c[1] $c[2]
  if ($got -ne $c[3]) { $bad += ("installed='$($c[0])' release='$($c[1])' force='$($c[2])' -> $got want $($c[3])") }
}
Report 'install-action-decisions' ($bad.Count -eq 0) "$($cases.Count) cases, $($bad.Count) wrong; $($bad -join ' | ')"

# -- 10. A POWER-CUT MARKER RESTORES THE EXACT PREVIOUS PAIR ---------------
# Model death after both old files were parked and only a partial new addon was
# placed. There is no live exe to perform early reconciliation, so the freshly
# verified candidate must claim the canonical lease, restore the parked pair,
# and only then begin its own runtime-proven transaction.
$pCrash = Join-Path $root 'pcrash'
New-Item -ItemType Directory -Force -Path (Join-Path $pCrash 'lib') | Out-Null
$crashNonce = '0123456789abcdef0123456789abcdef'
$prevExe = Join-Path $pCrash "recued.exe.prev.$crashNonce"
$prevLib = Join-Path $pCrash "lib\better_sqlite3.node.prev.$crashNonce"
Copy-Item -Force $exe1 $prevExe
Copy-Item -Force $addon1 $prevLib
Set-Content -Path (Join-Path $pCrash 'lib\better_sqlite3.node') -Value 'partial-new-addon' -Encoding ASCII
$marker = @{
  schema_version = 1
  expected_version = '9.9.10'
  had_prev_exe = $true
  had_prev_lib = $true
  prev_exe = $prevExe
  prev_lib = $prevLib
} | ConvertTo-Json -Compress
Set-Content -Path (Join-Path $pCrash '.swap-in-progress') -Value $marker -Encoding ASCII

$r = Invoke-Install 'v2' $pCrash
$recoveredExe = Join-Path $pCrash 'recued.exe'
$recoveredLib = Join-Path $pCrash 'lib\better_sqlite3.node'
$debrisGone = (-not (Test-Path (Join-Path $pCrash '.swap-in-progress'))) -and `
              (-not (Test-Path $prevExe)) -and (-not (Test-Path $prevLib)) -and `
              (-not (Test-Path (Join-Path $pCrash 'recued-update.lock')))
$ok = ($r.Code -eq 0) -and (Sha $recoveredExe) -eq $secondHash -and `
      (Test-Path $recoveredLib) -and $debrisGone
Report 'interrupted-pair-reconciled' $ok "code=$($r.Code) exe_restored=$((Sha $recoveredExe) -eq $secondHash) debris_gone=$debrisGone"

# -- 11. AN UNSAFE RECOVERY MARKER CANNOT DELETE AN ARBITRARY PATH ---------
$pUnsafe = Join-Path $root 'punsafe'
New-Item -ItemType Directory -Force -Path (Join-Path $pUnsafe 'lib') | Out-Null
$victim = Join-Path $root 'marker-victim.txt'
Set-Content -Path $victim -Value 'keep' -Encoding ASCII
$unsafeMarker = @{
  schema_version = 1
  expected_version = '9.9.10'
  had_prev_exe = $true
  had_prev_lib = $false
  prev_exe = $victim
  prev_lib = ''
} | ConvertTo-Json -Compress
Set-Content -Path (Join-Path $pUnsafe '.swap-in-progress') -Value $unsafeMarker -Encoding ASCII
$r = Invoke-Install 'v2' $pUnsafe
$saidUnsafe = (($r.Out -replace '\s+', ' ') -match 'unreadable or unsafe')
$ok = ($r.Code -ne 0) -and (Test-Path $victim) -and (Test-Path (Join-Path $pUnsafe '.swap-in-progress'))
Report 'unsafe-swap-marker-refused' $ok "code=$($r.Code) said=$saidUnsafe victim=$((Test-Path $victim)) marker=$((Test-Path (Join-Path $pUnsafe '.swap-in-progress')))"

# -- 12. NOTHING THE WAY BACK DEPENDS ON GOES BEFORE THE NEW PAIR IS ON DISK --
# !!! NO HARNESS CAN PULL THE PLUG, BUT IT CAN DENY THE FLUSH. FlushFileBuffers
# needs a handle opened for write, so a handle held here WITHOUT write sharing
# makes the flush impossible. For a NEW pair (12a commit, 12c recovery keeping
# a candidate) that must stop the run before the parked pair or the marker goes.
# For a RESTORED previous pair (12b, 12d) the flush is best effort -- those bytes
# were on disk before the run -- so the restore completes, warns, and retires
# the marker. 12e/12f: a committed marker is recognised. Each arm fails against
# an installer without its rule.
#
# 12a/12b drive the SHIPPED transaction functions, extracted via the AST as in
# arm 9: a commit-time failure cannot be staged through a whole install without
# racing it. The recovery arms after them run the real installer end to end.
$swapToks = $null; $swapErrs = $null
$swapAst = [System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$swapToks, [ref]$swapErrs)
$swapWant = @('Get-RecuedSwapMarker', 'Write-RecuedDurableFile', 'Sync-RecuedInstallPair',
              'Write-RecuedCommittedSwapMarker', 'Restore-RecuedInstallFile',
              'Undo-RecuedInstallSwap', 'Complete-RecuedInstallSwap')
$swapFns = @($swapAst.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) |
             Where-Object { $swapWant -contains $_.Name })
foreach ($swapFn in $swapFns) { . ([scriptblock]::Create($swapFn.Extent.Text)) }

# A mid-swap prefix: new pair live, previous pair parked, schema-1 marker, and
# the in-memory transaction state Begin-RecuedInstallSwap leaves behind.
function New-SwapFixture($Name) {
  $dir = Join-Path $root $Name
  New-Item -ItemType Directory -Force -Path (Join-Path $dir 'lib') | Out-Null
  $nonce = 'abcdef0123456789abcdef0123456789'
  $fx = @{
    Exe = Join-Path $dir 'recued.exe'
    Lib = Join-Path $dir 'lib\better_sqlite3.node'
    PrevExe = Join-Path $dir "recued.exe.prev.$nonce"
    PrevLib = Join-Path $dir "lib\better_sqlite3.node.prev.$nonce"
    Marker = Join-Path $dir '.swap-in-progress'
  }
  Set-Content -Path $fx.Exe -Value 'new-exe' -Encoding ASCII
  Set-Content -Path $fx.Lib -Value 'new-lib' -Encoding ASCII
  Set-Content -Path $fx.PrevExe -Value 'old-exe' -Encoding ASCII
  Set-Content -Path $fx.PrevLib -Value 'old-lib' -Encoding ASCII
  $fxMarker = @{
    schema_version = 1; expected_version = '9.9.10'; had_prev_exe = $true; had_prev_lib = $true
    prev_exe = $fx.PrevExe; prev_lib = $fx.PrevLib
  } | ConvertTo-Json -Compress
  Set-Content -Path $fx.Marker -Value $fxMarker -Encoding ASCII
  $script:InstallSwapInProgress = $true
  $script:InstallSwapPrefix = $dir
  $script:InstallSwapPrevExe = $fx.PrevExe
  $script:InstallSwapPrevLib = $fx.PrevLib
  $script:InstallSwapExpectedVersion = '9.9.10'
  return $fx
}
function Read-Text($p) { if (Test-Path $p) { return (Get-Content $p -Raw).Trim() } return 'absent' }

# -- 12a. Commit flushes the new pair before it drops the parked one --------
$c = New-SwapFixture 'pcommitflush'
$hold = [IO.File]::Open($c.Lib, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
$priorEap = $ErrorActionPreference
$commitThrew = $false
try {
  $ErrorActionPreference = 'Stop'
  Complete-RecuedInstallSwap
} catch {
  $commitThrew = $true
} finally {
  $ErrorActionPreference = $priorEap
  $hold.Dispose()
}
$wayBackKept = (Test-Path $c.PrevExe) -and (Test-Path $c.PrevLib) -and (Test-Path $c.Marker) -and `
               ((Read-Text $c.Marker) -notmatch 'committed') -and $script:InstallSwapInProgress
# With the handle gone, the same armed transaction commits and cleans up.
$retryThrew = $false
try { $ErrorActionPreference = 'Stop'; Complete-RecuedInstallSwap } catch { $retryThrew = $true } finally { $ErrorActionPreference = $priorEap }
$committedClean = (-not $retryThrew) -and (-not (Test-Path $c.PrevExe)) -and (-not (Test-Path $c.PrevLib)) -and `
                  (-not (Test-Path $c.Marker)) -and (-not $script:InstallSwapInProgress) -and ((Read-Text $c.Exe) -eq 'new-exe')
$ok = ($swapFns.Count -eq $swapWant.Count) -and $commitThrew -and $wayBackKept -and $committedClean
Report 'commit-flushes-before-dropping-rollback' $ok "found=$($swapFns.Count) of $($swapWant.Count) refused_unflushable=$commitThrew way_back_kept=$wayBackKept retry_committed=$committedClean"

# -- 12b. A rollback completes even when the restored pair cannot be flushed --
# The shape of a forced reinstall over a RUNNING server: its recued.exe is
# renamed aside and back, and nothing can open it for write. The restore must
# still finish -- previous pair live, marker retired -- with a warning, not a
# report that a finished restore was incomplete. The holder shares DELETE so the
# renames go through, and denies the write access the flush needs.
$u = New-SwapFixture 'pundoflush'
$hold = [IO.File]::Open($u.PrevLib, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::Read -bor [IO.FileShare]::Delete))
try { $undoOut = @(Undo-RecuedInstallSwap 3>&1) } finally { $hold.Dispose() }
$undoReturned = @($undoOut | Where-Object { $_ -is [bool] })
$undoWarned = @($undoOut | Where-Object {
  $_ -is [System.Management.Automation.WarningRecord] -and $_.Message -match 'restored previous pair could not be flushed'
}).Count -gt 0
$undoDone = ($undoReturned.Count -eq 1) -and ($undoReturned[0] -eq $true) -and (-not $script:InstallSwapInProgress) -and `
            (-not (Test-Path $u.Marker)) -and (-not (Test-Path $u.PrevExe)) -and (-not (Test-Path $u.PrevLib)) -and `
            ((Read-Text $u.Exe) -eq 'old-exe') -and ((Read-Text $u.Lib) -eq 'old-lib')
$ok = $undoWarned -and $undoDone
Report 'undo-restored-pair-flush-best-effort' $ok "returned=$($undoReturned -join ',') warned=$undoWarned restored_and_retired=$undoDone"

# Real fixture pairs for the end-to-end recovery arms: 9.9.10 from p1 (arm 3)
# and 9.9.9 from p7 (arm 7).
$exe9 = Join-Path $p7 'recued.exe'
$addon9 = Join-Path $p7 'lib\better_sqlite3.node'
$hash9 = Sha $exe9
function New-RecoveryPrefix($Name, $Nonce) {
  $dir = Join-Path $root $Name
  New-Item -ItemType Directory -Force -Path (Join-Path $dir 'lib') | Out-Null
  return @{
    Dir = $dir
    Exe = Join-Path $dir 'recued.exe'
    Lib = Join-Path $dir 'lib\better_sqlite3.node'
    PrevExe = Join-Path $dir "recued.exe.prev.$Nonce"
    PrevLib = Join-Path $dir "lib\better_sqlite3.node.prev.$Nonce"
    Marker = Join-Path $dir '.swap-in-progress'
    Lock = Join-Path $dir 'recued-update.lock'
  }
}
function Write-TestMarker($Path, $Schema, $PrevExe, $PrevLib) {
  $body = @{
    schema_version = $Schema; expected_version = '9.9.10'
    had_prev_exe = (-not [string]::IsNullOrEmpty($PrevExe)); had_prev_lib = (-not [string]::IsNullOrEmpty($PrevLib))
    prev_exe = $PrevExe; prev_lib = $PrevLib
  }
  if ($Schema -eq 2) { $body.phase = 'committed' }
  Set-Content -Path $Path -Value ($body | ConvertTo-Json -Compress) -Encoding ASCII
}

# -- 12c. Recovery keeps an interrupted candidate only once it is on disk ---
# Healthy 9.9.10 candidate, parked 9.9.9 pair, schema-1 marker. While the
# candidate cannot be flushed, the recovery must refuse and keep everything; the
# next run, with the handle gone, keeps the candidate and clears the debris.
$k = New-RecoveryPrefix 'pkeepflush' '11111111111111111111111111111111'
Copy-Item -Force $exe1 $k.Exe
Copy-Item -Force $addon1 $k.Lib
Copy-Item -Force $exe9 $k.PrevExe
Copy-Item -Force $addon9 $k.PrevLib
Write-TestMarker $k.Marker 1 $k.PrevExe $k.PrevLib
$hold = [IO.File]::Open($k.Lib, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try { $r = Invoke-Install 'v2' $k.Dir } finally { $hold.Dispose() }
$saidKeepFlush = (($r.Out -replace '\s+', ' ') -match 'passes self-test but could not be flushed')
$keptAll = (Test-Path $k.PrevExe) -and (Test-Path $k.PrevLib) -and (Test-Path $k.Marker) -and `
           ((Read-Text $k.Marker) -notmatch 'committed') -and (-not (Test-Path $k.Lock))
$r2 = Invoke-Install 'v2' $k.Dir
$keepCleaned = ($r2.Code -eq 0) -and (-not (Test-Path $k.PrevExe)) -and (-not (Test-Path $k.PrevLib)) -and `
               (-not (Test-Path $k.Marker)) -and ((Sha $k.Exe) -eq $secondHash)
$ok = ($r.Code -ne 0) -and $saidKeepFlush -and $keptAll -and $keepCleaned
Report 'recovery-keeps-candidate-only-once-flushed' $ok "code=$($r.Code) said_flush=$saidKeepFlush way_back_kept=$keptAll then_code=$($r2.Code) cleaned=$keepCleaned"

# -- 12d. Recovery completes a restore even when that pair cannot be flushed --
# Unhealthy candidate (9.9.10 exe, no addon), parked 9.9.9 pair, the restored
# addon held without write sharing for the WHOLE run. The restore goes through,
# the failed flush only warns, and the marker is retired in the same run; the
# rest of the run then finds 9.9.9 current, so it exits 0.
$d = New-RecoveryPrefix 'prestoreflush' '22222222222222222222222222222222'
Copy-Item -Force $exe1 $d.Exe
Copy-Item -Force $exe9 $d.PrevExe
Copy-Item -Force $addon9 $d.PrevLib
Write-TestMarker $d.Marker 1 $d.PrevExe $d.PrevLib
$hold = [IO.File]::Open($d.PrevLib, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::Read -bor [IO.FileShare]::Delete))
try { $r = Invoke-Install 'good' $d.Dir } finally { $hold.Dispose() }
$restoreWarned = (($r.Out -replace '\s+', ' ') -match 'restored previous pair could not be flushed')
$restoreDone = ((Sha $d.Exe) -eq $hash9) -and ((Sha $d.Lib) -eq (Sha $addon9)) -and (-not (Test-Path $d.PrevExe)) -and `
               (-not (Test-Path $d.PrevLib)) -and (-not (Test-Path $d.Marker)) -and (-not (Test-Path $d.Lock))
$ok = ($r.Code -eq 0) -and $restoreWarned -and $restoreDone
Report 'recovery-restored-pair-flush-best-effort' $ok "code=$($r.Code) warned=$restoreWarned restored_and_retired=$restoreDone"

# -- 12e. A committed marker is recognised: a healthy candidate is kept ------
# Death after the commit record, before cleanup finished. An installer that
# only knows schema 1 refuses this marker outright.
$e = New-RecoveryPrefix 'pcommittedkeep' '33333333333333333333333333333333'
Copy-Item -Force $exe1 $e.Exe
Copy-Item -Force $addon1 $e.Lib
Copy-Item -Force $exe9 $e.PrevExe
Copy-Item -Force $addon9 $e.PrevLib
Write-TestMarker $e.Marker 2 $e.PrevExe $e.PrevLib
$r = Invoke-Install 'v2' $e.Dir
$saidKept = (($r.Out -replace '\s+', ' ') -match 'passes self-test; keeping it')
$committedKept = (-not (Test-Path $e.Marker)) -and (-not (Test-Path $e.PrevExe)) -and (-not (Test-Path $e.PrevLib)) -and `
                 ((Sha $e.Exe) -eq $secondHash) -and (-not (Test-Path $e.Lock))
$ok = ($r.Code -eq 0) -and $saidKept -and $committedKept
Report 'committed-marker-candidate-kept' $ok "code=$($r.Code) said_kept=$saidKept clean=$committedKept"

# -- 12f. A COMMITTED MARKER NEVER TREATS A DELETED BACKUP AS UNMOVED -------
# Model a power cut after the durable commit record and after cleanup deleted
# one rollback witness, followed by damage to the live candidate. The schema-1
# rule (named but absent means displacement never happened) would keep or delete
# the wrong generation here. Schema 2 must preserve all evidence and refuse to
# delete either live file because the named backup is already gone.
$g = New-RecoveryPrefix 'pcommittedgone' 'fedcba9876543210fedcba9876543210'
Set-Content -Path $g.Lib -Value 'committed-live-addon' -Encoding ASCII
Write-TestMarker $g.Marker 2 $g.PrevExe ''
$beforeCommittedLib = Sha $g.Lib
$r = Invoke-Install 'v2' $g.Dir
$saidCommitted = (($r.Out -replace '\s+', ' ') -match 'committed candidate is unhealthy.*rollback witness is already gone')
$evidenceKept = (Test-Path $g.Marker) -and ((Sha $g.Lib) -eq $beforeCommittedLib) -and (-not (Test-Path $g.Exe))
$ok = ($r.Code -ne 0) -and $saidCommitted -and $evidenceKept
Report 'committed-missing-witness-refused' $ok "code=$($r.Code) said=$saidCommitted evidence_kept=$evidenceKept"

# -- 13. THE WEBCLIENT SWAP NEVER TRADES A VERIFIED BUNDLE FOR DEBRIS ---------
# !!! MEASURED ON THIS HOST, NOT ASSUMED. A file held open WITHOUT delete sharing
# blocks renaming its directory too (the swap then fails before promotion), and
# one held WITH delete sharing is unlinked anyway (POSIX delete semantics), so
# no share mode gives "the directory renames, the delete fails". A RUNNING image
# does: the loader shares delete, so its directory renames, but Windows refuses
# to delete an image while it runs. These arms run a copy of PING.EXE where a
# scanner or indexer would hold a file. Verification uses the SHIPPED
# Test-RecuedWebclientBundle, extracted via the AST as in arm 9.
$wcToks = $null; $wcErrs = $null
$wcAst = [System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$wcToks, [ref]$wcErrs)
$wcWant = @('Test-RecuedWebclientPath', 'Get-RecuedContainedWebclientPath', 'Test-RecuedWebclientBundle')
$wcFns = @($wcAst.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) |
           Where-Object { $wcWant -contains $_.Name })
foreach ($wcFn in $wcFns) { . ([scriptblock]::Create($wcFn.Extent.Text)) }
$wcVerifierOk = ($wcFns.Count -eq $wcWant.Count)

function Start-Holder($Exe) {
  Copy-Item -Force (Join-Path $env:WINDIR 'System32\PING.EXE') $Exe
  $proc = Start-Process -FilePath $Exe -ArgumentList '-n 300 127.0.0.1' -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 1500
  return $proc
}
function Stop-Holder($Proc) {
  if ($null -eq $Proc) { return }
  Stop-Process -Id $Proc.Id -Force -ErrorAction SilentlyContinue
  [void]$Proc.WaitForExit(15000)
}
# Every file under a directory, by relative path and hash: "untouched" and
# "identical to a fresh install" are both exact comparisons of this string.
function Get-TreePrint($Dir) {
  if (-not (Test-Path -LiteralPath $Dir)) { return 'absent' }
  $prints = @(Get-ChildItem -LiteralPath $Dir -Recurse -File -Force | Sort-Object FullName | ForEach-Object {
    $_.FullName.Substring($Dir.Length) + '=' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
  })
  return ($prints -join '|')
}
function Read-Stamp($Dir) { return (Read-Text (Join-Path $Dir '.recued-installed-version')) }

# -- 13a. A promoted bundle survives a displaced one that cannot be deleted --
# Fresh 9.9.9 install, then mark its bundle stale so the same-version run
# replaces it, with the holder running INSIDE the bundle being displaced. The
# new bundle must go live and stay live; the displaced one is left as debris
# with a warning, and the next run retires it without restoring it.
$wa = Join-Path $root 'pwchold'
$r = Invoke-Install 'good' $wa
$waDir = Join-Path $wa 'webclient'
$waBackup = "$waDir.install-old"
$waFresh = Get-TreePrint $waDir
Set-Content -Path (Join-Path $waDir '.recued-installed-version') -Value '9.9.8' -Encoding ASCII
$holder = Start-Holder (Join-Path $waDir 'holder.exe')
try { $r = Invoke-Install 'good' $wa } finally { $holderAlive = -not $holder.HasExited; Stop-Holder $holder }
$waWarned = (($r.Out -replace '\s+', ' ') -match 'webclient 9.9.9 is installed, but the previous bundle')
$waLive = $wcVerifierOk -and (Test-RecuedWebclientBundle $waDir) -and ((Read-Stamp $waDir) -eq '9.9.9') -and `
          ($waFresh -ne 'absent') -and ((Get-TreePrint $waDir) -eq $waFresh)
$waDebris = Test-Path (Join-Path $waBackup 'holder.exe')
$r2 = Invoke-Install 'good' $wa
$waRetired = ($r2.Code -eq 0) -and (-not (Test-Path $waBackup)) -and ((Get-TreePrint $waDir) -eq $waFresh)
$ok = $holderAlive -and ($r.Code -eq 0) -and $waWarned -and $waLive -and $waDebris -and $waRetired
Report 'webclient-promotion-survives-undeletable-backup' $ok "holder_alive=$holderAlive code=$($r.Code) warned=$waWarned new_live_verifies=$waLive debris_left=$waDebris then_code=$($r2.Code) retired_not_restored=$waRetired"

# -- 13b. A leftover backup beside an intact OLDER bundle is debris -----------
# The reconcile judged the live bundle against the release being installed NOW,
# so an intact 9.9.8 bundle under a 9.9.9 run read as a broken swap: it was
# deleted and the leftover restored over it. The nowebclient feed makes the run
# touch nothing else in the bundle directory.
$wb = Join-Path $root 'pwcdebris'
$r = Invoke-Install 'nowebclient' $wb
$wbDir = Join-Path $wb 'webclient'
$wbBackup = "$wbDir.install-old"
$olderBundle = Join-Path $pLegacy 'webclient'
$wbSetup = ($r.Code -eq 0) -and (-not (Test-Path $wbDir)) -and (Test-Path (Join-Path $olderBundle 'webclient-bundle-manifest.json'))
if ($wbSetup) { Copy-Item -Recurse -Force $olderBundle $wbDir }
New-Item -ItemType Directory -Force -Path $wbBackup | Out-Null
Set-Content -Path (Join-Path $wbBackup 'index.html') -Value 'half-deleted debris' -Encoding ASCII
$wbBefore = Get-TreePrint $wbDir
$wbOlder = $wbSetup -and ((Read-Stamp $wbDir) -eq '9.9.8') -and $wcVerifierOk -and (Test-RecuedWebclientBundle $wbDir)
$r = Invoke-Install 'nowebclient' $wb
$wbUntouched = ($wbBefore -ne 'absent') -and ((Get-TreePrint $wbDir) -eq $wbBefore)
$wbDebrisGone = -not (Test-Path $wbBackup)
$ok = $wbOlder -and ($r.Code -eq 0) -and $wbUntouched -and $wbDebrisGone
Report 'webclient-debris-beside-older-bundle-removed' $ok "setup_older_verifies=$wbOlder code=$($r.Code) live_untouched=$wbUntouched debris_gone=$wbDebrisGone"

# -- 13c. An uncleared backup name skips the update instead of nesting into it --
# Move-Item onto an EXISTING directory moves the source INSIDE it (measured on
# this host, with and without -Force). With the holder running inside a leftover
# backup, the stale 9.9.8 bundle must stay exactly as it is, the update be
# skipped with a warning, and nothing nested; with the holder gone, the next
# run retires the leftover and updates normally.
$wn = Join-Path $root 'pwcnest'
$r = Invoke-Install 'good' $wn
$wnDir = Join-Path $wn 'webclient'
$wnBackup = "$wnDir.install-old"
Set-Content -Path (Join-Path $wnDir '.recued-installed-version') -Value '9.9.8' -Encoding ASCII
$wnBefore = Get-TreePrint $wnDir
New-Item -ItemType Directory -Force -Path $wnBackup | Out-Null
$holder = Start-Holder (Join-Path $wnBackup 'holder.exe')
try { $r = Invoke-Install 'good' $wn } finally { $holderAlive = -not $holder.HasExited; Stop-Holder $holder }
$wnWarned = (($r.Out -replace '\s+', ' ') -match 'skipping the webclient 9.9.9 update this run')
$wnUntouched = ($wnBefore -ne 'absent') -and ((Get-TreePrint $wnDir) -eq $wnBefore) -and ((Read-Stamp $wnDir) -eq '9.9.8')
$wnNotNested = (-not (Test-Path (Join-Path $wnBackup 'webclient'))) -and (Test-Path (Join-Path $wnBackup 'holder.exe'))
$r2 = Invoke-Install 'good' $wn
$wnHealed = ($r2.Code -eq 0) -and (-not (Test-Path $wnBackup)) -and ((Read-Stamp $wnDir) -eq '9.9.9') -and `
            $wcVerifierOk -and (Test-RecuedWebclientBundle $wnDir)
$ok = $holderAlive -and ($r.Code -eq 0) -and $wnWarned -and $wnUntouched -and $wnNotNested -and $wnHealed
Report 'webclient-update-skipped-while-backup-name-held' $ok "holder_alive=$holderAlive code=$($r.Code) warned=$wnWarned live_untouched=$wnUntouched not_nested=$wnNotNested then_code=$($r2.Code) healed=$wnHealed"

# -- cleanup: leave the host as we found it --------------------------------
Remove-Item -Force $startupLnk, $programsLnk -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
Write-Host 'ARMS-DONE'
