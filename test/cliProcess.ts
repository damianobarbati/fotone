import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const host = '127.0.0.1';
export const nodeCli = fileURLToPath(new URL('../packages/fotone-node/dist/index.js', import.meta.url));
export const rustCli = fileURLToPath(new URL('../packages/fotone-rust/target/release/fotone-rust', import.meta.url));

export const unusedPort = async () => {
  const listener = createServer();

  listener.listen(0, host);
  await once(listener, 'listening');

  const address = listener.address();
  const closed = once(listener, 'close');

  listener.close();
  await closed;

  if (!address || typeof address === 'string') throw new Error('Could not reserve a benchmark port.');
  return address.port;
};

const connect = async (port: number) => {
  const socket = createConnection({ host, port, timeout: 250 });

  try {
    await once(socket, 'connect', { signal: AbortSignal.timeout(250) });
    return true;
  } catch {
    return false;
  } finally {
    socket.destroy();
  }
};

export const startProcess = ({ executable, args }: { executable: string; args: string[] }) => {
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = Promise.withResolvers<number | null>();
  let error: Error | undefined;
  let stdout = '';
  let stderr = '';

  child.stdout.setEncoding('utf8').on('data', (text: string) => {
    stdout = (stdout + text).slice(-8192);
  });

  child.stderr.setEncoding('utf8').on('data', (text: string) => {
    stderr = (stderr + text).slice(-8192);
  });

  child.once('error', (failure) => {
    error = failure;
    exited.resolve(null);
  });

  child.once('exit', (code, signal) => {
    error = new Error(`Server exited with ${signal ?? code}.`);
    exited.resolve(code);
  });

  const waitUntilListening = async (port?: number) => {
    const deadline = performance.now() + 5_000;

    while (performance.now() < deadline && !error) {
      if (port && (await connect(port))) return port;

      if (!port) {
        const match = /Listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
        if (match) return Number(match[1]);
      }

      await delay(10);
    }

    throw new Error(stderr.trim() || 'Server failed to start before the deadline.', { cause: error });
  };

  const close = async () => {
    const deadline = setTimeout(() => child.kill('SIGKILL'), 2_000);

    try {
      if (!error) child.kill('SIGTERM');

      const result = await exited.promise;
      return result;
    } finally {
      clearTimeout(deadline);
    }
  };

  const output = () => stdout;
  const result = { pid: child.pid, waitUntilListening, close, output };
  return result;
};
