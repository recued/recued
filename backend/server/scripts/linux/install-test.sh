#!/bin/sh
# Drives distribution/install/install.sh on a REAL Linux host, against a locally
# built and locally SIGNED feed. Run inside a container by
# backend/server/scripts/test-install-linux.mjs -- never by hand: it installs
# packages, writes systemd units, and creates users.
#
# !!! WHY A CONTAINER AND NOT THE VITEST TEST. install-sh-local-feed.test.ts runs
# wherever the suite runs, which is macOS, and that reaches NONE of this:
#   - `sha256_of` picks sha256sum on Linux and shasum on macOS -- different code
#   - the whole `elif command -v systemctl` autostart tree is macOS-unreachable
#   - the root vs non-root split, and $PREFIX under /usr/local
#
# !!! THE ARM THAT MATTERS IS root-with-a-user-bus. install.sh used to branch on
# DBUS_SESSION_BUS_ADDRESS and call it "a desktop session". On a headless server
# pam_systemd sets that for root over plain SSH, so root got a USER unit:
# `systemctl start recued` said "Unit recued.service not found", and Linger=no
# meant it would die with the SSH session and never return at boot. Measured on a
# DigitalOcean droplet 2026-08-31 and fixed by testing `id -u` FIRST. Nothing
# executed that fix until this file.
#
# !! systemd does NOT run as PID 1 here, and does not need to. Branch selection
# only needs `command -v systemctl` to succeed; `daemon-reload` and `enable` fail
# soft by design. What is asserted is WHICH UNIT FILE IS WRITTEN WHERE -- which is
# the thing that was wrong -- not that systemd accepted it.
set -eu

log() { echo "$@"; }
report() {  # <name> <ok:0|1> <detail>
  if [ "$2" = "1" ]; then log "ARM $1 PASS $3"; else log "ARM $1 FAIL $3"; fi
}

apt-get update -qq >/dev/null 2>&1
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  curl jq minisign python3 systemd ca-certificates >/dev/null 2>&1

WORK=/work
FEED=$WORK/feed
mkdir -p "$FEED"
INSTALLER=$WORK/install.sh
cp /src/install.sh "$INSTALLER"

minisign -G -W -f -p "$WORK/test.pub" -s "$WORK/test.key" >/dev/null 2>&1
PUB=$(sed -n '2p' "$WORK/test.pub")

case "$(uname -m)" in
  x86_64)  CPU=x64 ;;
  aarch64) CPU=arm64 ;;
  *) echo "unsupported arch $(uname -m)" >&2; exit 2 ;;
esac
TRIPLE="linux-$CPU"

(cd "$FEED" && python3 -m http.server 8080 --bind 127.0.0.1 >/dev/null 2>&1 &)
sleep 2
BASE=http://127.0.0.1:8080

# The installer delegates the host-wide lease and release-floor mutation to the
# verified candidate, then commits only after `self-test`. A fixture that merely
# echoes --version models an obsolete binary and cannot exercise today's swap.
write_candidate() { # <path> <version>
  candidate_path=$1; candidate_version=$2
  cat > "$candidate_path" <<EOF
#!/bin/sh
set -eu
case "\${1:-}" in
  --version) echo "$candidate_version" ;;
  self-test) echo "self-test ok" ;;
  update-lease)
    op="\${2:-}"; shift 2
    bin_dir=""; lease_pid=""; token=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --bin-dir) bin_dir="\$2"; shift 2 ;;
        --pid) lease_pid="\$2"; shift 2 ;;
        --token) token="\$2"; shift 2 ;;
        --operation) shift 2 ;;
        *) shift ;;
      esac
    done
    if [ "\$op" = claim ]; then
      token="test-\$\$"
      mkdir -p "\$bin_dir"
      printf '{"schema":1,"pid":%s,"operation":"install.sh","token":"%s"}\n' \
        "\$lease_pid" "\$token" > "\$bin_dir/recued-update.lock"
      printf '%s\n' "\$token"
    else
      rm -f "\$bin_dir/recued-update.lock"
    fi
    ;;
  release-floor)
    shift 2
    bin_dir=""; sequence=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --bin-dir) bin_dir="\$2"; shift 2 ;;
        --sequence) sequence="\$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    mkdir -p "\$bin_dir"
    printf '%s\n' "\$sequence" > "\$bin_dir/.release-sequence"
    ;;
  *) exit 2 ;;
esac
EOF
}

# build_feed <name> <version> <mutation: none|badsha|noaddon|tampered>
build_feed() {
  name=$1; version=$2; mutation=$3; seq=${4:-100}
  # Manifest-level fields the installer now gates on (I-10 / I-9).
  expires=2099-01-01T00:00:00Z
  schema=1
  [ "$mutation" = "expired" ]   && expires=2000-01-01T00:00:00Z
  [ "$mutation" = "newschema" ] && schema=99
  d="$FEED/$name"
  mkdir -p "$d"
  # A shell script IS executable on Linux, so unlike the Windows side this stub
  # answers `--version` and the real version-comparison branches get exercised.
  if [ "$mutation" = "badexe" ]; then
    # Passes signature + sha256 and is executable, but cannot answer --version.
    # This is the wrong-arch / wrong-libc shape: every byte check passes and the
    # result still cannot run, which is exactly when the smoke check fires.
    printf '#!/bin/sh\nexit 1\n' > "$d/recued-$TRIPLE"
  else
    write_candidate "$d/recued-$TRIPLE" "$version"
  fi
  chmod +x "$d/recued-$TRIPLE"
  printf 'stub native addon %s\n' "$version" > "$d/better_sqlite3-$TRIPLE.node"
  minisign -Sm "$d/recued-$TRIPLE" -s "$WORK/test.key" >/dev/null 2>&1
  minisign -Sm "$d/better_sqlite3-$TRIPLE.node" -s "$WORK/test.key" >/dev/null 2>&1
  bsha=$(sha256sum "$d/recued-$TRIPLE" | cut -d' ' -f1)
  lsha=$(sha256sum "$d/better_sqlite3-$TRIPLE.node" | cut -d' ' -f1)
  [ "$mutation" = "badsha" ] && bsha=0000000000000000000000000000000000000000000000000000000000000000
  if [ "$mutation" = "noaddon" ]; then
    cat > "$d/manifest.json" <<JSON
{"sequence":$seq,"expires_at":"$expires","schema_version":$schema,
"channels":{"stable":{"version":"$version","artifacts":{
"$TRIPLE":{"url":"$BASE/$name/recued-$TRIPLE","sha256":"$bsha"}}}}}
JSON
  else
    cat > "$d/manifest.json" <<JSON
{"sequence":$seq,"expires_at":"$expires","schema_version":$schema,
"channels":{"stable":{"version":"$version","artifacts":{
"$TRIPLE":{"url":"$BASE/$name/recued-$TRIPLE","sha256":"$bsha"},
"lib-$TRIPLE":{"url":"$BASE/$name/better_sqlite3-$TRIPLE.node","sha256":"$lsha"}}}}}
JSON
  fi
  # Field OMISSION, not corruption: the canonical parser requires all three, so
  # a feed missing one is malformed. The installer used to treat absence as "an
  # old feed" and carry on, which made omitting a field the cheapest way past
  # every gate.
  case "$mutation" in
    noseq)    jq 'del(.sequence)'       "$d/manifest.json" > "$d/m.tmp" && mv "$d/m.tmp" "$d/manifest.json" ;;
    noexp)    jq 'del(.expires_at)'     "$d/manifest.json" > "$d/m.tmp" && mv "$d/m.tmp" "$d/manifest.json" ;;
    noschema) jq 'del(.schema_version)' "$d/manifest.json" > "$d/m.tmp" && mv "$d/m.tmp" "$d/manifest.json" ;;
    edgebehind)
      # stable AHEAD of edge, both signed in one manifest: an edge subscriber
      # must take stable, never be pulled backwards.
      #
      # ⛔⛔ DISTINCT BYTES AND DISTINCT URLS. The first version of this arm made
      # edge a COPY of stable with only the version STRING changed, so both
      # channels pointed at the same artifact and the stub printed the stable
      # version whichever entry was chosen. The assertion could not tell the two
      # outcomes apart and passed against a resolver that was picking edge — a
      # 22/22 green over a broken selector. A test whose arms cannot be
      # distinguished is not a test.
      write_candidate "$d/recued-$TRIPLE.edge" "0.0.1"
      chmod +x "$d/recued-$TRIPLE.edge"
      printf 'stub native addon edge\n' > "$d/better_sqlite3-$TRIPLE.node.edge"
      minisign -Sm "$d/recued-$TRIPLE.edge" -s "$WORK/test.key" >/dev/null 2>&1
      minisign -Sm "$d/better_sqlite3-$TRIPLE.node.edge" -s "$WORK/test.key" >/dev/null 2>&1
      ebsha=$(sha256sum "$d/recued-$TRIPLE.edge" | cut -d' ' -f1)
      elsha=$(sha256sum "$d/better_sqlite3-$TRIPLE.node.edge" | cut -d' ' -f1)
      jq --arg bu "$BASE/$name/recued-$TRIPLE.edge" --arg bs "$ebsha" \
         --arg lu "$BASE/$name/better_sqlite3-$TRIPLE.node.edge" --arg ls "$elsha" \
         --arg t "$TRIPLE" \
         '.channels.edge = {version:"0.0.1", artifacts:{
            ($t): {url:$bu, sha256:$bs},
            ("lib-" + $t): {url:$lu, sha256:$ls}}}' \
        "$d/manifest.json" > "$d/m.tmp" && mv "$d/m.tmp" "$d/manifest.json" ;;
  esac
  minisign -Sm "$d/manifest.json" -s "$WORK/test.key" >/dev/null 2>&1
  # Edited AFTER signing -- the only way to prove the signature is really checked.
  if [ "$mutation" = "tampered" ]; then
    sed -i 's/"version":"'"$version"'"/"version":"6.6.6"/' "$d/manifest.json"
  fi
}

# run_install <feed> <prefix> <autostart> [extra env assignments...]
run_install() {
  feed=$1; prefix=$2; autostart=$3; shift 3
  env RECUED_MANIFEST_URL="$BASE/$feed/manifest.json" \
      RECUED_PREFIX="$prefix" RECUED_BINDIR="$prefix/bin" \
      RECUED_RELEASE_PUBKEY="$PUB" RECUED_AUTOSTART="$autostart" \
      "$@" sh "$INSTALLER" > "$WORK/$feed.log" 2>&1
  echo $?
}

build_feed good     9.9.9  none
build_feed v2       9.9.10 none
build_feed badsha   9.9.9  badsha
build_feed noaddon  9.9.9  noaddon
build_feed tampered 9.9.9  tampered
build_feed badexe   9.9.11 badexe
build_feed replayed 9.9.12 none      1
build_feed older    9.9.9  none      200
build_feed expired  9.9.12 expired
build_feed newschem 9.9.12 newschema
build_feed noseq    9.9.12 noseq
build_feed noexp    9.9.12 noexp
build_feed noschema 9.9.12 noschema
build_feed edgeback 9.9.13 edgebehind

# -- 1. A signed release installs, exe + addon, hashed with sha256sum ------
P=/opt/p1
code=$(run_install good "$P" 0 || true)
ok=0
if [ "$code" = "0" ] && [ -x "$P/recued" ] && [ -f "$P/lib/better_sqlite3.node" ] \
   && grep -q "signature VERIFIED" "$WORK/good.log"; then ok=1; fi
report fresh-signed $ok "code=$code exe=$([ -x "$P/recued" ] && echo 1 || echo 0) addon=$([ -f "$P/lib/better_sqlite3.node" ] && echo 1 || echo 0) ver=$("$P/recued" --version 2>/dev/null || echo none)"

# -- 2. THE INSTALLER REFUSES TO UPGRADE A HEALTHY INSTALL ----------------
# ⛔ THIS ARM'S CONTRACT INVERTED ON PURPOSE. Re-running the installer over a
# working install used to replace the payload, skipping the update lease, the
# recoverable ledger entry, the pre-migration snapshot and the boot-health
# revert — a second updater with none of the safety of the first. It is
# bootstrap/repair only now.
code=$(run_install v2 "$P" 0 || true)
v=$("$P/recued" --version 2>/dev/null || echo none)
ok=0
if [ "$code" != "0" ] && [ "$v" = "9.9.9" ] \
   && grep -q "does not upgrade a working install" "$WORK/v2.log"; then ok=1; fi
report upgrade-refused-on-healthy-install $ok "code=$code still=$v"

# -- 2b. …and RECUED_FORCE=1 still replaces it, saying what is skipped ----
code=$(run_install v2 "$P" 0 RECUED_FORCE=1 || true)
v=$("$P/recued" --version 2>/dev/null || echo none)
ok=0
if [ "$code" = "0" ] && [ "$v" = "9.9.10" ] \
   && grep -q "No lease, ledger, snapshot or boot-health revert" "$WORK/v2.log"; then ok=1; fi
report upgrade-forced-and-warned $ok "code=$code version=$v"

# -- 3. Re-running while current downloads nothing ------------------------
code=$(run_install v2 "$P" 0 || true)
ok=0
if [ "$code" = "0" ] && grep -q "already on 9.9.10" "$WORK/v2.log"; then ok=1; fi
report already-current $ok "code=$code said_current=$(grep -c 'already on 9.9.10' "$WORK/v2.log")"

# -- 4. A sha256 mismatch installs nothing --------------------------------
P2=/opt/p2
code=$(run_install badsha "$P2" 0 || true)
ok=0
if [ "$code" != "0" ] && [ ! -e "$P2/recued" ] && grep -q "sha256 mismatch" "$WORK/badsha.log"; then ok=1; fi
report sha-mismatch-refused $ok "code=$code exe=$([ -e "$P2/recued" ] && echo 1 || echo 0)"

# -- 5. A binary with no native addon is refused --------------------------
P3=/opt/p3
code=$(run_install noaddon "$P3" 0 || true)
ok=0
if [ "$code" != "0" ] && [ ! -e "$P3/recued" ] && grep -q "native addon" "$WORK/noaddon.log"; then ok=1; fi
report no-addon-refused $ok "code=$code exe=$([ -e "$P3/recued" ] && echo 1 || echo 0)"

# -- 6. A manifest edited after signing is refused ------------------------
P4=/opt/p4
code=$(run_install tampered "$P4" 0 || true)
ok=0
if [ "$code" != "0" ] && [ ! -e "$P4/recued" ] \
   && grep -q "signature verification FAILED" "$WORK/tampered.log"; then ok=1; fi
report tampered-manifest-refused $ok "code=$code exe=$([ -e "$P4/recued" ] && echo 1 || echo 0)"

# -- 7. THE DROPLET REGRESSION: root with a user bus gets a BOOT unit -----
SYS_UNIT=/etc/systemd/system/recued.service
ROOT_USER_UNIT=/root/.config/systemd/user/recued.service
rm -f "$SYS_UNIT" "$ROOT_USER_UNIT"
P5=/opt/p5
code=$(run_install good "$P5" 1 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus || true)
ok=0
if [ -f "$SYS_UNIT" ] && [ ! -f "$ROOT_USER_UNIT" ] \
   && grep -q "WantedBy=multi-user.target" "$SYS_UNIT"; then ok=1; fi
report root-gets-boot-unit $ok "code=$code system_unit=$([ -f "$SYS_UNIT" ] && echo 1 || echo 0) root_user_unit=$([ -f "$ROOT_USER_UNIT" ] && echo 1 || echo 0)"
rm -f "$SYS_UNIT"

# -- 8. Non-root WITH a user bus keeps LOGIN scope ------------------------
id tester >/dev/null 2>&1 || useradd -m tester
USER_UNIT=/home/tester/.config/systemd/user/recued.service
rm -f "$USER_UNIT" "$SYS_UNIT"
mkdir -p /home/tester/p6 && chown -R tester /home/tester
su tester -c "env RECUED_MANIFEST_URL=$BASE/good/manifest.json RECUED_PREFIX=/home/tester/p6 \
  RECUED_BINDIR=/home/tester/p6/bin RECUED_RELEASE_PUBKEY=$PUB RECUED_AUTOSTART=1 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus HOME=/home/tester \
  sh $INSTALLER" > "$WORK/nonroot-dbus.log" 2>&1 || true
ok=0
if [ -f "$USER_UNIT" ] && [ ! -f "$SYS_UNIT" ] \
   && grep -q "WantedBy=default.target" "$USER_UNIT"; then ok=1; fi
report nonroot-dbus-gets-user-unit $ok "user_unit=$([ -f "$USER_UNIT" ] && echo 1 || echo 0) system_unit=$([ -f "$SYS_UNIT" ] && echo 1 || echo 0)"
rm -f "$USER_UNIT"

# -- 9. Headless non-root arms nothing, and says so only if asked ---------
su tester -c "env RECUED_MANIFEST_URL=$BASE/good/manifest.json RECUED_PREFIX=/home/tester/p7 \
  RECUED_BINDIR=/home/tester/p7/bin RECUED_RELEASE_PUBKEY=$PUB RECUED_AUTOSTART=1 \
  HOME=/home/tester sh $INSTALLER" > "$WORK/nonroot-headless.log" 2>&1 || true
ok=0
if [ ! -f "$USER_UNIT" ] && [ ! -f "$SYS_UNIT" ] \
   && grep -q "autostart needs root here" "$WORK/nonroot-headless.log"; then ok=1; fi
report nonroot-headless-arms-nothing $ok "user_unit=$([ -f "$USER_UNIT" ] && echo 1 || echo 0) explained=$(grep -c 'autostart needs root here' "$WORK/nonroot-headless.log")"

# -- 10. The opt-out writes no unit at all --------------------------------
rm -f "$SYS_UNIT" "$ROOT_USER_UNIT"
P8=/opt/p8
code=$(run_install good "$P8" 0 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus || true)
ok=0
if [ "$code" = "0" ] && [ ! -f "$SYS_UNIT" ] && [ ! -f "$ROOT_USER_UNIT" ]; then ok=1; fi
report autostart-off-writes-nothing $ok "code=$code system_unit=$([ -f "$SYS_UNIT" ] && echo 1 || echo 0)"

# -- 11. A FAILED UPGRADE MUST NOT COST THE WORKING INSTALL ---------------
# Before the fix this ran `rm -rf "$PREFIX"` on smoke failure, taking the
# previous payload and the webclient bundle with it and leaving $BINDIR/recued
# dangling. The owner upgraded and was left with nothing.
P9=/opt/p9
code=$(run_install good "$P9" 0 || true)
sentinel_ver=$("$P9/recued" --version 2>/dev/null || echo none)
code=$(run_install badexe "$P9" 0 || true)
after=$("$P9/recued" --version 2>/dev/null || echo none)
leftovers=$(find "$P9" -name '*.prev.*' 2>/dev/null | wc -l | tr -d ' ')
ok=0
if [ "$code" != "0" ] && [ "$sentinel_ver" = "9.9.9" ] && [ "$after" = "9.9.9" ] \
   && [ -f "$P9/lib/better_sqlite3.node" ] && [ "$leftovers" = "0" ]; then ok=1; fi
report failed-upgrade-keeps-previous $ok "code=$code before=$sentinel_ver after=$after prev_leftovers=$leftovers"

# -- 12. A FAILED FRESH INSTALL REMOVES ONLY WHAT IT CREATED --------------
# RECUED_PREFIX is caller-supplied and unvalidated, so the old `rm -rf "$PREFIX"`
# was bounded only by what the owner happened to pass.
P10=/opt/p10
mkdir -p "$P10"
echo "do not delete me" > "$P10/unrelated.txt"
code=$(run_install badexe "$P10" 0 || true)
ok=0
if [ "$code" != "0" ] && [ -f "$P10/unrelated.txt" ] && [ ! -e "$P10/recued" ]; then ok=1; fi
report failed-fresh-spares-unrelated $ok "code=$code unrelated_kept=$([ -f "$P10/unrelated.txt" ] && echo 1 || echo 0) exe=$([ -e "$P10/recued" ] && echo 1 || echo 0)"

# -- 13. A REPLAYED (lower-sequence) FEED IS REFUSED ----------------------
# Signature and hashes are all VALID here — it is a genuine past manifest. Only
# the anti-replay floor distinguishes it, which is why the installer needed one.
P11=/opt/p11
code=$(run_install good "$P11" 0 || true)
code=$(run_install replayed "$P11" 0 RECUED_FORCE=1 || true)
ok=0
if [ "$code" != "0" ] && grep -q "BELOW the highest" "$WORK/replayed.log" \
   && [ "$("$P11/recued" --version 2>/dev/null || echo none)" = "9.9.9" ]; then ok=1; fi
report replay-refused $ok "code=$code still=$("$P11/recued" --version 2>/dev/null || echo none)"

# -- 14/15. A DOWNGRADE IS REFUSED EVEN THROUGH LEGACY ESCAPE INPUTS -------
# Sequence 200 clears the replay floor, so this isolates the version rule.
P12=/opt/p12
code=$(run_install v2 "$P12" 0 || true)
# ⚠ RECUED_FORCE=1 is needed to get PAST the healthy-install refusal and reach
# the downgrade check at all — the two gates are independent and this arm is
# about the second one.
code=$(run_install older "$P12" 0 RECUED_FORCE=1 || true)
ok=0
if [ "$code" != "0" ] && grep -q "refusing to downgrade" "$WORK/older.log" \
   && [ "$("$P12/recued" --version 2>/dev/null || echo none)" = "9.9.10" ]; then ok=1; fi
report downgrade-refused $ok "code=$code still=$("$P12/recued" --version 2>/dev/null || echo none)"

code=$(run_install older "$P12" 0 RECUED_FORCE=1 RECUED_ALLOW_DOWNGRADE=1 || true)
v=$("$P12/recued" --version 2>/dev/null || echo none)
ok=0
if [ "$code" != "0" ] && grep -q "recued update rollback" "$WORK/older.log" \
   && [ "$v" = "9.9.10" ]; then ok=1; fi
report downgrade-escape-inert $ok "code=$code still=$v"

# -- 16. EXPIRY ALONE DOES NOT CLOSE THE RECOVERY ENTRY POINT --------------
# D-260 deliberately removed the wall-clock refusal. Sequence is the rollback
# protection; a date must not make the newest signed recovery feed unusable.
P13=/opt/p13
code=$(run_install expired "$P13" 0 || true)
v=$("$P13/recued" --version 2>/dev/null || echo none)
ok=0
if [ "$code" = "0" ] && [ "$v" = "9.9.12" ] \
   && ! grep -q "expired at" "$WORK/expired.log"; then ok=1; fi
report expired-feed-still-installs $ok "code=$code version=$v"

# -- 17. A MANIFEST SCHEMA NEWER THAN THIS INSTALLER IS REFUSED -----------
P14=/opt/p14
code=$(run_install newschem "$P14" 0 || true)
ok=0
if [ "$code" != "0" ] && [ ! -e "$P14/recued" ] && grep -q "newer than this" "$WORK/newschem.log"; then ok=1; fi
report new-schema-refused $ok "code=$code exe=$([ -e "$P14/recued" ] && echo 1 || echo 0)"

# -- 18/19/20. AN OMITTED FIELD IS NOT A FREE PASS ------------------------
for m in noseq noexp noschema; do
  P=/opt/p-$m
  code=$(run_install "$m" "$P" 0 || true)
  ok=0
  if [ "$code" != "0" ] && [ ! -e "$P/recued" ]; then ok=1; fi
  report "omitted-$m-refused" $ok "code=$code exe=$([ -e "$P/recued" ] && echo 1 || echo 0)"
done

# -- 21. EDGE MEANS max(stable, edge) -------------------------------------
# The resolver has always done this; the installer read .channels.edge directly,
# so an edge install could be handed an OLDER release than a stable one from the
# same signed manifest.
P21=/opt/p21
code=$(run_install edgeback "$P21" 0 RECUED_CHANNEL=edge || true)
v=$("$P21/recued" --version 2>/dev/null || echo none)
# The two channels now serve DIFFERENT binaries: stable's prints 9.9.13, edge's
# prints 0.0.1. So the reported version names which entry was actually resolved.
ok=0; [ "$code" = "0" ] && [ "$v" = "9.9.13" ] && ok=1
report edge-takes-max $ok "code=$code version=$v (edge serves 0.0.1, stable serves 9.9.13)"

# -- 22. AN ALREADY-CURRENT INSTALL STILL RECORDS THE FLOOR ---------------
# This path exits long before the post-install floor write, so an install that
# was already current never recorded a sequence and stayed open to a replay.
P22=/opt/p22
code=$(run_install good "$P22" 0 || true)
rm -f "$P22/.release-sequence"
code=$(run_install good "$P22" 0 || true)
floor=$(cat "$P22/.release-sequence" 2>/dev/null || echo ABSENT)
ok=0; [ "$code" = "0" ] && [ "$floor" = "100" ] && ok=1
report current-install-seeds-floor $ok "code=$code floor=$floor"

# -- 23. THE OUTER SUPERVISOR IS INSTALLED AND THE UNIT USES IT -----------
# D-178's auto-revert is counted IN-PROCESS, so a payload that cannot execute at
# all never counts its own failure and never reverts — the unit just restarts the
# broken binary forever with a good `recued.old` beside it. The fix is a script
# the update never replaces, and the unit has to actually point at it.
P23=/opt/p23
code=$(run_install good "$P23" 1 || true)
sup="$P23/recued-supervise"
unit=/etc/systemd/system/recued.service
ok=0
if [ "$code" = "0" ] && [ -x "$sup" ] && grep -q "ExecStart=$P23/recued-supervise serve" "$unit" 2>/dev/null; then
  # And it must NOT exec the payload directly any more.
  grep -q "ExecStart=$P23/recued serve" "$unit" 2>/dev/null || ok=1
fi
report supervisor-installed-and-wired $ok \
  "code=$code supervise=$([ -x "$sup" ] && echo x || echo MISSING) exec=$(grep -h '^ExecStart=' "$unit" 2>/dev/null | head -1)"

# -- 24. IT REVERTS A PAYLOAD THAT CANNOT EXECUTE -------------------------
# Runs the SHIPPED script under the container's real /bin/sh (dash), not the
# macOS one that development happens on. The payload here is the wrong-arch
# shape: every byte check passed and it still cannot run.
P24=/opt/p24
code=$(run_install good "$P24" 1 || true)
printf 'THIS IS NOT AN EXECUTABLE\n' > "$P24/recued"
chmod 755 "$P24/recued"
# A stand-in for the previous binary that records how it was asked.
cat > "$P24/recued.old" <<'PREV'
#!/bin/sh
if [ "$1" = "report-boot-failure" ]; then
  echo "$@" >> /work/verdict-args.log
  exit 10
fi
exit 0
PREV
chmod 755 "$P24/recued.old"
rm -f /work/verdict-args.log
RECUED_SUPERVISE_BACKOFF=0 RECUED_SUPERVISE_MAX_STARTS=3 \
  "$P24/recued-supervise" serve --require-enrolled >/work/sup24.log 2>&1 || true
# ^ || true: hitting MAX_STARTS is exit 1, and the harness runs under set -e.
calls=$(wc -l < /work/verdict-args.log 2>/dev/null || echo 0)
# ⛔ --bin-dir MUST be passed. Without it the verdict resolves the binary
# directory from its own process.execPath — correct for a packaged binary, and
# the interpreter's directory through any wrapper, whereupon it reports
# "nothing to revert to" with a perfectly good recued.old sitting right here.
withdir=0
grep -q -- "--bin-dir $P24" /work/verdict-args.log 2>/dev/null && withdir=1
ok=0; [ "$calls" = "3" ] && [ "$withdir" = "1" ] && ok=1
report supervisor-asks-previous-binary $ok \
  "verdict-calls=$calls(want 3) bin-dir-passed=$withdir args=$(head -1 /work/verdict-args.log 2>/dev/null)"

# -- 25. NO AUTOSTART, NO SUPERVISOR --------------------------------------
# The supervisor exists to make a SUPERVISED start safe. An owner who opted out
# of autostart runs the binary themselves and gets no unit; writing a launcher
# they never invoke would just be a file they did not ask for.
P25=/opt/p25
code=$(run_install good "$P25" 0 || true)
ok=0; [ "$code" = "0" ] && [ ! -e "$P25/recued-supervise" ] && ok=1
report supervisor-absent-without-autostart $ok \
  "code=$code supervise=$([ -e "$P25/recued-supervise" ] && echo PRESENT || echo absent)"

echo "ARMS-DONE"
