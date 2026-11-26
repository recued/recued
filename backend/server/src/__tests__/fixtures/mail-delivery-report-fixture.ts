/** Real MIME fixture shared by source, watch and browser contract tests. */
export const deliveryReportMime = (options: {
  id?: string; at?: number; originalId?: string; originalFrom?: string; originalTo?: string;
  originalCc?: string; finalRecipient?: string; action?: string; status?: string;
  reason?: string; extraStatus?: string[]; returnedType?: string; to?: string;
} = {}): Buffer => Buffer.from([
  'Received: from relay.example.test by mx.example.test', 'Received: from sender.example.test by relay.example.test',
  'From: Mail Delivery System <mailer-daemon@example.test>', `To: ${options.to ?? 'owner@example.test'}`,
  'Subject: Delivery Status Notification (Failure)', `Message-ID: <${options.id ?? 'failure'}@reports.example.test>`,
  `Date: ${new Date(options.at ?? Date.parse('2026-11-23T18:00:00Z')).toUTCString()}`,
  'Return-Path: <>', 'MIME-Version: 1.0', 'Content-Type: multipart/report; report-type=delivery-status; boundary="dsn-boundary"', '',
  '--dsn-boundary', 'Content-Type: text/plain; charset=utf-8', '', 'This is a delivery report. Your message could not be delivered.',
  '--dsn-boundary', 'Content-Type: message/delivery-status', '', 'Reporting-MTA: dns; mx.example.test', '',
  `Final-Recipient: rfc822; ${options.finalRecipient ?? 'alex@example.test'}`, `Action: ${options.action ?? 'failed'}`,
  `Status: ${options.status ?? '5.1.1'}`, `Diagnostic-Code: smtp; ${options.reason ?? '550 5.1.1 No such user'}`, ...options.extraStatus ?? [], '',
  '--dsn-boundary', `Content-Type: ${options.returnedType ?? 'text/rfc822-headers'}`, '',
  `Message-ID: <${options.originalId ?? 'sent-1@example.test'}>`, `From: ${options.originalFrom ?? 'Owner <owner@example.test>'}`,
  `To: ${options.originalTo ?? 'Alex <alex@example.test>'}`, ...(options.originalCc === '' ? [] : [`Cc: ${options.originalCc ?? 'Copy <copy@example.test>'}`]),
  ...(options.returnedType === 'message/rfc822' ? ['', 'Original message body.'] : []), '', '--dsn-boundary--', '',
].join('\r\n'));
