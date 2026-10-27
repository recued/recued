/** Protocol capabilities, before the existing access and proof checks run. */
export interface MailAccountCapabilities {
  receive_capable: boolean;
  sent_lookup_capable: boolean;
}

export const mailAccountCapabilities = (adapter: string): MailAccountCapabilities => {
  const mailbox = adapter === 'imap' || adapter === 'gmail' || adapter === 'graph';
  return { receive_capable: mailbox, sent_lookup_capable: mailbox };
};

interface MailAccountRoleInput {
  adapter_type?: string;
  send_capable?: boolean;
  receive_capable?: boolean;
  sent_lookup_capable?: boolean;
}

export const mailAccountCanReceive = (row: MailAccountRoleInput): boolean =>
  mailAccountCapabilities(row.adapter_type ?? '').receive_capable && row.receive_capable !== false;

export const mailAccountHasSentSource = (row: MailAccountRoleInput): boolean =>
  mailAccountCapabilities(row.adapter_type ?? '').sent_lookup_capable && row.sent_lookup_capable !== false;

export const mailAccountCanBeInteractiveSender = (row: MailAccountRoleInput): boolean =>
  row.send_capable === true && mailAccountCanReceive(row) && mailAccountHasSentSource(row);
