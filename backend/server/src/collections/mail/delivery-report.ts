import { simpleParser, type AddressObject } from 'mailparser';
import { canonicalizeEmail, mailRecipientInvalidReason, parseAddress } from '@recued/contracts';

/** RFC 3464 reports are observations from mail, not authenticated delivery
 * receipts. Only an explicit, structurally complete report can stop a watch.
 * Ordinary bounce prose and nested/forwarded reports never qualify. */
export interface MailDeliveryReport {
  version: 1;
  original_message_id: string;
  original_from: string;
  original_recipients: string[];
  recipients: { address: string; action: string; status: string; reason?: string }[];
}
export const DELIVERY_REPORT_MAX_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 32768;
const email = (raw: string): string | null => mailRecipientInvalidReason(raw) === null
  ? canonicalizeEmail(parseAddress(raw)!.email) : null;
export const deliveryMessageId = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || raw.length > 998) return null;
  const bare = raw.trim().replace(/^<([^<>]+)>$/, '$1');
  return /^[^\s<>@]+@[^\s<>@]+$/.test(bare) && !/[\u0000-\u001f\u007f]/u.test(bare)
    && Buffer.byteLength(bare) < 996 ? bare : null;
};
/** Duplicates matter here. Map-based header readers would silently choose one
 * of two conflicting Message-IDs, recipients or status fields. */
const fields = (text: string, messageHeaders = false): Map<string, string> | null => {
  if (Buffer.byteLength(text) > MAX_HEADER_BYTES || /\r(?!\n)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return null;
  const result = new Map<string, string>(); let key = '';
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^[ \t]/.test(line)) {
      if (!key) return null;
      result.set(key, result.get(key)! + ' ' + line.trim()); continue;
    }
    const match = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+):[ \t]*(.*)$/.exec(line);
    if (!match || result.size >= 100) return null;
    key = match[1]!.toLowerCase();
    if (result.has(key)) {
      if (!messageHeaders || ['from', 'to', 'cc', 'message-id', 'content-type', 'content-transfer-encoding', 'mime-version', 'return-path'].includes(key)) return null;
      continue;
    }
    result.set(key, match[2]!.trim());
  }
  return result;
};
const splitEntity = (raw: string): { headers: Map<string, string>; body: string; head: string } | null => {
  const boundary = /\r?\n\r?\n/.exec(raw);
  if (!boundary || boundary.index > MAX_HEADER_BYTES) return null;
  const head = raw.slice(0, boundary.index), headers = fields(head, true);
  return headers ? { headers, head, body: raw.slice(boundary.index + boundary[0].length) } : null;
};
export const isDeliveryReportHeader = (entries: Iterable<readonly [string, string]>): boolean => {
  for (const [name, value] of entries) if (name.trim().toLowerCase() === 'content-type' && /^\s*multipart\/report\b/i.test(value)) {
    const types = [...value.matchAll(/(?:^|;)\s*report-type\s*=\s*(?:"([^"]*)"|([^;\s]*))/gi)].map(match => (match[1] ?? match[2] ?? '').toLowerCase());
    // An explicit different report type (for example a read receipt) is not
    // uncertain delivery evidence for every watch in this mailbox.
    return types.length !== 1 || types[0] === 'delivery-status';
  }
  return false;
};
const addresses = (value: AddressObject | AddressObject[] | undefined): string[] | null => {
  const all = (Array.isArray(value) ? value : value ? [value] : []).flatMap(item => item.value);
  if (all.length > 20 || all.some(item => !item.address || !email(item.address))) return null;
  return [...new Set(all.map(item => email(item.address!)!))].sort();
};
/** A deliberately bounded subset: exactly three top-level parts, with a DSN
 * and returned original headers. Encoded, missing or ambiguous evidence stays
 * review-only. No subject/body heuristics, no inference of delivery success. */
export const parseDeliveryReport = async (source: Buffer): Promise<MailDeliveryReport | undefined> => {
  if (source.length > DELIVERY_REPORT_MAX_BYTES) return undefined;
  try {
    const outer = splitEntity(source.toString('utf8')); if (!outer) return undefined;
    const type = outer.headers.get('content-type') ?? '';
    if (!/^multipart\/report\s*;/i.test(type)) return undefined;
    const parsed = await simpleParser(Buffer.from(outer.head + '\r\n\r\n'), { skipHtmlToText: true, skipTextToHtml: true });
    const contentType = parsed.headers.get('content-type');
    if (!contentType || typeof contentType !== 'object' || !('params' in contentType)) return undefined;
    const params = contentType.params as Record<string, string>;
    const boundary = params.boundary;
    if (params['report-type']?.toLowerCase() !== 'delivery-status' || !boundary
      || (type.match(/\bboundary\s*=/gi)?.length ?? 0) !== 1 || (type.match(/\breport-type\s*=/gi)?.length ?? 0) !== 1
      || boundary.length > 70 || !/^[0-9A-Za-z'()+_,.\/:=? -]+$/.test(boundary) || boundary.endsWith(' ')) return undefined;
    const chunks: string[] = []; let collecting = false, closed = false, body = '';
    for (const line of outer.body.replace(/\r\n/g, '\n').split('\n')) {
      if (line.trimEnd() === '--' + boundary || line.trimEnd() === '--' + boundary + '--') {
        if (closed) return undefined;
        if (collecting) chunks.push(body.replace(/\n$/, ''));
        body = ''; collecting = true;
        if (line.trimEnd() === '--' + boundary + '--') { closed = true; collecting = false; }
      } else if (collecting) body += line + '\n';
    }
    if (!closed || chunks.length !== 3) return undefined;
    const parts = chunks.map(splitEntity);
    if (parts.some(part => !part)) return undefined;
    const machine = parts[1]!, original = parts[2]!;
    if (parts[0]!.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/plain'
      || machine.headers.get('content-type')?.trim().toLowerCase() !== 'message/delivery-status'
      || !['text/rfc822-headers', 'message/rfc822'].includes(original.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '')
      || [machine, original].some(part => !['7bit', '8bit', 'binary'].includes(part.headers.get('content-transfer-encoding')?.toLowerCase() ?? '7bit'))) return undefined;
    const returned = original.headers.get('content-type')?.toLowerCase().startsWith('message/rfc822')
      ? splitEntity(original.body) : { head: original.body.trimEnd(), headers: fields(original.body.trimEnd(), true) };
    if (!returned?.headers) return undefined;
    const messageId = deliveryMessageId(returned.headers.get('message-id'));
    if (!messageId || !returned.headers.has('from') || !returned.headers.has('to') && !returned.headers.has('cc')) return undefined;
    const originalMail = await simpleParser(Buffer.from(returned.head + '\r\n\r\n'), { skipHtmlToText: true, skipTextToHtml: true });
    const from = addresses(originalMail.from), to = addresses(originalMail.to), cc = addresses(originalMail.cc);
    if (from?.length !== 1 || !to || !cc || !to.length && !cc.length || new Set([...to, ...cc]).size > 20) return undefined;
    const observation: MailDeliveryReport = { version: 1, original_message_id: messageId, original_from: from[0]!, original_recipients: [...new Set([...to, ...cc])].sort(), recipients: [] };
    const blocks = machine.body.trim().split(/\n[ \t]*\n/).map(block => fields(block));
    if (blocks.length < 2 || blocks.length > 21 || blocks.some(block => !block) || !blocks[0]!.get('reporting-mta')) return observation;
    const recipients: MailDeliveryReport['recipients'] = [];
    for (const block of blocks.slice(1)) {
      const recipient = /^rfc822\s*;\s*(.+)$/i.exec(block!.get('final-recipient') ?? ''), addr = recipient && email(recipient[1]!);
      const action = block!.get('action')?.toLowerCase(), status = block!.get('status');
      if (!addr || !action || !['failed', 'delayed', 'delivered', 'relayed', 'expanded'].includes(action)
        || !status || !/^[245]\.[0-9]{1,3}\.[0-9]{1,3}$/.test(status) || recipients.some(item => item.address === addr)) return observation;
      const prior = block!.get('original-recipient');
      if (prior && email(/^rfc822\s*;\s*(.+)$/i.exec(prior)?.[1] ?? '') !== addr) return observation;
      const diagnostic = block!.get('diagnostic-code');
      const reason = diagnostic?.replace(/^[A-Za-z0-9-]+\s*;\s*/, '').replace(/[ \t]+/g, ' ').slice(0, 500);
      recipients.push({ address: addr, action, status, ...(reason ? { reason } : {}) });
    }
    return { ...observation, recipients };
  } catch { return undefined; }
};

/** Strict reader for retained sync evidence, including when opening a report
 * long after a watch was checked. Legacy and unknown versions fail closed. */
export const storedDeliveryReport = (raw: unknown): MailDeliveryReport | undefined => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as MailDeliveryReport;
  if (value.version !== 1 || deliveryMessageId(value.original_message_id) !== value.original_message_id
    || typeof value.original_from !== 'string' || email(value.original_from) !== value.original_from
    || !Array.isArray(value.original_recipients) || !value.original_recipients.length || value.original_recipients.length > 20
    || value.original_recipients.some(item => typeof item !== 'string' || email(item) !== item)
    || new Set(value.original_recipients).size !== value.original_recipients.length
    || !Array.isArray(value.recipients) || !value.recipients.length || value.recipients.length > 20
    || value.recipients.some(item => !item || typeof item.address !== 'string' || email(item.address) !== item.address
      || !['failed', 'delayed', 'delivered', 'relayed', 'expanded'].includes(item.action) || !/^[245]\.[0-9]{1,3}\.[0-9]{1,3}$/.test(item.status)
      || item.reason !== undefined && (typeof item.reason !== 'string' || item.reason.length > 500 || /[\u0000-\u001f\u007f]/u.test(item.reason)))
    || new Set(value.recipients.map(item => item.address)).size !== value.recipients.length) return undefined;
  return value;
};
