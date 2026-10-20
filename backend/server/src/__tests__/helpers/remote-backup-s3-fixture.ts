/** Owned loopback S3 protocol fixture. Verifies actual SigV4 requests and body
 * digests; stores only the ciphertext the caller sends. No production bucket. */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const digest = (body: string | Buffer): string => createHash('sha256').update(body).digest('hex');
const encode = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/gu, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const mac = (key: string | Buffer, message: string): Buffer => createHmac('sha256', key).update(message).digest();
export const REMOTE_FIXTURE_ACCESS = 'synthetic-remote-access';
export const REMOTE_FIXTURE_SECRET = 'synthetic-remote-secret';
export const createRemoteBackupS3Fixture = async () => {
  const objects = new Map<string, { bytes: Buffer; etag: string }>();
  const uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  const calls: { method: string; key: string; bytes: number }[] = [];
  const faults = { losePutReply: false, loseCompleteReply: false, corruptRead: false, completeError: false, denyDelete: false };
  let beforeDelete: ((key: string) => void) | undefined;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks), url = new URL(req.url ?? '/', 'http://fixture.invalid');
      const key = decodeURIComponent(url.pathname.replace(/^\/backup-bucket\/?/u, ''));
      const method = req.method ?? 'GET'; calls.push({ method, key, bytes: body.length });
      const auth = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/u.exec(req.headers.authorization ?? '');
      let valid = false;
      if (auth && auth[1] === REMOTE_FIXTURE_ACCESS && req.headers['x-amz-content-sha256'] === digest(body)) {
        const signed = auth[4]!, scope = `${auth[2]}/${auth[3]}/s3/aws4_request`;
        const headers = signed.split(';').map(name => `${name}:${String(req.headers[name] ?? '').trim()}\n`).join('');
        const query = [...url.searchParams].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${encode(k)}=${encode(v)}`).join('&');
        const canonical = [method, url.pathname, query, headers, signed, digest(body)].join('\n');
        const signingKey = mac(mac(mac(mac(`AWS4${REMOTE_FIXTURE_SECRET}`, auth[2]!), auth[3]!), 's3'), 'aws4_request');
        const signature = mac(signingKey, ['AWS4-HMAC-SHA256', String(req.headers['x-amz-date']), scope, digest(canonical)].join('\n')).toString('hex');
        valid = signature === auth[5];
      }
      if (!valid) { res.writeHead(403); res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>'); return; }
      if (method === 'HEAD' && key === '') { res.writeHead(200); res.end(); return; }
      if (method === 'POST' && url.searchParams.has('uploads')) {
        const id = randomUUID(); uploads.set(id, { key, parts: new Map() });
        res.writeHead(200, { 'content-type': 'application/xml' }); res.end(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`); return;
      }
      const uploadId = url.searchParams.get('uploadId');
      if (uploadId) {
        const upload = uploads.get(uploadId);
        if (!upload || upload.key !== key) { res.writeHead(404); res.end('<Error><Code>NoSuchUpload</Code></Error>'); return; }
        if (method === 'DELETE') { uploads.delete(uploadId); res.writeHead(204); res.end(); return; }
        if (method === 'PUT') {
          upload.parts.set(Number(url.searchParams.get('partNumber')), body);
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
          if (faults.loseCompleteReply) { faults.loseCompleteReply = false; req.socket.destroy(); return; }
          res.writeHead(200); res.end(`<CompleteMultipartUploadResult><ETag>${etag}</ETag></CompleteMultipartUploadResult>`); return;
        }
      }
      if (method === 'PUT') {
        if (req.headers['if-none-match'] !== '*' || objects.has(key)) { res.writeHead(412); res.end(); return; }
        const etag = `"${digest(body)}"`; objects.set(key, { bytes: body, etag });
        if (faults.losePutReply) { faults.losePutReply = false; req.socket.destroy(); return; }
        res.writeHead(200, { etag }); res.end(); return;
      }
      if (method === 'DELETE') beforeDelete?.(key);
      const object = objects.get(key);
      if (!object) { res.writeHead(404); res.end(); return; }
      if (req.headers['if-match'] && req.headers['if-match'] !== object.etag) { res.writeHead(412); res.end(); return; }
      if (method === 'GET' || method === 'HEAD') {
        const bytes = Buffer.from(object.bytes); if (faults.corruptRead) bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
        res.writeHead(200, { etag: object.etag, 'content-type': 'application/octet-stream', 'content-length': bytes.length }); res.end(method === 'HEAD' ? undefined : bytes); return;
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
    endpoint: `http://127.0.0.1:${address.port}`, objects, uploads, calls, faults,
    beforeDelete(callback: (key: string) => void) { beforeDelete = callback; },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
};
