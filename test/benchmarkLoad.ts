import autocannon from 'autocannon';
import histogramTools from 'autocannon/lib/histUtil.js';

const duration = Number(process.env.BENCH_DURATION_SECONDS ?? 5);

if (!Number.isSafeInteger(duration) || duration < 1) {
  throw new Error('BENCH_DURATION_SECONDS must be a positive integer.');
}

export const fastifyLoad = { connections: 100, pipelining: 10, duration };

type LoadOptions = typeof fastifyLoad & {
  url: string | string[];
  headers?: Record<string, string>;
  skipAggregateResult: true;
};

type Round = {
  latencies: string;
  errors: number;
  timeouts: number;
  statusCodeStats: Record<number, { count: number }>;
  mismatches: number;
  totalCompletedRequests: number;
  duration: number;
};

export const runRound = async ({
  options,
  expectedStatus,
  phase,
  signal,
}: {
  options: LoadOptions;
  expectedStatus: number;
  phase: 'warmup' | 'measurement';
  signal: AbortSignal;
}) => {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout((options.duration + 15) * 1_000)]);
  deadline.throwIfAborted();

  const completed = Promise.withResolvers<Round>();

  const client = autocannon(options, (error: Error | null, round: Round) => {
    if (error) completed.reject(error);
    else completed.resolve(round);
  });

  let firstError: Error | undefined;

  client.once('reqError', (error: Error) => {
    firstError = error;
  });

  const stop = () => client.stop();

  deadline.addEventListener('abort', stop, { once: true });

  try {
    const round = await completed.promise;

    deadline.throwIfAborted();

    const { errors, timeouts, statusCodeStats, mismatches, totalCompletedRequests } = round;
    const expected = statusCodeStats[expectedStatus];
    const unexpected = totalCompletedRequests - (expected ? expected.count : 0);

    if (errors || timeouts || unexpected || mismatches || !totalCompletedRequests) {
      throw new Error(
        `Invalid ${phase} load result: ${errors} errors, ${timeouts} timeouts, ${unexpected} unexpected HTTP responses, ${mismatches} mismatches, ${totalCompletedRequests} completed requests.`,
        { cause: firstError },
      );
    }

    return round;
  } finally {
    deadline.removeEventListener('abort', stop);
  }
};

export const summarizeRound = ({ round }: { round: Round }) => {
  // Autocannon's default result omits p95. Decode its raw HDR histogram after timing.
  const histogram = histogramTools.decodeHist(round.latencies);
  const p95Ms = histogram.getValueAtPercentile(95);

  histogram.destroy();

  const result = { requestsPerSecond: round.totalCompletedRequests / round.duration, p95Ms };
  return result;
};
