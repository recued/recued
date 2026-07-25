# D-212 slice 5 — DPAPI probe for the Windows rung.
#
# Run on any Windows box (VM, cloud, ARM64 or x64 — DPAPI's scope semantics do
# not vary by architecture) and paste the output back. Nothing is installed and
# nothing persists: every artefact is written under $env:TEMP and removed.
#
#   powershell -ExecutionPolicy Bypass -File probe-dpapi.ps1
#
# What it answers, and why each matters for the provider:
#   1. Does a LocalMachine round-trip work at all, unprivileged?
#      → whether the rung is usable by a server that is not running as admin.
#   2. Does a CurrentUser round-trip work?
#      → whether the stronger, session-bound scope is an option.
#   3. Is a LocalMachine blob readable by a DIFFERENT user on the same box?
#      → the known weakness. Expected YES. It must be confirmed, not assumed,
#        because it is what decides whether this rung defends only the
#        copied-volume threat or something more.
#   4. Is a blob from THIS machine opaque to another machine?
#      → the actual protection. Verified by shape here; genuinely proven only by
#        carrying the emitted blob to a second box and re-running with -Foreign.

param([string]$Foreign = "")

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security

function Show($label, $value) { "{0,-46} {1}" -f $label, $value }

$secret = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($secret)
$secretB64 = [Convert]::ToBase64String($secret)

Show "whoami" (whoami)
Show "elevated" ((New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator))
Show "os / arch" ("$([System.Environment]::OSVersion.Version) / $env:PROCESSOR_ARCHITECTURE")
""

# --- 4. Foreign-blob mode: prove a blob from another machine does NOT open ---
if ($Foreign -ne "") {
  try {
    [System.Security.Cryptography.ProtectedData]::Unprotect(
      [Convert]::FromBase64String($Foreign), $null, "LocalMachine") | Out-Null
    Show "foreign blob opened here" "YES  <-- BAD, no machine binding"
  } catch {
    Show "foreign blob opened here" "no  <-- correct, machine-bound"
  }
  exit 0
}

# --- 1. LocalMachine round-trip ---
try {
  $lm = [System.Security.Cryptography.ProtectedData]::Protect($secret, $null, "LocalMachine")
  $back = [System.Security.Cryptography.ProtectedData]::Unprotect($lm, $null, "LocalMachine")
  Show "LocalMachine round-trip exact" ([Convert]::ToBase64String($back) -eq $secretB64)
  Show "LocalMachine blob bytes" $lm.Length
  Show "LocalMachine blob is opaque" (-not ([Convert]::ToBase64String($lm)).Contains($secretB64.Substring(0,12)))
} catch { Show "LocalMachine round-trip" "FAILED: $($_.Exception.Message)" }

# --- 2. CurrentUser round-trip ---
try {
  $cu = [System.Security.Cryptography.ProtectedData]::Protect($secret, $null, "CurrentUser")
  $back = [System.Security.Cryptography.ProtectedData]::Unprotect($cu, $null, "CurrentUser")
  Show "CurrentUser round-trip exact" ([Convert]::ToBase64String($back) -eq $secretB64)
} catch { Show "CurrentUser round-trip" "FAILED: $($_.Exception.Message)" }

# --- cross-scope must NOT open: a scope confusion would silently weaken us ---
try {
  [System.Security.Cryptography.ProtectedData]::Unprotect($cu, $null, "LocalMachine") | Out-Null
  Show "CurrentUser blob opens as LocalMachine" "YES  <-- unexpected"
} catch { Show "CurrentUser blob opens as LocalMachine" "no  <-- correct" }

# --- 3. Does a LocalMachine blob survive a service-account context? ---
# Approximated by reporting whether the session is one; a true second-user test
# needs `runas` or a scheduled task under SYSTEM, which is the follow-up if the
# rung is adopted with LocalMachine scope.
Show "session is SYSTEM/service" ($env:USERNAME -eq "$env:COMPUTERNAME`$" -or $env:USERNAME -eq "SYSTEM")
""
"--- carry this to a SECOND machine and run:  probe-dpapi.ps1 -Foreign '<blob>'"
"LocalMachine blob (base64):"
[Convert]::ToBase64String($lm)
