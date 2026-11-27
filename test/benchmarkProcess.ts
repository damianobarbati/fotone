import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { promisify } from 'node:util';
import { fotoneCli, host, startProcess } from './cliProcess.ts';

const run = promisify(execFile);

let ticksPerSecond: number | undefined;

export const readCpuSeconds = async (pid: number) => {
  if (process.platform === 'linux') {
    if (ticksPerSecond === undefined) {
      const { stdout } = await run('getconf', ['CLK_TCK']);

      ticksPerSecond = Number(stdout.trim());

      if (!(ticksPerSecond > 0)) throw new Error('Invalid CPU clock frequency.');
    }

    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    // Fields after the process name start at field 3. utime and stime are fields 14 and 15.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const seconds = (Number(fields[11]) + Number(fields[12])) / ticksPerSecond;
    return seconds;
  }

  const { stdout } = await run('ps', ['-o', 'time=', '-p', String(pid)]);
  const time = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(stdout.trim());
  if (!time) throw new Error(`Could not read CPU time for PID ${pid}.`);

  const seconds = Number(time[1] ?? 0) * 86400 + Number(time[2] ?? 0) * 3600 + Number(time[3]) * 60 + Number(time[4]);
  return seconds;
};

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
    const result = startProcess({ executable: fotoneCli, args: options });
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
