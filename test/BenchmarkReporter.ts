import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import type { Reporter, SerializedError, TestCase, TestModule, TestRunEndReason, Vitest } from 'vitest/node';
import { servers, workloads } from './benchmarkCases.ts';

const reportDirectory = new URL('../.reports/', import.meta.url);
const reportFile = new URL('report-combined.json', reportDirectory);
const metrics = ['requestsPerSecond', 'p95Ms', 'idleRssMiB', 'peakRssMiB'] as const;
const loadSettings = ['concurrency', 'pipelining', 'duration'] as const;

type Measurement = Record<(typeof metrics)[number] | (typeof loadSettings)[number], number>;

const readMeasurements = (cases: TestCase[]) => {
  const measurements = servers.flatMap(({ id: serverId }) =>
    workloads.map(({ id: workloadId, title }) => {
      const matches = cases.filter(
        (test) => test.parent.type === 'suite' && test.parent.name === serverId && test.name === title,
      );

      const [test] = matches;

      if (matches.length !== 1) {
        throw new Error(`Expected one passing benchmark for ${serverId} / ${title}.`);
      }

      const meta = test.meta() as ReturnType<TestCase['meta']> & Measurement;

      if (
        metrics.some((metric) => !Number.isFinite(meta[metric]) || meta[metric] < 0) ||
        loadSettings.some((setting) => !Number.isSafeInteger(meta[setting]) || meta[setting] < 1)
      ) {
        throw new Error(`Invalid benchmark metrics for ${serverId} / ${title}.`);
      }

      const { requestsPerSecond, p95Ms, idleRssMiB, peakRssMiB, concurrency, pipelining, duration } = meta;
      const load = { concurrency, pipelining, duration };
      const result = { serverId, workloadId, requestsPerSecond, p95Ms, idleRssMiB, peakRssMiB, load };
      return result;
    }),
  );

  return measurements;
};

export class BenchmarkReporter implements Reporter {
  startedAt = '';
  filtered = false;

  onInit(vitest: Vitest) {
    this.filtered = !!vitest.config.testNamePattern;
  }

  onTestRunStart() {
    this.startedAt = new Date().toISOString();
  }

  async onTestRunEnd(
    modules: ReadonlyArray<TestModule>,
    errors: ReadonlyArray<SerializedError>,
    reason: TestRunEndReason,
  ) {
    if (this.filtered || reason !== 'passed' || errors.length) return;

    const cases = modules.flatMap((module) => [...module.children.allTests()]);

    if (cases.length !== servers.length * workloads.length || cases.some((test) => test.result().state !== 'passed'))
      return;

    const measurements = readMeasurements(cases);
    const [{ load }] = measurements;

    if (
      measurements.some((measurement) => loadSettings.some((setting) => measurement.load[setting] !== load[setting]))
    ) {
      throw new Error('Benchmark load settings differ between results.');
    }

    const [cpu] = cpus();

    const report = {
      metadata: { startedAt: this.startedAt, cpu: cpu ? cpu.model : 'Unknown CPU', httpVersion: 'HTTP/1.1', ...load },
      servers: servers.map(({ id, label }) => ({ id, label })),
      workloads: workloads.map(({ id, label }) => ({ id, label })),
      results: measurements.map(({ load: _load, ...measurement }) => measurement),
    };

    const temporary = new URL(`.report-combined-${randomUUID()}.tmp`, reportDirectory);

    try {
      await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
      await rename(temporary, reportFile);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
