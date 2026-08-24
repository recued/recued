/** Top-level `--help` / unknown-subcommand help text. */

export function cmdHelp(): void {
  console.log(`
  recued — your personal warehouse + 24/7 recipe runner

  Daemon (background):
    start                               Start the server in the background
    stop                                Stop the background server
    restart                             Restart the background server
    status                              Show the running state

  Server (foreground):
    (default)                           Start in the foreground
    --mcp                               Start an MCP stdio server

  Pairing:
    pair                                Show a pairing code + the app.recued.com/pair link

  Recovery:
    recover-keyfile                     Re-create an unopenable server keyfile
                                        from your 24-word recovery key. Rescues
                                        the realm; mints a NEW identity, so every
                                        device must pair again.
    rotate-passphrase                   Change RECUED_IDENTITY_PASSPHRASE on an
                                        openable keyfile. Keeps the identity —
                                        nothing re-pairs. Server must be stopped.

  Audit:
    audit                               List recent runs
    audit <run-id|recipe-id>            Show one run or filter by recipe
    audit activities                    List recent activity events
    audit export                        Export the full audit log as JSON
    audit clear                         Clear every audit entry

  Logs:
    logs                                Print recent daemon log lines
    logs -f                             Follow the daemon log (tail -f)

  Encryption:
    auth-status                         Show lock state + migration status
    unlock                              Unlock the server (prompts for password)
    unlock --recovery-key               Unlock with the 24-word recovery key
    lock                                Lock the server and zero the keys

  LLM config:
    llm                                 Show the llm subcommand help
    llm show [--reveal-keys]            Print the current LLM config (keys redacted)
    llm set-slot <slot> ...             Configure slot_1 or slot_2
    llm set-budget <tokens>             Set the daily token budget (0 = unlimited)
    llm set-strategy <name>             Pool coordination: round_robin | weighted
    llm set-allow-upgrade <bool>        Global allow_llm_upgrade fallback
    llm list-pool-entries               List every free-pool entry
    llm add-pool-entry --type api ...
    llm remove-pool-entry --id <id>
    llm import <path> / export <path>   Round-trip the full config as JSON

  Flags:
    --port <n>                          HTTP port (default: 7717)
    --db <path>                         SQLite path (default: ./recued-server.db)
    --reset-exposure                    One-shot recovery: discard persisted
                                        exposure state + restore the bootstrap-
                                        derived shape (/ws.lan true). Use after
                                        a lockout. Stamps a signed audit row
                                        with action exposure_reset_via_cli
                                        (Ed25519 over server_identity_key).
`);
}
