/** Scoped to the Backup & Recovery workspace; native controls retain their semantics. */
export const BACKUP_WORKSPACE_STYLES = `
[data-backup-workspace]{max-width:940px}
[data-backup-workspace] h2{margin:0 0 20px}
[data-backup-workspace] h3{font-size:17px;margin:0 0 10px}
[data-backup-workspace] p{line-height:1.55;overflow-wrap:anywhere}
[data-backup-workspace] p:empty{display:none}
[data-backup-card],[data-unattended-backups],[data-backup-history-card]{border:1px solid var(--border);border-radius:12px;padding:20px;margin-block:16px;background:var(--surface)}
[data-backup-workspace] [data-recued-archive-backup-panel]{border:0;padding:0;margin:0;background:transparent}
[data-backup-workspace] .archive-backup-body{color:var(--fg-muted)}
[data-backup-disclosure]{border:1px solid var(--border);border-radius:10px;margin-block:14px}
[data-backup-disclosure]>summary{cursor:pointer;padding:12px 14px;min-height:44px;box-sizing:border-box;font-weight:600;line-height:1.5}
[data-backup-disclosure]>summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:8px}
[data-backup-disclosure-body]{padding:0 14px 14px}
[data-backup-disclosure="tools"] [data-backup-disclosure-body]>div+div{border-top:1px solid var(--border);padding-top:20px;margin-top:20px}
[data-backup-disclosure="tools"] h3{margin-top:8px}
[data-backup-tools-attention]{border-left:3px solid var(--accent);padding:8px 12px}
[data-backup-tools-attention][hidden]{display:none}
[data-backup-workspace] [data-remote-backups]{margin-block:0}
[data-backup-workspace] [data-unattended-backups]{margin-top:0}
[data-backup-workspace] [data-remote-backup-history]{margin-bottom:0}
[data-backup-workspace] [data-remote-backup-history]>li+li{border-top:1px solid var(--border)}
[data-backup-workspace] [data-remote-backup-history]>li{padding-block:16px}
[data-backup-workspace] [data-remote-backup-history]>li>p:first-child{margin-top:0}
[data-backup-workspace] [data-remote-backup-history] details{margin-top:12px}
[data-backup-workspace] [data-remote-backup-history] summary{cursor:pointer;min-height:44px;display:list-item;align-content:center}
[data-backup-workspace] label{color:var(--fg)}
[data-backup-workspace] button,[data-backup-workspace] select,[data-backup-workspace] input:not([type=checkbox]){min-height:40px}
@media(max-width:640px){
 [data-backup-card],[data-unattended-backups],[data-backup-history-card]{padding:16px}
 [data-backup-workspace] button,[data-backup-workspace] select,[data-backup-workspace] input:not([type=checkbox]){min-height:44px;max-width:100%}
 [data-backup-workspace] .archive-backup-actions{gap:10px}
}
`;
