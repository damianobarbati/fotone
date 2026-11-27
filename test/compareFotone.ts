// node test/compareFotone.ts <baseline release binary> <candidate release binary> [workload ...]
import { Buffer } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { fastifyLoad, runRound, summarizeRound } from './benchmarkLoad.ts';
import { readCpuSeconds, readRss, startSampling, toMiB } from './benchmarkProcess.ts';
import { host, startProcess, unusedPort } from './cliProcess.ts';

const binaries = process.argv.slice(2, 4);
if (binaries.length !== 2) throw new Error('Supply baseline and candidate release binary paths.');

const small = Buffer.alloc(4096, 'static ');
const large = Buffer.alloc(1024 ** 2, 'static ');
const rotating = Array.from({ length: 32 }, (_, index) => ({ path: `/${index}.bin` }));
const cases = ['small', 'large', 'brotli', 'revalidation', 'rotating', 'cold'] as const;
type Workload = (typeof cases)[number];
type Mode = 'fixed' | 'saturation' | 'burst';

const coldBurst = async ({ base, signal }: { base: string; signal: AbortSignal }) => {
  const latencies: number[] = [];
  const start = performance.now();

  for (const file of rotating) {
    await Promise.all(
      Array.from({ length: 32 }, async () => {
        const sent = performance.now();
        const response = await fetch(base + file.path, { headers: { 'accept-encoding': 'identity' }, signal });

        if (response.status !== 200 || (await response.bytes()).length !== large.length)
          throw new Error('Invalid burst response.');

        latencies.push(performance.now() - sent);
      }),
    );
  }

  const count = latencies.length;
  const requestsPerSecond = (count * 1000) / (performance.now() - start);
  const p95Ms = latencies.sort((a, b) => a - b)[Math.ceil(count * 0.95) - 1];
  const result = { count, requestsPerSecond, p95Ms };
  return result;
};

type MeasureOptions = { root: string; executable: string; workload: Workload; mode: Mode };

type LoadOptions = Pick<MeasureOptions, 'workload' | 'mode'> & { port: number; pid: number };

const measureLoad = async ({ port, pid, workload, mode }: LoadOptions) => {
  const idle = await readRss(pid);
  const base = `http://${host}:${port}`;
  const path = workload === 'large' ? '/large.bin' : '/small.txt';
  const headers: Record<string, string> = { 'accept-encoding': workload === 'brotli' ? 'br' : 'identity' };

  if (workload === 'revalidation') {
    const head = await fetch(base + path, { method: 'HEAD', headers });
    const tag = head.headers.get('etag');
    if (!tag) throw new Error('Missing ETag.');
    headers['if-none-match'] = tag;
  }

  const overallRate = workload === 'large' || workload === 'rotating' ? 300 : 5000;

  const options = {
    ...fastifyLoad,
    url: workload === 'rotating' ? rotating.map((file) => base + file.path) : base + path,
    headers,
    skipAggregateResult: true as const,
    ...(mode === 'fixed' && { overallRate }),
  };

  const common = {
    expectedStatus: workload === 'revalidation' ? 304 : 200,
    signal: AbortSignal.timeout((fastifyLoad.duration + 40) * 1000),
  };

  if (mode !== 'burst') {
    await runRound({ ...common, options: { ...options, duration: 1 }, phase: 'warmup' });
  }

  const sampler = await startSampling({ pid });

  try {
    const cpu = await readCpuSeconds(pid);
    let measured: { count: number; requestsPerSecond: number; p95Ms: number };

    if (mode === 'burst') {
      measured = await coldBurst({ base, signal: common.signal });
    } else {
      const round = await runRound({ ...common, options, phase: 'measurement' });

      measured = { count: round.totalCompletedRequests, ...summarizeRound({ round }) };
    }

    const cpuUs = (((await readCpuSeconds(pid)) - cpu) * 1e6) / measured.count;
    const peakMiB = toMiB(await sampler.finish());
    const result = { workload, mode, ...measured, idleMiB: toMiB(idle), peakMiB, cpuUs };
    return result;
  } finally {
    await sampler.stop();
  }
};

const measure = async ({ root, executable, workload, mode }: MeasureOptions) => {
  const port = await unusedPort();
  const server = startProcess({ executable, args: [root, '--host', host, '--port', String(port), '--quiet'] });
  let result: Awaited<ReturnType<typeof measureLoad>>;
  let exitCode: number | null;

  try {
    await server.waitUntilListening(port);

    if (!server.pid) throw new Error('Missing server PID.');
    result = await measureLoad({ port, pid: server.pid, workload, mode });
  } finally {
    exitCode = await server.close();
  }

  if (exitCode !== 0) throw new Error('Benchmark server did not shut down cleanly.');
  return result;
};

const selected = process.argv.slice(4);
const workloads = cases.filter((name) => !selected.length || selected.includes(name));

if (selected.some((name) => !cases.includes(name as Workload))) throw new Error('Unknown workload.');

const root = await mkdtemp(join(tmpdir(), 'fotone-compare-'));

try {
  await writeFile(join(root, 'small.txt'), small);
  await writeFile(join(root, 'small.txt.br'), brotliCompressSync(small));
  await writeFile(join(root, 'large.bin'), large);

  for (const file of rotating) await writeFile(join(root, file.path), large);

  for (let repetition = 0; repetition < 5; repetition++) {
    for (const workload of workloads) {
      const modes: Mode[] = workload === 'cold' ? ['burst'] : ['fixed', 'saturation'];

      for (const mode of modes) {
        for (const index of repetition % 2 === 0 ? [0, 1] : [1, 0]) {
          const result = await measure({ root, executable: binaries[index], workload, mode });

          console.log(JSON.stringify({ repetition, binary: index, ...result }));
        }
      }
    }
  }
} finally {
  await rm(root, { force: true, recursive: true });
}
