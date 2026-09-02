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
$ok = ($r.Code -eq 0) -and ($firstHash -ne 'absent') -and ($secondHash -ne $firstHash)
Report 'rerun-replaces' $ok "code=$($r.Code) changed=$($secondHash -ne $firstHash)"

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

# -- cleanup: leave the host as we found it --------------------------------
Remove-Item -Force $startupLnk, $programsLnk -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
Write-Host 'ARMS-DONE'
