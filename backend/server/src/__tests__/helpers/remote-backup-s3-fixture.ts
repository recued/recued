/** Owned loopback S3 protocol fixture. Verifies actual SigV4 requests and body
 * digests; stores only the ciphertext the caller sends. No production bucket. */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const digest = (body: string | Buffer): string => createHash('sha256').update(body).digest('hex');
const encode = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/gu, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const mac = (key: string | Buffer, message: string): Buffer => createHmac('sha256', key).update(message).digest();
export const REMOTE_FIXTURE_ACCESS = 'synthetic-remote-access';
export const REMOTE_FIXTURE_SECRET = 'synthetic-remote-secret';
export const REMOTE_FIXTURE_REPLACEMENT_ACCESS = 'synthetic-replacement-access';
export const REMOTE_FIXTURE_REPLACEMENT_SECRET = 'synthetic-replacement-secret';
export const createRemoteBackupS3Fixture = async () => {
  const objects = new Map<string, { bytes: Buffer; etag: string }>();
  const uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  const calls: { method: string; key: string; bytes: number; replacement_credentials?: true }[] = [];
  const multipartAborts: { key: string; upload_id: string; existed: boolean; status: number; rejected?: true; replacement_credentials?: true }[] = [];
  const faults = { losePutReply: false, loseCompleteReply: false, corruptRead: false, completeError: false, denyDelete: false,
    rejectAbort: false, abortRejectionStatus: 503 as 403 | 503 };
  let beforeDelete: ((key: string) => void) | undefined;
  let replacementCredentials = false;
  let heldReply: { arrived: (object: { key: string; multipart: boolean }) => void;
    ready: Promise<void>; release: () => void; entered: boolean } | undefined;
  const acknowledgeObject = async (key: string, multipart: boolean): Promise<void> => {
    const held = heldReply; if (!held || held.entered) return;
    held.entered = true; held.arrived({ key, multipart }); await held.ready;
  };
  const releaseObjectAcknowledgement = (): void => { heldReply?.release(); heldReply = undefined; };
  let heldPartReply: { arrived: (part: { key: string; upload_id: string; part_number: number }) => void;
    ready: Promise<void>; release: () => void; entered: boolean } | undefined;
  const acknowledgePart = async (key: string, upload_id: string, part_number: number): Promise<void> => {
    const held = heldPartReply; if (!held || held.entered) return;
    held.entered = true; held.arrived({ key, upload_id, part_number }); await held.ready;
  };
  const releasePartAcknowledgement = (): void => { heldPartReply?.release(); heldPartReply = undefined; };
  let heldRead: { arrived: (read: { key: string; prefix_bytes: number; total_bytes: number; replacement_credentials: boolean }) => void;
    ready: Promise<void>; release: () => void; entered: boolean } | undefined;
  const interruptHeldRead = (): void => { heldRead?.release(); heldRead = undefined; };
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks), url = new URL(req.url ?? '/', 'http://fixture.invalid');
      const key = decodeURIComponent(url.pathname.replace(/^\/backup-bucket\/?/u, ''));
      const method = req.method ?? 'GET';
      const auth = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/u.exec(req.headers.authorization ?? '');
      let valid = false;
      const access = replacementCredentials ? REMOTE_FIXTURE_REPLACEMENT_ACCESS : REMOTE_FIXTURE_ACCESS;
      const secret = replacementCredentials ? REMOTE_FIXTURE_REPLACEMENT_SECRET : REMOTE_FIXTURE_SECRET;
      if (auth && auth[1] === access && req.headers['x-amz-content-sha256'] === digest(body)) {
        const signed = auth[4]!, scope = `${auth[2]}/${auth[3]}/s3/aws4_request`;
        const headers = signed.split(';').map(name => `${name}:${String(req.headers[name] ?? '').trim()}\n`).join('');
        const query = [...url.searchParams].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${encode(k)}=${encode(v)}`).join('&');
        const canonical = [method, url.pathname, query, headers, signed, digest(body)].join('\n');
        const signingKey = mac(mac(mac(mac(`AWS4${secret}`, auth[2]!), auth[3]!), 's3'), 'aws4_request');
        const signature = mac(signingKey, ['AWS4-HMAC-SHA256', String(req.headers['x-amz-date']), scope, digest(canonical)].join('\n')).toString('hex');
        valid = signature === auth[5];
      }
      calls.push({ method, key, bytes: body.length, ...(valid && replacementCredentials ? { replacement_credentials: true as const } : {}) });
      if (!valid) { res.writeHead(403); res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>'); return; }
      if (method === 'HEAD' && key === '') { res.writeHead(200); res.end(); return; }
      if (method === 'POST' && url.searchParams.has('uploads')) {
        const id = randomUUID(); uploads.set(id, { key, parts: new Map() });
        res.writeHead(200, { 'content-type': 'application/xml' }); res.end(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`); return;
      }
      const uploadId = url.searchParams.get('uploadId');
      if (uploadId) {
        const upload = uploads.get(uploadId);
        if (method === 'DELETE') multipartAborts.push({ key, upload_id: uploadId, existed: upload?.key === key,
          status: upload?.key !== key ? 404 : faults.rejectAbort ? faults.abortRejectionStatus : 204,
          ...(replacementCredentials ? { replacement_credentials: true as const } : {}),
          ...(upload?.key === key && faults.rejectAbort ? { rejected: true as const } : {}) });
        if (!upload || upload.key !== key) { res.writeHead(404); res.end('<Error><Code>NoSuchUpload</Code></Error>'); return; }
        if (method === 'DELETE') {
          if (faults.rejectAbort) {
            res.writeHead(faults.abortRejectionStatus);
            res.end(`<Error><Code>${faults.abortRejectionStatus === 403 ? 'AccessDenied' : 'ServiceUnavailable'}</Code></Error>`); return;
          }
          uploads.delete(uploadId); res.writeHead(204); res.end(); return;
        }
        if (method === 'PUT') {
          const partNumber = Number(url.searchParams.get('partNumber')); upload.parts.set(partNumber, body);
          await acknowledgePart(key, uploadId, partNumber);
          res.writeHead(200, { etag: `"${digest(body)}"` }); res.end(); return;
        }
        if (method === 'POST') {
          if (faults.completeError) { res.writeHead(200); res.end('<Error><Code>InternalError</Code></Error>'); return; }
          if (req.headers['if-none-match'] !== '*' || objects.has(key)) { res.writeHead(412); res.end(); return; }
          const selected = [...body.toString('utf8').matchAll(/<Part><PartNumber>(\d+)<\/PartNumber><ETag>&quot;([a-f0-9]+)&quot;<\/ETag><\/Part>/gu)];
          const ordered: Buffer[] = [];
          for (let i = 0; i < selected.length; i++) {
            const part = upload.parts.get(Number(selected[i]![1]));
            if (!part || digest(part) !== selected[i]![2] || (i < selected.length - 1 && part.length < 5 * 1024 * 1024)) {
              res.writeHead(400); res.end('<Error><Code>InvalidPart</Code></Error>'); return;
            }
            ordered.push(part);
          }
          if (!ordered.length || ordered.length !== upload.parts.size) { res.writeHead(400); res.end(); return; }
          const combined = Buffer.concat(ordered), etag = `"${digest(combined)}"`;
          objects.set(key, { bytes: combined, etag }); uploads.delete(uploadId);
          await acknowledgeObject(key, true);
          if (faults.loseCompleteReply) { faults.loseCompleteReply = false; req.socket.destroy(); return; }
          res.writeHead(200); res.end(`<CompleteMultipartUploadResult><ETag>${etag}</ETag></CompleteMultipartUploadResult>`); return;
        }
      }
      if (method === 'PUT') {
        if (req.headers['if-none-match'] !== '*' || objects.has(key)) { res.writeHead(412); res.end(); return; }
        const etag = `"${digest(body)}"`; objects.set(key, { bytes: body, etag });
        await acknowledgeObject(key, false);
        if (faults.losePutReply) { faults.losePutReply = false; req.socket.destroy(); return; }
        res.writeHead(200, { etag }); res.end(); return;
      }
      if (method === 'DELETE') beforeDelete?.(key);
      const object = objects.get(key);
      if (!object) { res.writeHead(404); res.end(); return; }
      if (req.headers['if-match'] && req.headers['if-match'] !== object.etag) { res.writeHead(412); res.end(); return; }
      if (method === 'GET' || method === 'HEAD') {
        const bytes = Buffer.from(object.bytes); if (faults.corruptRead) bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
        res.writeHead(200, { etag: object.etag, 'content-type': 'application/octet-stream', 'content-length': bytes.length });
        const held = heldRead;
        if (method === 'GET' && held && !held.entered) {
          held.entered = true;
          const prefix = bytes.subarray(0, Math.min(64 * 1024, bytes.length - 1));
          await new Promise<void>((resolve, reject) => res.write(prefix, error => error ? reject(error) : resolve()));
          held.arrived({ key, prefix_bytes: prefix.length, total_bytes: bytes.length, replacement_credentials: replacementCredentials });
          await held.ready; res.destroy(); return;
        }
        res.end(method === 'HEAD' ? undefined : bytes); return;
      }
      if (method === 'DELETE') {
        if (!req.headers['if-match'] || faults.denyDelete) { res.writeHead(412); res.end(); return; }
        objects.delete(key); res.writeHead(204); res.end(); return;
      }
      res.writeHead(400); res.end();
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Owned S3 fixture did not bind');
  return {
    endpoint: `http://127.0.0.1:${address.port}`, objects, uploads, calls, faults, multipartAborts,
    /** Revoke the original pair; only valid replacement signatures now pass. */
    replaceCredentials(): void { replacementCredentials = true; },
    beforeDelete(callback: (key: string) => void) { beforeDelete = callback; },
    /** Hold one reply only after signed bytes become a complete stored object. */
    holdNextObjectAcknowledgement(): Promise<{ key: string; multipart: boolean }> {
      if (heldReply) throw new Error('Only one S3 object acknowledgement may be held');
      return new Promise(arrived => {
        let release = () => {};
        const ready = new Promise<void>(resolve => { release = resolve; });
        heldReply = { arrived, ready, release, entered: false };
      });
    },
    releaseObjectAcknowledgement,
    /** Hold a signed, stored part before its reply, while the object is unfinished. */
    holdNextPartAcknowledgement(): Promise<{ key: string; upload_id: string; part_number: number }> {
      if (heldPartReply) throw new Error('Only one S3 part acknowledgement may be held');
      return new Promise(arrived => {
        let release = () => {};
        const ready = new Promise<void>(resolve => { release = resolve; });
        heldPartReply = { arrived, ready, release, entered: false };
      });
    },
    releasePartAcknowledgement,
    /** Hold a signed response after a real prefix is flushed; the caller can
     * witness its partial file before dropping the rest of the connection. */
    holdNextReadAfterPrefix(): Promise<{ key: string; prefix_bytes: number; total_bytes: number; replacement_credentials: boolean }> {
      if (heldRead) throw new Error('Only one S3 response body may be held');
      return new Promise(arrived => {
        let release = () => {};
        const ready = new Promise<void>(resolve => { release = resolve; });
        heldRead = { arrived, ready, release, entered: false };
      });
    },
    interruptHeldRead,
    async close() {
      interruptHeldRead(); releasePartAcknowledgement(); releaseObjectAcknowledgement(); server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
};
