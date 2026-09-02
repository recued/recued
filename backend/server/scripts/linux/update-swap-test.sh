# Drives a REAL binary through the whole D-178 chain: install -> `recued update
# apply` -> swap -> the outer supervisor -> auto-revert -> the restored binary
# serving again. Run by backend/server/scripts/test-update-swap-linux.mjs, never
# by hand -- the driver builds the binary, mints the key and serves the feed.
#
# !!! WHY THIS EXISTS SEPARATELY FROM install-test.sh. That harness proves the
# INSTALLER against stub binaries; its "recued" is a shell script. Everything
# downstream of the installer -- the manifest parser, the signature gate, the
# staging, the swap, `recued.old` preservation, the ledger, the supervisor's
# verdict -- had never run against a real executable outside unit tests.
#
# !!! THE BINARY MUST BE BUILT WITH A TEST KEY PINNED. The server's trust anchor
# is compiled in and `trusted-release-pubkey.ts` says never to accept it from
# runtime config, so unlike install.sh (which has RECUED_RELEASE_PUBKEY for
# staging feeds) the apply path cannot be pointed at a local feed. The driver
# builds from a detached worktree with the test key pinned; the ONLY difference
# from a shipping binary is that one constant.
set -e
apt-get update -qq >/dev/null 2>&1
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl jq minisign python3 ca-certificates >/dev/null 2>&1

log() { echo "$@"; }
report() {  # <name> <ok:0|1> <detail>
  if [ "$2" = "1" ]; then log "ARM $1 PASS $3"; else log "ARM $1 FAIL $3"; fi
}

WORK=/work; FEED=$WORK/feed; mkdir -p "$FEED"
cp /src/install.sh "$WORK/install.sh"
cp /keys/test.key "$WORK/test.key"
PUB=$(cat /keys/pub.txt)
BASE=http://127.0.0.1:8080
case "$(uname -m)" in
  x86_64)  TRIPLE=linux-x64 ;;
  aarch64) TRIPLE=linux-arm64 ;;
  *) echo "unsupported arch $(uname -m)" >&2; exit 2 ;;
esac
PREFIX=/opt/recued
LEDGER=/var/lib/recued/updates.log

REALVER=$(/bin-src/recued-$TRIPLE --version)
# A PATCH bump: a major one is refused outright (I-4), and this harness is about
# the swap, not that gate.
NEXTVER=$(echo "$REALVER" | awk -F. '{printf "%s.%s.%d", $1, $2, $3+1}')

# <name> <version> <exe: real|bad> <seq>
build_feed() {
  name=$1; version=$2; kind=$3; seq=$4
  d="$FEED/$name"; mkdir -p "$d"
  if [ "$kind" = real ]; then
    cp "/bin-src/recued-$TRIPLE" "$d/recued-$TRIPLE"
  else
    # Validly signed, hash-correct, executable bit set -- and NOT a program.
    # Every byte check the apply performs passes and the payload still cannot
    # run, which is the one case an in-process boot counter can never observe.
    printf 'THIS IS NOT AN EXECUTABLE\n' > "$d/recued-$TRIPLE"
  fi
  chmod +x "$d/recued-$TRIPLE"
  cp "/bin-src/better_sqlite3-$TRIPLE.node" "$d/better_sqlite3-$TRIPLE.node"
  minisign -Sm "$d/recued-$TRIPLE" -s "$WORK/test.key" >/dev/null 2>&1
  minisign -Sm "$d/better_sqlite3-$TRIPLE.node" -s "$WORK/test.key" >/dev/null 2>&1
  bsha=$(sha256sum "$d/recued-$TRIPLE" | cut -d' ' -f1)
  lsha=$(sha256sum "$d/better_sqlite3-$TRIPLE.node" | cut -d' ' -f1)
  # !! The SERVER's parser wants a per-artifact `sig`, and it is the signature
  # TEXT inline, not a URL (`binary-apply-executor.ts` hands it straight to
  # `verify` as `signatureText`). install.sh's own parser does not, which is why
  # install-test.sh's manifests omit it -- two parsers, deliberately.
  bsig=$(cat "$d/recued-$TRIPLE.minisig")
  lsig=$(cat "$d/better_sqlite3-$TRIPLE.node.minisig")
  jq -n --argjson seq "$seq" --arg ver "$version" --arg triple "$TRIPLE" \
        --arg burl "$BASE/$name/recued-$TRIPLE" --arg bsha "$bsha" --arg bsig "$bsig" \
        --arg lurl "$BASE/$name/better_sqlite3-$TRIPLE.node" --arg lsha "$lsha" --arg lsig "$lsig" \
    '{sequence:$seq, expires_at:"2099-01-01T00:00:00Z", schema_version:1, min_launcher_version:1,
      channels:{stable:{version:$ver, released_at:"2026-08-31T00:00:00Z", min_supported:"0.0.1",
        rollout_pct:100, migration:false, artifacts:
        ({} | .[$triple] = {url:$burl, sha256:$bsha, sig:$bsig}
            | .["lib-" + $triple] = {url:$lurl, sha256:$lsha, sig:$lsig})}}}' \
    > "$d/manifest.json"
  minisign -Sm "$d/manifest.json" -s "$WORK/test.key" >/dev/null 2>&1
}

build_feed v1 "$REALVER" real 100
build_feed v2 "$NEXTVER" bad  101
(cd "$FEED" && python3 -m http.server 8080 --bind 127.0.0.1 >"$WORK/http.log" 2>&1 &)
sleep 2

# -- 1. The real binary installs, with the supervisor beside it --------------
env RECUED_MANIFEST_URL="$BASE/v1/manifest.json" RECUED_PREFIX="$PREFIX" \
    RECUED_BINDIR="$PREFIX/bin" RECUED_RELEASE_PUBKEY="$PUB" RECUED_AUTOSTART=1 \
    sh "$WORK/install.sh" > "$WORK/install.log" 2>&1 || true
installed=$("$PREFIX/recued" --version 2>/dev/null || echo none)
ok=0; [ "$installed" = "$REALVER" ] && [ -x "$PREFIX/recued-supervise" ] && ok=1
report install-real-binary $ok "version=$installed supervise=$([ -x "$PREFIX/recued-supervise" ] && echo x || echo MISSING)"

# -- 2. A real `update apply` stages and swaps ------------------------------
set +e
env RECUED_RELEASE_MANIFEST_URL="$BASE/v2/manifest.json" RECUED_CHANNEL=stable \
    "$PREFIX/recued" update apply > "$WORK/apply.log" 2>&1
applycode=$?
set -e
swapped=0; "$PREFIX/recued" --version >/dev/null 2>&1 || swapped=1   # the payload can no longer run
staged=0; grep -q '"kind":"apply_staged"' "$LEDGER" 2>/dev/null && staged=1
oldkept=0; [ -e "$PREFIX/recued.old" ] && oldkept=1
ok=0; [ "$applycode" = "0" ] && [ "$swapped" = "1" ] && [ "$staged" = "1" ] && [ "$oldkept" = "1" ] && ok=1
report apply-swaps-real-binary $ok "code=$applycode payload_broken=$swapped staged=$staged old_kept=$oldkept"

# -- 2b. And it PROMISES what actually happens -----------------------------
# The apply used to tell every binary-channel operator that "nothing reverts it
# automatically on this install" -- true when it was written, and false the
# moment a supervisor is installed beside the binary. A stale promise in the
# safe direction still sends someone to babysit a machine that would have
# recovered on its own; in the other direction it tells them to walk away from
# one that will not. Either way it has to track the install it is describing.
promised=0
grep -q 'the service reverts to the previous binary' "$WORK/apply.log" && promised=1
stale=0
grep -q 'nothing reverts it automatically' "$WORK/apply.log" && stale=1
ok=0; [ "$promised" = "1" ] && [ "$stale" = "0" ] && ok=1
report apply-promises-supervised-revert $ok "says_supervised=$promised says_stale_none=$stale"

# -- 3. The supervisor reverts it -------------------------------------------
# !! `timeout` IS THE SUCCESS CONDITION, NOT A GUARD AGAINST A HANG. Once the
# revert lands, the supervisor starts the RESTORED binary and that serves --
# i.e. it blocks, correctly, forever. The assertions are all on disk and in the
# ledger, so the run is cut short deliberately once it has had time to get there.
set +e
timeout 120 env RECUED_SUPERVISE_BACKOFF=0 RECUED_SUPERVISE_MAX_STARTS=8 \
  "$PREFIX/recued-supervise" serve --require-enrolled > "$WORK/sup.log" 2>&1
set -e
reverted=0; grep -q '"kind":"apply_reverted"' "$LEDGER" 2>/dev/null && reverted=1
oldgone=0; [ -e "$PREFIX/recued.old" ] || oldgone=1
back=$("$PREFIX/recued" --version 2>/dev/null || echo none)
ok=0; [ "$reverted" = "1" ] && [ "$oldgone" = "1" ] && [ "$back" = "$REALVER" ] && ok=1
report supervisor-reverts-real-binary $ok "ledger_reverted=$reverted old_consumed=$oldgone restored_version=$back (want $REALVER)"

# -- 4. And the restored binary actually SERVES -----------------------------
# Not merely "the bytes moved": the supervisor went on to start it, and it got
# far enough to print its own banner rather than dying a fourth time.
served=0; grep -qiE "pairing|recovery key|Press Ctrl" "$WORK/sup.log" 2>/dev/null && served=1
ok=$served
report restored-binary-serves $ok "banner_seen=$served"

echo "ARMS-DONE"
