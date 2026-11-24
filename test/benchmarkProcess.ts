import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { promisify } from 'node:util';
import { host, nodeCli, rustCli, startProcess } from './cliProcess.ts';

const run = promisify(execFile);

export const readRss = async (pid: number) => {
  if (process.platform === 'linux') {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+) kB$/m.exec(status);
    if (!match) throw new Error(`Could not read RSS for PID ${pid}.`);

    const result = Number(match[1]) * 1024;
    return result;
  }

  const { stdout } = await run('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 1_000 });
  const result = Number(stdout.trim()) * 1024;
  if (!Number.isFinite(result) || result <= 0) throw new Error(`Could not read RSS for PID ${pid}.`);
  return result;
};

export const startSampling = async ({ pid }: { pid: number }) => {
  let peak = await readRss(pid);
  let pending: Promise<void> | undefined;
  let failure: unknown;

  const sample = async () => {
    try {
      peak = Math.max(peak, await readRss(pid));
    } catch (error) {
      failure = error;
    } finally {
      pending = undefined;
    }
  };

  const timer = setInterval(() => {
    if (!pending && !failure) pending = sample();
  }, 25);

  const stop = async () => {
    clearInterval(timer);
    await pending;
  };

  const finish = async () => {
    await stop();

    if (failure) throw failure;

    const result = Math.max(peak, await readRss(pid));
    return result;
  };

  const result = { finish, stop };
  return result;
};

type LaunchBenchmarkServerOptions = { serverName: string; root: string; port: number };

export const launchBenchmarkServer = async ({ serverName, root, port }: LaunchBenchmarkServerOptions) => {
  const options = [root, '--host', host, '--port', String(port), '--quiet'];

  if (serverName === 'fotone') {
    const result = startProcess({ executable: process.execPath, args: [nodeCli, ...options] });
    return result;
  }

  if (serverName === 'fotone-rust') {
    const result = startProcess({ executable: rustCli, args: options });
    return result;
  }

  const source = await readFile(new URL('./benchmarkServer.ts', import.meta.url), 'utf8');
  const js = stripTypeScriptTypes(source);

  const result = startProcess({
    executable: process.execPath,
    args: ['--input-type=module', '--eval', js, serverName, root, String(port)],
  });

  return result;
};

export const toMiB = (bytes: number) => {
  const result = Number((bytes / 1024 ** 2).toFixed(1));
  return result;
};
