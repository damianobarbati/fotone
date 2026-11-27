import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname } from 'node:path';
import type { ServerType } from '@hono/node-server';

const host = '127.0.0.1';
const identity = 'identity';
const [serverName, root, portArgument] = process.argv.slice(1);
const port = Number(portArgument);

const createFastifyServer = async () => {
  const { default: fastify } = await import('fastify');
  const { default: fastifyStatic } = await import('@fastify/static');

  const app = fastify({ logger: false, keepAliveTimeout: 5000, connectionTimeout: 30_000 });
  await app.register(fastifyStatic, { root, index: false, preCompressed: true, etag: true });
  await app.listen({ host, port });

  const result = { close: () => app.close() };
  return result;
};

const startHttpServer = async (server: ServerType) => {
  const listening = once(server, 'listening');

  server.setTimeout(30_000);
  server.listen(port, host);
  await listening;

  const close = async () => {
    const closed = once(server, 'close');

    server.close();
    await closed;
  };

  const result = { close };
  return result;
};

const createHonoServer = async () => {
  const { createAdaptorServer } = await import('@hono/node-server');
  const { serveStatic } = await import('@hono/node-server/serve-static');
  const { Hono } = await import('hono');

  const app = new Hono();

  app.use(async (context, next) => {
    await next();

    const response = context.res;
    const modified = response.headers.get('last-modified');
    const size = response.headers.get('content-length');
    if (!modified || size === null || response.status !== 200) return;

    const encoding = response.headers.get('content-encoding') ?? identity;
    const tag = `W/"${size}-${Date.parse(modified)}-${encoding}"`;

    context.header('ETag', tag);
    context.header('Vary', 'Accept-Encoding');
    context.header('Cache-Control', 'no-cache');

    if (tag !== context.req.header('If-None-Match')) return;

    if (response.body) await response.body.cancel();

    const headers = new Headers(response.headers);

    context.res = new Response(null, { status: 304, headers });
    context.res.headers.delete('content-length');
    context.res.headers.delete('content-type');
    context.res.headers.delete('content-encoding');
  });

  app.use(serveStatic({ root, precompressed: true }));

  const server = createAdaptorServer({ fetch: app.fetch, serverOptions: { keepAliveTimeout: 5000 } });
  const result = await startHttpServer(server);
  return result;
};

type ExpressRequest = IncomingMessage & { acceptsEncodings: (...encodings: string[]) => string | false };
type ExpressResponse = ServerResponse & { type: (extension: string) => void };

const createExpressServer = async () => {
  const { default: express } = await import('express');

  const app = express();
  app.disable('x-powered-by');

  const serve = express.static(root, {
    index: false,
    redirect: false,
    setHeaders: (response: ExpressResponse, filename: string) => {
      response.setHeader('Vary', 'Accept-Encoding');

      if (filename.endsWith('.br')) {
        response.setHeader('Content-Encoding', 'br');
        response.type(extname(filename.slice(0, -3)));
      }
    },
  });

  app.use((incoming: ExpressRequest, outgoing: ExpressResponse, next: (error?: unknown) => void) => {
    const url = incoming.url;

    if (!url || incoming.acceptsEncodings('br', identity) !== 'br') {
      next();
      return;
    }

    const query = url.indexOf('?');

    incoming.url = query < 0 ? `${url}.br` : `${url.slice(0, query)}.br${url.slice(query)}`;

    serve(incoming, outgoing, (error?: unknown) => {
      incoming.url = url;
      next(error);
    });
  });

  app.use(serve);

  const server = createServer({ keepAliveTimeout: 5000 }, app);
  const result = await startHttpServer(server);
  return result;
};

const servers: Record<string, () => Promise<{ close: () => Promise<void> }>> = {
  fastify: createFastifyServer,
  hono: createHonoServer,
  express: createExpressServer,
};

const start = servers[serverName];
const server = await start();

const stop = async () => {
  await server.close();
};

process.once('SIGTERM', stop);
process.once('SIGINT', stop);
