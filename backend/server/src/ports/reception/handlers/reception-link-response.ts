import type { ServerResponse } from 'node:http';

import { renderReceptionLinkUnavailableHtml } from './reception-page-render.js';

export const writeReceptionLinkHtmlResponse = (res: ServerResponse, body: string, status = 200): void => {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-length', String(Buffer.byteLength(body, 'utf8')));
  res.end(body);
};

export const writeReceptionLinkUnavailableResponse = (res: ServerResponse): void => {
  writeReceptionLinkHtmlResponse(res, renderReceptionLinkUnavailableHtml(), 410);
};
