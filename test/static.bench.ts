import { Buffer } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { servers, workloads } from './benchmarkCases.ts';
import { fastifyLoad as load, runRound, summarizeRound } from './benchmarkLoad.ts';
import { launchBenchmarkServer, readRss, startSampling, toMiB } from './benchmarkProcess.ts';
import { host, unusedPort } from './cliProcess.ts';

const warmupDuration = Math.min(2, load.duration);
const caseTimeoutMs = (warmupDuration + load.duration + 40) * 1_000;
const identity = 'identity';
const small = Buffer.alloc(4096, 'static ');
const large = Buffer.alloc(1024 * 1024, 'static ');
const compressed = brotliCompressSync(small);

type Sample = { path: string; expected: number; bytes: number; encoding?: string; validate?: boolean };

const smallSample: Sample = { path: '/small.txt', expected: 200, bytes: small.length };

const scenarios: Record<(typeof workloads)[number]['id'], Sample> = {
  small: smallSample,
  large: { path: '/large.txt', expected: 200, bytes: large.length },
  brotli: { path: '/small.txt', expected: 200, bytes: compressed.length, encoding: 'br' },
  revalidation: { path: '/small.txt', expected: 304, bytes: 0, validate: true },
};

type RequestOptions = { sample: Sample; port: number; etag?: string };

const send = async ({ sample, port, etag }: RequestOptions) => {
  const completed = Promise.withResolvers<{ bytes: number; status: number; etag: string; encoding: string }>();

  const headers: Record<string, string> = { 'accept-encoding': sample.encoding ?? identity };

  if (sample.validate && etag) headers['if-none-match'] = etag;

  const outbound = request(
    { host, port, agent: false, path: sample.path, headers, timeout: 5_000 },
    async (response) => {
      try {
        let bytes = 0;

        for await (const chunk of response) bytes += chunk.length;

        completed.resolve({
          bytes,
          status: response.statusCode ?? 0,
          etag: response.headers.etag ?? '',
          encoding: response.headers['content-encoding'] ?? identity,
        });
      } catch (error) {
        completed.reject(error);
      }
    },
  );

  outbound.on('timeout', () => outbound.destroy(new Error('Benchmark HTTP request timed out.')));
  outbound.on('error', completed.reject);
  outbound.end();

  const result = await completed.promise;
  return result;
};

const orderedServers = servers.toSorted((left, right) => left.runOrder - right.runOrder);

describe.each(orderedServers)('$id', ({ id: serverName }) => {
  let root = '';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'fotone-bench-'));
    await writeFile(join(root, 'small.txt'), small);
    await writeFile(join(root, 'large.txt'), large);
    await writeFile(join(root, 'small.txt.br'), compressed);
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  for (const { id, title } of workloads) {
    const sample = scenarios[id];

    test(
      title,
      async ({ task, signal }) => {
        const port = await unusedPort();
        const server = await launchBenchmarkServer({ serverName, root, port });
        let exitCode: number | null;
        let summary: string;
        let sampler: Awaited<ReturnType<typeof startSampling>> | undefined;

        try {
          await server.waitUntilListening(port);

          if (!server.pid) throw new Error('Benchmark server has no PID.');

          const idleRss = await readRss(server.pid);
          let etag: string | undefined;

          if (sample.validate) {
            const first = await send({ sample: smallSample, port });
            expect(first).toMatchObject({ bytes: small.length, status: 200, encoding: identity });
            expect(first.etag).toMatch(/^W\//);
            etag = first.etag;
          }

          const checked = await send({ sample, port, etag });
          expect(checked).toMatchObject({
            bytes: sample.bytes,
            status: sample.expected,
            encoding: sample.encoding ?? identity,
          });

          if (sample === smallSample) expect(checked.etag).toMatch(/^W\//);

          const headers: Record<string, string> = { 'accept-encoding': sample.encoding ?? identity };

          if (etag) headers['if-none-match'] = etag;

          const url = `http://${host}:${port}${sample.path}`;
          const options = { ...load, url, headers, skipAggregateResult: true } as const;
          const roundOptions = { options, signal, expectedStatus: sample.expected };

          sampler = await startSampling({ pid: server.pid });

          await runRound({ ...roundOptions, options: { ...options, duration: warmupDuration }, phase: 'warmup' });

          const round = await runRound({ ...roundOptions, phase: 'measurement' });
          const peakRss = await sampler.finish();
          const { requestsPerSecond, p95Ms } = summarizeRound({ round });
          const idleRssMiB = toMiB(idleRss);
          const peakRssMiB = toMiB(peakRss);

          Object.assign(task.meta, {
            requestsPerSecond,
            p95Ms,
            idleRssMiB,
            peakRssMiB,
            concurrency: load.connections,
            pipelining: load.pipelining,
            duration: load.duration,
          });

          summary = `${serverName} | ${title} | ${Math.round(requestsPerSecond)} req/s | p95 ${p95Ms.toFixed(2)} ms | idle RSS ${idleRssMiB.toFixed(1)} MiB | peak sampled RSS ${peakRssMiB.toFixed(1)} MiB`;
        } finally {
          if (sampler) await sampler.stop();

          exitCode = await server.close();
        }

        if (exitCode !== 0) throw new Error(`${serverName} benchmark server failed to shut down cleanly.`);

        console.log(summary);
      },
      caseTimeoutMs,
    );
  }
});
