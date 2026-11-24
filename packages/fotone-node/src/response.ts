import type { FileHandle } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2';
import { pipeline } from 'node:stream/promises';
import type { ResponseHeaders, ServerConfig } from './config.ts';
import { type Asset, matchesAsset, mimeType, openAsset } from './files.ts';

export type Request = IncomingMessage | Http2ServerRequest;
export type Response = ServerResponse | Http2ServerResponse;
export type Reply = { request: Request; response: Response; headers: ResponseHeaders };

export const extendVary = ({ vary, name }: { vary: string | null | undefined; name: string }) => {
  if (!vary) return name;

  const exists = vary.split(',').some((value) => ['*', name.toLowerCase()].includes(value.trim().toLowerCase()));
  const result = exists ? vary : `${vary}, ${name}`;
  return result;
};

export const createHeaderResolver = (config: ServerConfig) => {
  const defaults: ResponseHeaders = Object.create(null);
  const { values } = config;
  if (values.cors) defaults['access-control-allow-origin'] = '*';

  if (values.coop || values.coep) defaults['cross-origin-opener-policy'] = 'same-origin';

  if (values.coep) defaults['cross-origin-embedder-policy'] = 'require-corp';

  if (values.pna) defaults['access-control-allow-private-network'] = 'true';

  for (const [name, value] of config.globalHeaders) defaults[name] = value;

  const resolveHeaders = (path: string) => {
    let result = defaults;

    for (const rule of config.headerRules) {
      if (rule.match.some((match) => match(path))) {
        if (result === defaults) result = Object.assign(Object.create(null), defaults);

        for (const [name, value] of rule.headers) result[name] = value;
      }
    }

    return result;
  };

  return resolveHeaders;
};

export const respond = ({
  reply,
  status,
  body,
  defaults = {},
}: {
  reply: Reply;
  status: number;
  body?: string;
  defaults?: ResponseHeaders;
}) => {
  const { request, response, headers } = reply;

  response.statusCode = status;

  for (const [name, value] of Object.entries({ ...defaults, ...headers })) {
    if (value !== null) response.setHeader(name, value);
  }

  if (body !== undefined) response.setHeader('content-length', Buffer.byteLength(body));

  if (request.method === 'HEAD' || body === undefined) response.end();
  else response.end(body);
};

const isFresh = ({ request, headers }: { request: Request; headers: ResponseHeaders }) => {
  const { 'if-none-match': candidate, 'if-modified-since': since } = request.headers;
  const { etag, 'last-modified': modified } = headers;

  if (candidate !== undefined) {
    const value = Array.isArray(candidate) ? candidate.join(',') : candidate;
    if (value.trim() === '*') return true;

    if (!etag) return false;

    const current = etag.replace(/^W\//, '');
    const tags = value.match(/(?:W\/)?"[^"]*"/g);
    const result = !!tags && tags.some((tag) => tag.replace(/^W\//, '') === current);
    return result;
  }

  const result = typeof since === 'string' && !!modified && Date.parse(modified) <= Date.parse(since);
  return result;
};

const fileBufferLimit = 1024 * 1024;
const bufferBudget = 16 * fileBufferLimit;
const bodyCacheEntries = 256;
const streamBufferSize = 64 * 1024;

const readAsset = async ({ handle, size }: { handle: FileHandle; size: number }) => {
  const body = Buffer.allocUnsafe(size);
  let offset = 0;

  while (offset < size) {
    const { bytesRead } = await handle.read(body, offset, size - offset, offset);
    if (!bytesRead) return null;

    offset += bytesRead;
  }

  return body;
};

type SendAssetInput = { asset: Asset; reply: Reply; status?: number };

export const createAssetSender = (config: ServerConfig) => {
  const visibility = config.auth ? 'private' : 'public';
  const cache = config.maxage === undefined ? 'no-cache' : `${visibility}, max-age=${config.maxage}`;
  const cacheControl = config.values.immutable ? `${cache}, immutable` : cache;
  const bodies = new Map<string, Buffer>();
  let cachedBytes = 0;
  let bufferedBytes = 0;

  const getBody = async ({ asset, size }: { asset: Asset; size: number }) => {
    const { metadata } = asset;
    const key = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
    const cached = bodies.get(key);
    if (cached) return cached;

    const handle = await openAsset(asset);
    if (!handle) return null;

    try {
      const body = await readAsset({ handle, size });
      if (!body) return null;

      const current = await handle.stat({ bigint: true });
      if (!matchesAsset({ current, expected: metadata })) return null;

      if (!bodies.has(key)) {
        while (bodies.size >= bodyCacheEntries || cachedBytes + size > bufferBudget) {
          const oldest = bodies.keys().next();
          if (oldest.done) break;

          const removed = bodies.get(oldest.value);
          if (removed) cachedBytes -= removed.length;

          bodies.delete(oldest.value);
        }

        bodies.set(key, body);
        cachedBytes += size;
      }

      return body;
    } finally {
      await handle.close();
    }
  };

  const sendBuffered = async ({
    asset,
    size,
    response,
    writeHeaders,
  }: {
    asset: Asset;
    size: number;
    response: Response;
    writeHeaders: () => void;
  }) => {
    bufferedBytes += size;

    let flushed = false;
    let reserved = true;

    const release = () => {
      if (!reserved) return;

      reserved = false;
      response.off('finish', release);
      response.off('close', release);
      bufferedBytes -= size;
    };

    try {
      const body = await getBody({ asset, size });
      if (body === null) return false;

      if (response.destroyed) return true;

      writeHeaders();
      response.once('finish', release);
      response.once('close', release);
      response.end(body);
      flushed = true;
      return true;
    } finally {
      if (!flushed) release();
    }
  };

  const send = async ({ asset, reply, status = 200 }: SendAssetInput) => {
    const { request, response } = reply;
    const { metadata, encoding, path } = asset;
    const size = Number(metadata.size);

    const headers: ResponseHeaders = {
      'cache-control': cacheControl,
      'last-modified': metadata.mtime.toUTCString(),
      etag: `W/"${metadata.size.toString(16)}-${metadata.mtimeNs.toString(16)}-${metadata.ctimeNs.toString(16)}-${encoding}"`,
      ...reply.headers,
    };

    headers.vary = extendVary({ vary: headers.vary, name: 'Accept-Encoding' });

    if (status === 200 && isFresh({ request, headers })) {
      delete headers['content-type'];
      respond({ reply: { ...reply, headers }, status: 304 });
      return true;
    }

    const writeHeaders = () => {
      response.statusCode = status;

      if (!Object.hasOwn(headers, 'content-type')) headers['content-type'] = mimeType(path);

      for (const [name, value] of Object.entries(headers)) {
        if (value !== null) response.setHeader(name, value);
      }

      response.setHeader('content-length', size);

      if (encoding !== 'identity') response.setHeader('content-encoding', encoding);
    };

    if (request.method === 'HEAD') {
      writeHeaders();
      response.end();
      return true;
    }

    if (size <= fileBufferLimit && bufferedBytes + size <= bufferBudget) {
      const result = await sendBuffered({ asset, size, response, writeHeaders });
      return result;
    }

    const handle = await openAsset(asset);
    if (!handle) return false;

    try {
      writeHeaders();

      await pipeline(
        handle.createReadStream({ autoClose: false, end: size - 1, highWaterMark: streamBufferSize }),
        response,
      );

      return true;
    } finally {
      await handle.close();
    }
  };

  return send;
};
