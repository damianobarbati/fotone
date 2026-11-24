import cx from 'clsx-tw';
import React from 'react';
import { useForm, useWatch } from 'react-hook-form';
import report from '../assets/report-combined.json' with { type: 'json' };
import { createBenchmarkRenderer } from '../benchmarkWebGl.ts';

const { metadata } = report;
const nodeServerId = 'fotone';
const servers = report.servers.filter(({ id }) => id !== nodeServerId);

const chartWorkloads = [
  { id: 'small', label: '4 KiB' },
  { id: 'large', label: '1 MiB' },
];

const workloads = chartWorkloads.map(({ id, label }) => {
  const measurements = report.results.filter(
    ({ serverId, workloadId }) => serverId !== nodeServerId && workloadId === id,
  );

  const result = {
    id,
    label,
    requestsPerSecond: measurements.map(({ requestsPerSecond }) => requestsPerSecond),
    idleRssMiB: measurements.map(({ idleRssMiB }) => idleRssMiB),
    peakRssMiB: measurements.map(({ peakRssMiB }) => peakRssMiB),
  };

  return result;
});

const metrics = [
  { value: 'requestsPerSecond', label: 'Requests/s', title: 'Requests per second' },
  { value: 'idleRssMiB', label: 'Idle RAM', title: 'Idle RAM (MiB)' },
  { value: 'peakRssMiB', label: 'Peak RAM', title: 'Peak RAM (MiB)' },
] as const;

const metricCycleInterval = 5000;
const numbers = new Intl.NumberFormat('en');
const requests = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });
const memory = new Intl.NumberFormat('en', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const getAxisMaximum = (values: number[]) => {
  const maximum = Math.max(1, ...values);
  const step = 10 ** Math.floor(Math.log10(maximum)) / 2;
  const result = Math.ceil(maximum / step) * step;
  return result;
};

type BenchmarkChartProps = { className?: string };

export const BenchmarkChart = ({ className }: BenchmarkChartProps) => {
  const form = useForm<{ workload: string; metric: string }>({
    defaultValues: { workload: workloads[0].id, metric: metrics[0].value },
  });

  const { register, setValue } = form;
  const [isMetricCycleEnabled, setMetricCycleEnabled] = React.useState(true);

  const workloadId = useWatch({ control: form.control, name: 'workload' });
  const metricId = useWatch({ control: form.control, name: 'metric' });
  const metric = metrics.find(({ value }) => value === metricId) ?? metrics[0];
  const workload = workloads.find(({ id }) => id === workloadId) ?? workloads[0];
  const values = workload[metric.value];
  const maximum = getAxisMaximum(values);
  const format = metric.value === 'requestsPerSecond' ? requests : memory;
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const rendererRef = React.useRef<ReturnType<typeof createBenchmarkRenderer>>(null);
  const valuesRef = React.useRef<number[]>([]);
  const titleId = React.useId();
  const stopMetricCycle = () => setMetricCycleEnabled(false);

  React.useEffect(() => {
    if (!isMetricCycleEnabled) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let metricIndex = 0;

    const interval = window.setInterval(() => {
      if (reducedMotion.matches) return;

      metricIndex = (metricIndex + 1) % metrics.length;
      setValue('metric', metrics[metricIndex].value);
    }, metricCycleInterval);

    return () => window.clearInterval(interval);
  }, [isMetricCycleEnabled, setValue]);

  React.useEffect(() => {
    valuesRef.current = values.map((value) => value / maximum);

    const renderer = rendererRef.current;
    if (renderer) renderer.animateTo(valuesRef.current);
  }, [values, maximum]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const renderer = rendererRef.current;
      if (renderer) renderer.draw();
    };

    const initialize = () => {
      rendererRef.current = createBenchmarkRenderer({ canvas, columnCount: servers.length });

      const renderer = rendererRef.current;
      if (renderer) renderer.animateTo(valuesRef.current);
    };

    const onContextLost = (event: Event) => {
      event.preventDefault();

      const renderer = rendererRef.current;
      if (renderer) renderer.dispose();

      rendererRef.current = null;
    };

    const resize = new ResizeObserver(draw);

    resize.observe(canvas);
    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', initialize);
    initialize();

    return () => {
      resize.disconnect();
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', initialize);

      const renderer = rendererRef.current;
      if (renderer) renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  const result = (
    <figure
      className={cx('card card-tint tint-mint glow m-0 min-w-0 p-5 max-phone:p-[0.85rem]', className)}
      aria-labelledby={titleId}
    >
      <figcaption className="grid gap-3 pb-[1.1rem]">
        <form className="flex flex-wrap items-center gap-2">
          <fieldset className="benchmark-choices">
            <legend className="sr-only">Benchmark metric</legend>
            {metrics.map(({ value, label }) => (
              <label key={value} className="benchmark-choice">
                <input
                  className="sr-only"
                  type="radio"
                  value={value}
                  {...register('metric', { onChange: stopMetricCycle })}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <fieldset className="benchmark-choices ms-auto">
            <legend className="sr-only">Benchmark workload</legend>
            {workloads.map(({ id, label }) => (
              <label key={id} className="benchmark-choice">
                <input
                  className="sr-only"
                  type="radio"
                  value={id}
                  {...register('workload', { onChange: stopMetricCycle })}
                />
                {label}
              </label>
            ))}
          </fieldset>
        </form>
        <h2 id={titleId} className="m-0 text-center text-xl leading-tight font-bold">
          {metric.title}
        </h2>
      </figcaption>

      <div className="grid grid-cols-[min-content_minmax(0,1fr)] gap-x-[0.6rem] max-phone:gap-x-[0.35rem]">
        <div
          className="relative text-right font-mono text-xs leading-[normal] max-phone:text-[0.7rem]"
          aria-hidden="true"
        >
          <span className="relative top-[5%] block -translate-y-1/2">{numbers.format(maximum)}</span>
          <span className="absolute top-[52.5%] right-0 -translate-y-1/2">{numbers.format(maximum / 2)}</span>
          <span className="absolute top-full right-0 -translate-y-1/2">0</span>
        </div>
        <div className="relative h-[clamp(7.5rem,13vw,11.25rem)]" aria-hidden="true">
          <div className="absolute inset-x-0 top-[5%] bottom-0 border-y border-[#3b504b] after:absolute after:inset-x-0 after:top-1/2 after:border-t after:border-[#3b504b]" />
          <canvas className="peer absolute inset-0 size-full" ref={canvasRef} />
          <div className="absolute inset-0 grid size-full auto-cols-fr grid-flow-col items-end justify-items-center peer-data-[renderer=webgl]:invisible">
            {values.map((value, index) => (
              <div
                key={servers[index].id}
                className="w-[62%] max-w-[4.6rem] border border-[#fff4] bg-linear-to-b/srgb from-[#638fd1] to-[#2d415e] first:from-[#71ebbd] first:to-[#266250] nth-3:from-[#ef9864] nth-3:to-[#70422d] nth-4:from-[#dfc16b] nth-4:to-[#625027]"
                style={{ height: `${(value / maximum) * 95}%` }}
              />
            ))}
          </div>
        </div>
        <ul
          className="col-start-2 mt-[0.55rem] grid list-none auto-cols-fr grid-flow-col p-0 text-center"
          aria-labelledby={titleId}
          aria-live={isMetricCycleEnabled ? 'off' : 'polite'}
        >
          {values.map((value, index) => (
            <li
              key={servers[index].id}
              className="group grid min-w-0 grid-rows-[1fr_auto] gap-[0.15rem] text-sm leading-[inherit] max-phone:text-xs"
            >
              <span>{servers[index].id === 'fotone-rust' ? 'Fotone' : servers[index].label}</span>
              <strong className="font-mono text-base leading-[normal] font-strong group-first:text-mint max-phone:text-[0.9rem] max-[375px]:text-xs">
                {format.format(value)}
              </strong>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-[0.85rem] border-t border-[#344640] pt-[0.65rem] text-center">
        {metadata.cpu} · {numbers.format(metadata.concurrency)} concurrent connections · Pipeline{' '}
        {numbers.format(metadata.pipelining)} · {numbers.format(metadata.duration)}s per run
      </div>
    </figure>
  );

  return result;
};
