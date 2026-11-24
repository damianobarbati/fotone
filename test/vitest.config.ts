import { defineConfig } from 'vitest/config';
import { BenchmarkReporter } from './BenchmarkReporter.ts';

export default defineConfig({
  test: {
    benchmark: { include: ['test/static.bench.ts'] },
    reporters: ['verbose', new BenchmarkReporter()],
    silent: false,
    fileParallelism: false,
    sequence: { concurrent: false, shuffle: false },
    bail: 1,
  },
});
