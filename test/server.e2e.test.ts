import { once } from 'node:events';
import { mkdir, mkdtemp, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { Agent, request } from 'node:http';
import { connect } from 'node:http2';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { describe, expect, it, type TestContext } from 'vitest';
import { fotoneCli, host, startProcess } from './cliProcess.ts';

type FixtureInput = {
  files: Record<string, string | Buffer>;
  values?: Record<string, string | string[] | true>;
  onTestFinished: TestContext['onTestFinished'];
};

const startCli = ({ root, values, port }: { root: string; values: FixtureInput['values']; port: number }) => {
  const args = [root, '--host', host, '--port', String(port)];

  for (const [name, value] of Object.entries(values ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === true) args.push(`--${name}`);

      if (typeof item === 'string') args.push(`--${name}=${item}`);
    }
  }

  const result = startProcess({ executable: fotoneCli, args });
  return result;
};

const fixture = async ({ files, values, onTestFinished }: FixtureInput) => {
  const root = await mkdtemp(join(tmpdir(), 'fotone-test-'));

  const remove = async () => {
    await rm(root, { recursive: true, force: true });
  };

  let address: { address: string; port: number };
  let child: ReturnType<typeof startCli>;

  try {
    for (const [name, content] of Object.entries(files)) {
      const path = join(root, name);

      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }

    child = startCli({ root, values, port: 0 });

    try {
      address = { address: host, port: await child.waitUntilListening() };
    } catch (error) {
      await child.close();
      throw error;
    }
  } catch (error) {
    await remove();
    throw error;
  }

  const agent = new Agent({ keepAlive: true });

  const send = async (path: string, options: { method?: string; headers?: Record<string, string> } = {}) => {
    const complete = Promise.withResolvers<{
      status: number;
      headers: Record<string, string | string[] | undefined>;
      body: Buffer;
    }>();

    const outgoing = request(
      { host: address.address, port: address.port, path, agent, ...options },
      async (response) => {
        try {
          const buffers: Buffer[] = [];

          for await (const chunk of response) buffers.push(chunk);

          complete.resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(buffers),
          });
        } catch (error) {
          complete.reject(error);
        }
      },
    );

    outgoing.on('error', complete.reject);
    outgoing.end();

    const result = await complete.promise;
    return result;
  };

  const dispose = async () => {
    agent.destroy();

    try {
      await child.close();
    } finally {
      await remove();
    }
  };

  onTestFinished(dispose);

  const result = { send, root, address, stop: child.close, processOutput: child.output };
  return result;
};

describe('Fotone CLI', () => {
  describe('files', () => {
    it('serves directory index pages without SPA fallback', async ({ onTestFinished }) => {
      const test = await fixture({
        onTestFinished,
        files: {
          'index.html': 'home',
          'account/index.html': 'account',
          'guide.html': 'guide file',
          'guide/index.html': 'guide directory',
          'assets/file.txt': 'asset',
          '404.html': 'missing',
        },
      });

      expect((await test.send('/')).body.toString()).toEqual('home');
      expect((await test.send('/account')).body.toString()).toEqual('account');
      expect((await test.send('/account/')).headers.location).toEqual('/account');
      expect((await test.send('/guide')).body.toString()).toEqual('guide file');

      const missing = await test.send('/assets');
      expect(missing.status).toEqual(404);
      expect(missing.body.toString()).toEqual('missing');
    });

    it('serves directory index pages under a base path without stripping trailing slashes', async ({
      onTestFinished,
    }) => {
      const directory = await mkdtemp(join(tmpdir(), 'fotone-config-'));

      onTestFinished(async () => rm(directory, { recursive: true, force: true }));

      const config = join(directory, 'config.json');

      await writeFile(config, JSON.stringify({ basePath: '/site', stripTrailingSlash: false }));

      const test = await fixture({
        onTestFinished,
        files: { 'index.html': 'home', 'account/index.html': 'account' },
        values: { config },
      });

      expect((await test.send('/site')).body.toString()).toEqual('home');
      expect((await test.send('/site/')).body.toString()).toEqual('home');
      expect((await test.send('/site/account/')).body.toString()).toEqual('account');
      expect((await test.send('/account')).status).toEqual(404);
    });

    it('serves files, HEAD responses, and changes made to the root while running', async ({ onTestFinished }) => {
      const test = await fixture({ onTestFinished, files: { 'file.txt': 'initial' } });
      expect((await test.send('/')).status).toEqual(404);
      expect((await test.send('/file.txt')).body.toString()).toEqual('initial');

      const head = await test.send('/file.txt', { method: 'HEAD' });
      expect(head.headers['content-length']).toEqual('7');
      expect(head.body.length).toEqual(0);
      await writeFile(join(test.root, 'new.txt'), 'new');
      expect((await test.send('/new.txt')).body.toString()).toEqual('new');
      await rm(join(test.root, 'new.txt'));
      expect((await test.send('/new.txt')).status).toEqual(404);
    });

    it('negotiates encoding and uses weak representation-specific validators', async ({ onTestFinished }) => {
      const content = 'console.log("sample");';
      const br = brotliCompressSync(content);
      const gz = gzipSync(content);
      const test = await fixture({ onTestFinished, files: { 'app.js': content, 'app.js.br': br, 'app.js.gz': gz } });

      const result = await test.send('/app.js', { headers: { 'accept-encoding': 'gzip, br' } });
      expect(result.headers).toMatchObject({ 'content-encoding': 'br', vary: 'Accept-Encoding' });
      expect(result.body).toEqual(br);

      const identity = await test.send('/app.js', { headers: { 'accept-encoding': 'br;q=0, gzip;q=0' } });
      const tag = String(result.headers.etag);
      expect(tag).toMatch(/^W\//);
      expect(identity.headers.etag).not.toEqual(tag);

      const cached = await test.send('/app.js', { headers: { 'accept-encoding': 'br', 'if-none-match': tag } });
      expect(cached.status).toEqual(304);
      expect(cached.body.length).toEqual(0);

      const unacceptable = await test.send('/app.js', { headers: { 'accept-encoding': '*;q=0' } });
      expect(unacceptable.status).toEqual(406);
    });

    it('blocks hidden files, symlinks, and invalid paths', async ({ onTestFinished }) => {
      const test = await fixture({ onTestFinished, files: { '.private': 'private', 'public.txt': 'public' } });

      await symlink(join(test.root, '.private'), join(test.root, 'alias.txt'));

      for (const path of ['/.private', '/alias.txt']) expect((await test.send(path)).status).toEqual(404);
      expect((await test.send('/%2e%2e/private')).status).toEqual(400);
    });

    it('revalidates a cached file after a same-size edit with its mtime restored', async ({ onTestFinished }) => {
      const test = await fixture({ onTestFinished, files: { 'file.txt': 'old' } });

      const filename = join(test.root, 'file.txt');
      const modified = new Date('2024-01-01T00:00:00Z');

      await utimes(filename, modified, modified);

      const initial = await test.send('/file.txt');
      expect(initial.body.toString()).toEqual('old');

      await writeFile(filename, 'new');
      await utimes(filename, modified, modified);

      const updated = await test.send('/file.txt', { headers: { 'if-none-match': String(initial.headers.etag) } });
      expect(updated.status).toEqual(200);
      expect(updated.body.toString()).toEqual('new');
    });

    it('uses the configured validator for conditional HEAD requests', async ({ onTestFinished }) => {
      const test = await fixture({
        onTestFinished,
        files: { 'file.txt': 'contents' },
        values: { header: 'ETag: "release"' },
      });

      const response = await test.send('/file.txt', { method: 'HEAD', headers: { 'if-none-match': '"release"' } });
      expect(response).toMatchObject({ status: 304, headers: { etag: '"release"' }, body: Buffer.alloc(0) });
    });

    it('serves a replacement file when a client sends the old validator', async ({ onTestFinished }) => {
      const test = await fixture({ onTestFinished, files: { 'asset.txt': 'first', 'next.txt': 'replacement' } });
      const initial = await test.send('/asset.txt');

      await rename(join(test.root, 'next.txt'), join(test.root, 'asset.txt'));

      const updated = await test.send('/asset.txt', { headers: { 'if-none-match': String(initial.headers.etag) } });
      expect(updated).toMatchObject({ status: 200, body: Buffer.from('replacement') });
    });

    it('blocks a symlinked directory even when its file body was cached earlier', async ({ onTestFinished }) => {
      const test = await fixture({ onTestFinished, files: {} });

      const directory = join(test.root, 'assets');
      const moved = join(test.root, 'moved');

      await mkdir(directory);
      await writeFile(join(directory, 'file.txt'), 'asset');
      expect((await test.send('/assets/file.txt')).body.toString()).toEqual('asset');

      await rename(directory, moved);
      await symlink(moved, directory, 'dir');
      expect((await test.send('/assets/file.txt')).status).toEqual(404);
    });

    it('streams files above the body cache limit', async ({ onTestFinished }) => {
      const content = Buffer.alloc(2 * 1024 * 1024, 'stream');
      const test = await fixture({ onTestFinished, files: { 'asset.bin': content } });

      const response = await test.send('/asset.bin');
      expect(response.body).toEqual(content);
    });
  });

  describe('routing', () => {
    it('applies redirects, named rewrites, canonical URLs, and SPA fallback', async ({ onTestFinished }) => {
      const test = await fixture({
        onTestFinished,
        files: {
          'index.html': 'spa',
          'account/index.html': 'account',
          'hello.html': 'hello',
          'hello.txt': 'text',
          '404.html': 'missing',
        },
        values: { spa: 'index.html', rewrite: ['/api/:path*=/:path'], redirect: ['/docs/:item=/api/:item=308'] },
      });

      const moved = await test.send('/docs/hello.txt');
      expect(moved.status).toEqual(308);
      expect(moved.headers.location).toEqual('/api/hello.txt');
      expect((await test.send('/api/hello.txt')).body.toString()).toEqual('text');
      expect((await test.send('/hello')).body.toString()).toEqual('hello');
      expect((await test.send('/hello.html?from=old')).headers.location).toEqual('/hello?from=old');
      expect((await test.send('/hello/')).headers.location).toEqual('/hello');
      expect((await test.send('/account')).body.toString()).toEqual('account');
      expect((await test.send('/missing-route')).body.toString()).toEqual('spa');

      const missing = await test.send('/missing.js');
      expect(missing.status).toEqual(404);
      expect(missing.body.toString()).toEqual('missing');
    });

    it('applies flat JSON header rules and path-specific auth', async ({ onTestFinished }) => {
      const temp = await mkdtemp(join(tmpdir(), 'fotone-config-'));

      onTestFinished(async () => rm(temp, { recursive: true, force: true }));

      const configFile = join(temp, 'config.json');

      await writeFile(
        configFile,
        JSON.stringify({
          headers: [
            { paths: ['/open.txt', '/open.*'], 'Cross-Origin-Embedder-Policy': 'credentialless', 'X-Remove': null },
          ],
        }),
      );

      const test = await fixture({
        onTestFinished,
        files: { 'open.txt': 'hello', 'protected.txt': 'private' },
        values: {
          config: configFile,
          coep: true,
          coop: true,
          auth: 'alice:password',
          'auth-include': ['/*.txt'],
          'auth-exclude': ['/open.txt'],
          header: ['X-Remove: yes'],
        },
      });

      const denied = await test.send('/protected.txt');
      expect(denied.status).toEqual(401);
      expect(denied.headers['www-authenticate']).toEqual('Basic realm="fotone"');

      expect(
        (await test.send('/protected.txt', { headers: { authorization: 'Basic YWxpY2U6cGFzc3dvcmQ=' } })).status,
      ).toEqual(200);

      const open = await test.send('/open.txt?x=1');
      expect(open.headers).toMatchObject({
        'cross-origin-embedder-policy': 'credentialless',
        'cross-origin-opener-policy': 'same-origin',
      });

      expect(open.headers).not.toHaveProperty('x-remove');
    });

    it('serves only allowlisted environment values through the virtual route', async ({ onTestFinished }) => {
      const test = await fixture({ onTestFinished, files: {}, values: { 'env-json': 'PATH' } });

      const response = await test.send('/env');
      expect(response.headers).toMatchObject({
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
      });

      expect(JSON.parse(response.body.toString())).toEqual({ PATH: process.env.PATH });
      expect((await test.send('/env.json')).status).toEqual(404);
    });

    it('redirects the root to a preferred language and preserves the query string', async ({ onTestFinished }) => {
      const directory = await mkdtemp(join(tmpdir(), 'fotone-language-config-'));

      onTestFinished(async () => rm(directory, { recursive: true, force: true }));

      const config = join(directory, 'config.json');

      await writeFile(
        config,
        JSON.stringify({
          languageRedirect: { default: '/en', en: '/en', it: '/it/benvenuto', 'it-ch': '/it-ch' },
          headers: [{ paths: ['/'], Vary: 'Origin', 'Cache-Control': 'public, max-age=60' }],
        }),
      );

      const test = await fixture({
        onTestFinished,
        files: { 'it/benvenuto/index.html': 'Italian' },
        values: { config },
      });

      const preferred = await test.send('/?ref=a%20b', {
        headers: { 'accept-language': 'en;q=0.2, IT-IT;q=0.8, it-CH;q=0.5' },
      });

      expect(preferred).toMatchObject({
        status: 302,
        headers: { location: '/it/benvenuto?ref=a%20b', vary: 'Origin, Accept-Language', 'cache-control': 'no-store' },
      });

      expect(
        (await test.send('/', { method: 'HEAD', headers: { 'accept-language': 'it-CH, en' } })).headers.location,
      ).toEqual('/it-ch');

      expect(
        (await test.send('/', { headers: { 'accept-language': 'it;q=0, fr, it-CH;q=invalid, *' } })).headers.location,
      ).toEqual('/en');

      expect((await test.send('/')).headers.location).toEqual('/en');

      expect((await test.send('/it/benvenuto', { headers: { 'accept-language': 'en' } })).body.toString()).toEqual(
        'Italian',
      );
    });

    it('uses the CLI language list under the configured base path', async ({ onTestFinished }) => {
      const directory = await mkdtemp(join(tmpdir(), 'fotone-language-config-'));

      onTestFinished(async () => rm(directory, { recursive: true, force: true }));

      const config = join(directory, 'config.json');

      await writeFile(
        config,
        JSON.stringify({
          basePath: '/site',
          languageRedirect: { default: '/site/welcome', it: '/site/benvenuto', fr: '/site/bienvenue' },
        }),
      );

      const test = await fixture({
        onTestFinished,
        files: { 'it/index.html': 'Italian', 'assets/app.js': 'asset' },
        values: { config, langs: ' FR , IT ' },
      });

      expect((await test.send('/', { headers: { 'accept-language': 'it-IT' } })).headers.location).toEqual('/site/it');
      expect((await test.send('/', { headers: { 'accept-language': 'de' } })).headers.location).toEqual('/site/fr');
      expect((await test.send('/')).headers.location).toEqual('/site/fr');

      const headers = { 'accept-language': 'fr' };
      expect((await test.send('/site/it', { headers })).body.toString()).toEqual('Italian');
      expect((await test.send('/site/assets/app.js', { headers })).body.toString()).toEqual('asset');
    });

    it.for(['', 'en,,it', 'en,/it'])('rejects invalid CLI language list %j', async (langs, { onTestFinished }) => {
      await expect(fixture({ onTestFinished, files: {}, values: { langs } })).rejects.toThrow();
    });

    it.for([
      { name: 'missing default', languageRedirect: { it: '/it' } },
      { name: 'nested language map', languageRedirect: { default: '/en', languages: { it: '/it' } } },
    ])('rejects language redirect config with $name', async ({ languageRedirect }, { onTestFinished }) => {
      const directory = await mkdtemp(join(tmpdir(), 'fotone-language-config-'));

      onTestFinished(async () => rm(directory, { recursive: true, force: true }));

      const config = join(directory, 'config.json');

      await writeFile(config, JSON.stringify({ languageRedirect }));

      await expect(fixture({ onTestFinished, files: {}, values: { config } })).rejects.toThrow();
    });

    it('gives explicit root redirects priority over language redirects', async ({ onTestFinished }) => {
      const directory = await mkdtemp(join(tmpdir(), 'fotone-language-config-'));

      onTestFinished(async () => rm(directory, { recursive: true, force: true }));

      const config = join(directory, 'config.json');

      await writeFile(config, JSON.stringify({ languageRedirect: { default: '/en', it: '/it' } }));

      const test = await fixture({ onTestFinished, files: {}, values: { config, redirect: '/=/welcome=308' } });
      const response = await test.send('/', { headers: { 'accept-language': 'it' } });
      expect(response).toMatchObject({ status: 308, headers: { location: '/welcome' } });
    });

    it('accepts an Apache bcrypt record and keeps authenticated assets private in caches', async ({
      onTestFinished,
    }) => {
      const record = 'myName:$2y$05$t76D11lwJVgzC2A3IK5PRO32KX5JiJDmnnvtIrSxpvzXr9c4zjlwe';

      const test = await fixture({
        onTestFinished,
        files: { 'file.txt': 'private' },
        values: { auth: record, maxage: '31536000' },
      });

      const credentials = Buffer.from('myName:myPassword').toString('base64');
      const response = await test.send('/file.txt', { headers: { authorization: `Basic ${credentials}` } });
      expect(response.status).toEqual(200);
      expect(response.headers['cache-control']).toEqual('private, max-age=31536000');
    });

    it('resolves trusted proxy chains and ignores malformed headers', async ({ onTestFinished }) => {
      const temp = await mkdtemp(join(tmpdir(), 'fotone-proxy-config-'));

      onTestFinished(async () => rm(temp, { recursive: true, force: true }));

      const configFile = join(temp, 'config.json');

      await writeFile(configFile, '{"trustedProxies":["127.0.0.1","10.0.0.0/8"]}');

      const test = await fixture({ onTestFinished, files: {}, values: { config: configFile } });
      await test.send('/trusted', { headers: { 'x-forwarded-for': '192.0.2.8, 203.0.113.42, 10.0.0.1' } });
      await test.send('/malformed', { headers: { 'x-forwarded-for': 'invalid, 10.0.0.1' } });

      await expect.poll(test.processOutput).toMatch(/203\.0\.113\.42.*\/trusted/);
      await expect.poll(test.processOutput).toMatch(/127\.0\.0\.1.*\/malformed/);
    });

    it('ignores forwarded addresses from untrusted peers', async ({ onTestFinished }) => {
      const test = await fixture({ onTestFinished, files: {} });
      await test.send('/untrusted', { headers: { 'x-forwarded-for': '192.0.2.8' } });

      await expect.poll(test.processOutput).toMatch(/127\.0\.0\.1.*\/untrusted/);
    });
  });

  describe('protocols', () => {
    it('fails to listen when its fixed port is occupied', async ({ onTestFinished }) => {
      const test = await fixture({ onTestFinished, files: {} });

      const child = startCli({ root: test.root, values: {}, port: test.address.port });

      try {
        await expect(child.waitUntilListening()).rejects.toThrow();
      } finally {
        await child.close();
      }
    });

    it('serves HTTP/1.1 and h2c from the same TCP port', async ({ onTestFinished }) => {
      const test = await fixture({ onTestFinished, files: { 'file.txt': 'hello' } });

      const socket = createConnection({ host: test.address.address, port: test.address.port });
      const origin = `http://${test.address.address}:${test.address.port}`;
      const session = connect(origin, { createConnection: () => socket });

      onTestFinished(() => session.destroy());

      const stream = session.request({ ':path': '/file.txt' });
      const chunks: Buffer[] = [];

      for await (const chunk of stream) chunks.push(chunk);

      expect(Buffer.concat(chunks).toString()).toEqual('hello');
      expect((await test.send('/file.txt')).body.toString()).toEqual('hello');

      const closed = once(session, 'close');

      await test.stop();
      await closed;
    });

    it('detects a fragmented HTTP/2 connection preface', async ({ onTestFinished }) => {
      const test = await fixture({ onTestFinished, files: { 'file.txt': 'hello' } });

      const bridge = createServer((inbound) => {
        const outbound = createConnection({ host: test.address.address, port: test.address.port });

        inbound.once('close', () => outbound.destroy());
        outbound.once('close', () => inbound.destroy());
        inbound.once('error', () => outbound.destroy());
        outbound.once('error', () => inbound.destroy());

        inbound.once('data', async (chunk) => {
          if (typeof chunk === 'string') throw new Error('Expected binary data from TCP connection.');

          inbound.pause();
          outbound.write(chunk.subarray(0, 5));
          await delay(15);
          outbound.write(chunk.subarray(5));
          inbound.pipe(outbound);
          outbound.pipe(inbound);
        });
      });

      bridge.listen(0, '127.0.0.1');
      await once(bridge, 'listening');

      const address = bridge.address();
      expect(address && typeof address === 'object').toEqual(true);

      if (!address || typeof address === 'string') throw new Error('No bridge address.');

      const session = connect(`http://127.0.0.1:${address.port}`);

      onTestFinished(() => {
        session.destroy();
        bridge.close();
      });

      const stream = session.request({ ':path': '/file.txt' }, { endStream: true });
      const chunks: Buffer[] = [];

      for await (const chunk of stream) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toEqual('hello');
    });
  });
});
