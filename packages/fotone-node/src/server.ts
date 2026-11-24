import { createServer as createHttp1 } from 'node:http';
import { createServer as createHttp2, type ServerHttp2Session } from 'node:http2';
import { createServer as createTcpServer, type Socket } from 'node:net';
import { posix } from 'node:path';
import type { ServerConfig } from './config.ts';
import { getEncodings, selectAsset } from './files.ts';

import {
  createAssetSender,
  createHeaderResolver,
  extendVary,
  type Reply,
  type Request,
  type Response,
  respond,
} from './response.ts';

import { decodePath, encodePath, isPublicPath, isRedirectTarget, selectLanguagePath } from './routing.ts';
import { clientAddress, createAuthorize } from './security.ts';

const preface = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');
const allow = 'GET, HEAD, OPTIONS';
const plainText = { 'content-type': 'text/plain; charset=utf-8' };
const json = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

const timestamp = () => {
  const now = new Date();
  const offset = -now.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
  const local = new Date(now.getTime() + offset * 60_000).toISOString().slice(0, -1);
  const result = `${local}${sign}${hours}:${minutes}`;
  return result;
};

const splitRequestPath = (url: string) => {
  const separator = url.indexOf('?');
  const rawPath = separator === -1 ? url : url.slice(0, separator);
  const query = separator === -1 ? '' : url.slice(separator);
  const path = decodePath(rawPath);
  if (path === null || /[\p{Cc}#]/u.test(query)) return null;

  const result = { path, query };
  return result;
};

const withinMount = ({ path, basePath }: { path: string; basePath: string }) => {
  if (basePath === '/') return path;

  if (path === basePath) return '/';

  if (!path.startsWith(`${basePath}/`)) return null;

  const result = path.slice(basePath.length);
  return result;
};

const replyRedirect = ({ reply, target, status }: { reply: Reply; target: string; status: number }) => {
  respond({ reply, status, defaults: { location: target } });
};

const preflight = (reply: Reply) => {
  const { request } = reply;
  const requested = request.headers['access-control-request-method'];
  const requestedHeaders = request.headers['access-control-request-headers'];
  const defaults: Record<string, string> = { 'access-control-allow-methods': allow };

  if (typeof requestedHeaders === 'string') defaults['access-control-allow-headers'] = requestedHeaders;

  if (typeof requested === 'string' && !['GET', 'HEAD', 'OPTIONS'].includes(requested)) {
    respond({ reply, status: 405, defaults: { allow } });
    return;
  }

  respond({ reply, status: 204, defaults });
};

const createStaticHandler = (config: ServerConfig) => {
  const sendAsset = createAssetSender(config);

  const serve = async ({
    path,
    query,
    publicPath,
    reply,
  }: {
    path: string | null;
    query: string;
    publicPath: string;
    reply: Reply;
  }) => {
    const variants = getEncodings(reply.request.headers['accept-encoding']);
    const lookup = (candidate: string) => selectAsset({ directory: config.directory, path: candidate, variants });
    const route = path && isPublicPath(path) ? config.rewrite(publicPath) : null;
    const canonical = path && config.cleanUrls && path.endsWith('.html');

    if (canonical) {
      const asset = await lookup(path);

      if (asset) {
        replyRedirect({ reply, target: `${encodePath(publicPath.slice(0, -5))}${query}`, status: 301 });
        return;
      }
    }

    if (path && isPublicPath(path)) {
      const target = route ? decodePath(route.target) : path;
      let asset = target ? await lookup(target) : null;

      if (!asset && !route && target && config.extensionFallback && target !== '/' && !posix.extname(target)) {
        asset = await lookup(`${target}.html`);
      }

      if (!asset && !route) {
        asset = await lookup(`${path.replace(/\/$/, '')}/index.html`);
      }

      if (
        !asset &&
        !route &&
        config.spa &&
        !posix.extname(path) &&
        !config.spaExclusions.some((match) => match(publicPath))
      ) {
        asset = await lookup(config.spa);
      }

      if (asset === 406) {
        respond({ reply, status: 406, body: 'Not acceptable.', defaults: { ...plainText, vary: 'Accept-Encoding' } });
        return;
      }

      if (asset && (await sendAsset({ asset, reply }))) return;
    }

    const errorPage = await lookup('/404.html');
    if (errorPage && errorPage !== 406 && (await sendAsset({ asset: errorPage, reply, status: 404 }))) return;

    respond({ reply, status: 404, body: 'Not found.', defaults: plainText });
  };

  return serve;
};

export const createFotoneServer = (config: ServerConfig) => {
  const authorize = createAuthorize(config);
  const serveStatic = createStaticHandler(config);
  const resolveHeaders = createHeaderResolver(config);
  const quiet = !!config.values.quiet;
  const sockets = new Set<Socket>();
  const sessions = new Set<ServerHttp2Session>();
  const http2Sockets = new WeakSet<Socket>();
  const activeHttp1 = new Map<Socket, number>();
  let closing = false;
  let ready = false;

  const route = async (request: Request, response: Response) => {
    const parsed = splitRequestPath(request.url ?? '/');
    const headers = resolveHeaders(parsed ? parsed.path : '/');
    const reply = { request, response, headers };

    if (!parsed) {
      respond({ reply, status: 400, body: 'Bad request.', defaults: plainText });
      return;
    }

    if (request.method === 'OPTIONS' && config.values.cors) {
      preflight(reply);
      return;
    }

    const { query } = parsed;
    const path = config.stripTrailingSlash && parsed.path !== '/' ? parsed.path.replace(/\/$/, '') : parsed.path;

    if (config.auth && !(await authorize({ path, header: request.headers.authorization }))) {
      respond({ reply, status: 401, defaults: { 'www-authenticate': 'Basic realm="fotone"' } });
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const methods = config.values.cors ? allow : 'GET, HEAD';

      respond({ reply, status: 405, defaults: { allow: methods } });
      return;
    }

    if (path === '/health') {
      const result = ready ? { code: 'OK', message: 'Ready.' } : { code: 'UNAVAILABLE', message: 'Unavailable.' };

      respond({
        reply: { ...reply, headers: { ...headers, ...json } },
        status: ready ? 200 : 503,
        body: JSON.stringify(result),
      });

      return;
    }

    if (path === '/env' && config.envJson !== null) {
      respond({ reply: { ...reply, headers: { ...headers, ...json } }, status: 200, body: config.envJson });
      return;
    }

    const redirect = config.redirect(path);

    if (redirect && isRedirectTarget(redirect.target)) {
      replyRedirect({ reply, target: redirect.target, status: redirect.status ?? 302 });
      return;
    }

    if (path === '/' && config.languageRedirect) {
      const { default: fallback, languages } = config.languageRedirect;
      const header = request.headers['accept-language'];
      const target = selectLanguagePath({ header, languages, fallback });
      const vary = extendVary({ vary: headers.vary, name: 'Accept-Language' });

      replyRedirect({
        reply: { ...reply, headers: { ...headers, vary, 'cache-control': 'no-store' } },
        status: 302,
        target: `${target}${query}`,
      });

      return;
    }

    if (parsed.path !== path) {
      replyRedirect({ reply, target: `${encodePath(path)}${query}`, status: 301 });
      return;
    }

    await serveStatic({ path: withinMount({ path, basePath: config.basePath }), publicPath: path, query, reply });
  };

  const onRequest = async (request: Request, response: Response) => {
    const started = quiet ? 0 : performance.now();
    const isHttp1 = request.httpVersionMajor === 1;
    const peer = quiet ? undefined : request.socket.remoteAddress;
    const socket = isHttp1 ? (request.socket as Socket) : null;
    if (socket) activeHttp1.set(socket, (activeHttp1.get(socket) ?? 0) + 1);

    const finish = () => {
      response.off('finish', finish);
      response.off('close', finish);

      if (socket) {
        const count = (activeHttp1.get(socket) ?? 1) - 1;

        if (count > 0) activeHttp1.set(socket, count);
        else {
          activeHttp1.delete(socket);

          if (closing && !socket.destroyed) socket.end();
        }
      }

      if (!quiet) {
        const ip = clientAddress({ peer, forwarded: request.headers['x-forwarded-for'], trusted: config.trusted });
        const duration = (performance.now() - started).toFixed(1);
        const path = (request.url ?? '/').split('?')[0].replace(/\p{Cc}/gu, '');

        console.log(`${timestamp()} ${ip} ${request.method} ${path} ${response.statusCode} ${duration}ms`);
      }
    };

    response.once('finish', finish);
    response.once('close', finish);

    try {
      await route(request, response);
    } catch (error) {
      if (response.destroyed) return;

      if (!quiet) console.error(error);

      if (response.headersSent) response.destroy();
      else
        respond({
          reply: { request, response, headers: {} },
          status: 500,
          body: 'Internal server error.',
          defaults: plainText,
        });
    }
  };

  const http1 = createHttp1({ requireHostHeader: true }, onRequest);
  const http2 = createHttp2({}, onRequest);

  http1.setTimeout(config.timeout);
  http2.on('sessionError', () => {});

  http2.on('session', (session) => {
    sessions.add(session);

    if (config.timeout > 0) session.setTimeout(config.timeout, () => session.destroy());
    session.once('close', () => sessions.delete(session));
  });

  const listener = createTcpServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.once('error', () => socket.destroy());
    socket.setTimeout(config.timeout || 30_000);

    const onTimeout = () => socket.destroy();

    socket.once('timeout', onTimeout);

    const prefix = Buffer.alloc(preface.length);
    let length = 0;

    const sniff = () => {
      let byte: Buffer | null = socket.read(1);

      while (byte) {
        const matches = byte[0] === preface[length];

        prefix[length++] = byte[0];

        if (!matches || length === preface.length) {
          socket.off('readable', sniff);
          socket.off('timeout', onTimeout);
          socket.setTimeout(0);
          socket.unshift(prefix.subarray(0, length));

          if (matches) {
            http2Sockets.add(socket);
            http2.emit('connection', socket);
            socket.resume();
          } else {
            http1.emit('connection', socket);
          }

          return;
        }

        byte = socket.read(1);
      }
    };

    socket.on('readable', sniff);
  });

  const start = async () => {
    const started = Promise.withResolvers<void>();

    listener.once('error', started.reject);
    listener.listen(config.port, config.host, started.resolve);

    try {
      await started.promise;
    } finally {
      listener.off('error', started.reject);
    }

    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('No TCP listener address.');

    ready = true;
    return address;
  };

  const stop = async () => {
    if (closing) return;

    closing = true;
    ready = false;

    const closed = Promise.withResolvers<void>();

    listener.close(() => closed.resolve());

    for (const session of sessions) session.close();

    for (const socket of sockets) {
      if (!activeHttp1.has(socket) && !http2Sockets.has(socket)) socket.end();
    }

    const deadline = setTimeout(() => {
      for (const session of sessions) session.destroy();

      for (const socket of sockets) socket.destroy();
    }, 10_000);

    try {
      await closed.promise;
    } finally {
      clearTimeout(deadline);
    }
  };

  const result = { start, stop };
  return result;
};
