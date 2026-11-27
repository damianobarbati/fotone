import type { PageRoute } from 'virtual:ssg/router';
import cx from 'clsx-tw';
import { Button, Code, Metric, Mockup, Nav } from 'nano-ux';
import { BenchmarkChart } from '../components/BenchmarkChart.tsx';
import { CLIReference } from '../components/CLIReference.tsx';
import { ConfigReference } from '../components/ConfigReference.tsx';
import { ContactButton } from '../components/ContactButton.tsx';
import { IArrowUpRight, IGitHub, ILinkedIn } from '../icons.tsx';
import report from '../public/report-combined.json' with { type: 'json' };

export const route = {
  metadata: {
    title: 'Fotone | Fastest static web server in the world',
    description:
      'Serve static sites and applications with Fotone, a small production web server with SPA routing and precompressed assets.',
    canonical: './',
    llms: {
      links: [
        { group: 'Documentation', title: 'Quick Start', anchor: 'quick-start', description: 'Run Fotone locally.' },
        {
          group: 'Documentation',
          title: 'CLI Reference',
          anchor: 'cli-reference',
          description: 'Command line options.',
        },
        {
          group: 'Documentation',
          title: 'Config Reference',
          anchor: 'config-reference',
          description: 'Configuration file options.',
        },
      ],
    },
  },
} satisfies PageRoute;

const logo = `${import.meta.env.BASE_URL}logo-on-dark.svg`;
const repository = 'https://github.com/damianobarbati/fotone';
const quickStart = 'npx fotone ./dist --port 8080';

const dockerfile = `FROM node:26-alpine AS build
WORKDIR /build
RUN npm install fotone
RUN cp "node_modules/fotone/bin/fotone-linux-$(node -p process.arch)" /usr/local/bin/fotone

FROM alpine
COPY --from=build /usr/local/bin/fotone /usr/local/bin/fotone
COPY dist/ /srv/
CMD exec /usr/local/bin/fotone /srv --port 8080
`.trim();

const dockerCommands = `mkdir -p dist
echo 'Hello, world!' > dist/index.html
docker build -t fotone-test .
docker run --rm -p 8080:8080 fotone-test`;

const measurements = report.results.filter(({ workloadId }) => workloadId === 'small');
const fotone = measurements.find(({ serverId }) => serverId === 'fotone');
const express = measurements.find(({ serverId }) => serverId === 'express');

if (!fotone || !express || express.peakRssMiB <= 0) {
  throw new Error('Expected peak RAM measurements for Fotone and Express in the 4 KiB benchmark.');
}

const peakRamReduction = Math.round(100 * (1 - fotone.peakRssMiB / express.peakRssMiB));

const throughputRatios = report.workloads.map(({ id }) => {
  const workload = report.results.filter(({ workloadId }) => workloadId === id);
  const fotone = workload.find(({ serverId }) => serverId === 'fotone');
  const express = workload.find(({ serverId }) => serverId === 'express');

  if (!fotone || !express || express.requestsPerSecond <= 0) {
    throw new Error(`Expected request rates for Fotone and Express in benchmark ${id}.`);
  }

  const ratio = fotone.requestsPerSecond / express.requestsPerSecond;
  return ratio;
});

const maxThroughputRatio = Math.max(...throughputRatios);

type PageProps = { className?: string };

export const Page = ({ className }: PageProps) => {
  const result = (
    <div
      className={cx(
        'mx-auto w-[calc(100%-4rem)] max-w-[1160px] max-tablet:w-[calc(100%-2.5rem)] max-phone:w-[calc(100%-2rem)]',
        className,
      )}
    >
      <header className="flex min-h-19 flex-wrap items-center gap-x-8 gap-y-4 border-b border-divider max-lg:sticky max-lg:top-0 max-lg:z-50 max-lg:min-h-14 max-lg:flex-nowrap max-lg:gap-x-2 max-lg:bg-bg max-lg:[&>button:first-of-type]:w-11">
        <a
          className="flex items-center gap-2 font-brand text-[1.875rem] leading-none font-bold text-seafoam max-lg:order-1"
          href="./"
          aria-label="Fotone home"
        >
          <span className="size-8 shrink-0 bg-current mask-[url(/logo-on-dark.svg)] mask-contain" aria-hidden="true" />
          <span className="block text-glow-brand text-box-trim">Fotone</span>
        </a>
        <Nav
          className="*:flex *:items-center max-lg:*:min-h-11 max-lg:*:rounded-control max-lg:*:px-3 max-lg:*:hover:bg-layer lg:translate-y-[0.17rem] lg:flex-wrap"
          label="Page sections"
        >
          <a className="site-link" href="#why-fotone">
            <span className="block text-box-trim">
              Why <span className="font-brand">Fotone</span>
            </span>
          </a>
          <a className="site-link" href="#features">
            <span className="block text-box-trim">Features</span>
          </a>
          <a className="site-link" href="#quick-start">
            <span className="block text-box-trim">Quick start</span>
          </a>
          <a className="site-link" href="#cli-reference">
            <span className="block text-box-trim">CLI Reference</span>
          </a>
          <a className="site-link" href="#config-reference">
            <span className="block text-box-trim">Config Reference</span>
          </a>
        </Nav>
        <div className="ms-auto flex shrink-0 items-center gap-5 text-sm max-lg:order-2 max-phone:gap-3">
          <ContactButton labelClassName="block text-box-trim trim-ex max-phone:sr-only" />
          <a className="site-action" href={repository} target="_blank" rel="noopener noreferrer">
            <IGitHub aria-hidden="true" size="1em" />
            <span className="block text-box-trim trim-ex max-sm:sr-only">GitHub</span>
          </a>
        </div>
      </header>

      <main className="max-lg:[&_section[id]]:scroll-mt-16">
        <section
          className="grid grid-cols-[minmax(0,1.02fr)_minmax(0,0.98fr)] items-center gap-[clamp(2rem,5.5vw,5rem)] py-[clamp(3.25rem,5vw,5.5rem)] max-tablet:grid-cols-1 max-tablet:gap-10 max-tablet:py-16 max-phone:gap-6 max-phone:py-11"
          aria-labelledby="hero-title"
        >
          <div>
            <h1
              id="hero-title"
              className="m-0 text-[clamp(2.6rem,5.65vw,5.15rem)] font-[750] leading-[0.99] tracking-[-0.06em]"
            >
              <span className="flex items-center gap-[0.18em] font-brand text-seafoam">
                <img className="size-[0.9em] shrink-0" src={logo} alt="" width={80} height={80} />
                <span className="text-glow-brand">Fotone</span>
              </span>{' '}
              <span className="mt-[0.45rem] block text-[clamp(2rem,4vw,3.65rem)] leading-[1.08] tracking-[-0.02em] text-balance">
                The fastest one-command static web server in the world.
              </span>
            </h1>
            <p className="mt-[1.6rem] mb-[1.8rem] max-w-[35ch] text-lg leading-[1.65]">One command. All the power.</p>
            <div className="flex flex-wrap items-center gap-3">
              <Button as="a" href="#quick-start" size="lg">
                Quick start
              </Button>
              <Button as="a" href={repository} variant="outline" size="lg" rightIcon={IArrowUpRight}>
                View source
              </Button>
            </div>
          </div>

          <div className="grid min-w-0 gap-6">
            <Mockup className="card-tint tint-mint glow" variant="terminal" role="group" aria-label="Terminal">
              <code className="block whitespace-pre">{quickStart}</code>
              <div className="mt-2 flex items-center gap-2 text-xs wrap-anywhere">Listening on http://0.0.0.0:8080</div>
            </Mockup>
            <BenchmarkChart />
          </div>
        </section>

        <section className="grid grid-cols-3 gap-4 pb-14 max-phone:grid-cols-1" aria-label="Fotone metrics">
          <Metric
            className="card-outline glow [&>p]:text-fg"
            label="Linux ARM64 Docker example"
            value={12.47}
            decimals={2}
            suffix=" MB"
          />
          <Metric
            className="card-outline glow [&>p]:text-fg"
            label="Peak req/s vs Express"
            value={maxThroughputRatio}
            decimals={1}
            suffix="×"
          />
          <Metric
            className="card-outline glow [&>p]:text-fg"
            label="Less peak RAM than Express (4 KiB)"
            value={peakRamReduction}
            suffix="%"
          />
        </section>

        <section id="why-fotone" className="doc-section doc-section-split" aria-labelledby="why-title">
          <h2 id="why-title">
            Why <span className="font-brand">Fotone</span>
          </h2>
          <div className="section-copy">
            <p>
              <span className="font-brand">Fotone</span> is a minimal static web server written in Rust. It runs without
              Node.js. In our benchmarks, Fotone outperformed every static web server from npm that we tested.
            </p>
            <p>
              Fotone can redirect visitors from <code>/</code> to a language your site supports based on their browser
              preferences. It serves precompressed Brotli and gzip assets and supports SPA fallback, cache headers, COOP
              and COEP headers.
            </p>
            <p>
              If your app needs different settings in staging and production, Fotone can expose selected environment
              variables to the browser at runtime, so you can use the same image in both.
            </p>
          </div>
        </section>

        <section id="features" className="doc-section" aria-labelledby="features-title">
          <h2 id="features-title">Features</h2>
          <div className="feature-grid grid grid-cols-3 gap-4 wrap-anywhere max-tablet:grid-cols-2 max-phone:grid-cols-1">
            <div className="card-outline card-tint glow">
              <h3>Serve a directory with one command</h3>
              <p>
                Run <code>{quickStart}</code>. File changes take effect without a restart.
              </p>
            </div>
            <div className="card-outline card-tint glow">
              <h3>Support single-page web applications</h3>
              <p>
                Serve <code>index.html</code> or a custom fallback for deep links. Exclude paths from the fallback as
                needed.
              </p>
            </div>
            <div className="card-outline card-tint glow">
              <h3>Serve precompressed assets</h3>
              <p>
                Select Brotli or gzip files from your build based on the client’s <code>Accept-Encoding</code> header.
              </p>
            </div>
            <div className="card-outline card-tint glow">
              <h3>Control browser caching</h3>
              <p>
                Use <code>ETag</code> and <code>Last-Modified</code> to return <code>304 Not Modified</code> for
                unchanged assets. Set <code>max-age</code> and <code>immutable</code>.
              </p>
            </div>
            <div className="card-outline card-tint glow">
              <h3>Configure rewrites and redirects</h3>
              <p>
                Set clean HTML URLs, a URL base path, and a custom <code>404.html</code>. Apply response headers
                globally or by path, with shortcuts for CORS and cross-origin isolation.
              </p>
            </div>
            <div className="card-outline card-tint glow">
              <h3>Run behind an HTTPS reverse proxy</h3>
              <p>
                Serve HTTP/1.1 and cleartext HTTP/2 (<code>h2c</code>) on the same port. Log client IPs through
                configured trusted proxies.
              </p>
            </div>
            <div className="card-outline card-tint glow">
              <h3>Protect with Basic Auth</h3>
              <p>Use a username and password or an Apache bcrypt record. Include or exclude paths by pattern.</p>
            </div>
            <div className="card-outline card-tint glow">
              <h3>
                Expose selected <code>.env</code> values at runtime
              </h3>
              <p>
                Serve selected variables to the browser as JSON at <code>/env</code>, such as a public API URL.
              </p>
            </div>
            <div className="card-outline card-tint glow">
              <h3>Cache small files and stream larger ones</h3>
              <p>Keep small files in a bounded memory cache and stream larger files from disk.</p>
            </div>
          </div>
        </section>

        <section id="quick-start" className="doc-section doc-section-split">
          <div>
            <h2>Quick start</h2>
            <p>Use Node.js 24 or later. Pass your build directory and add flags for the behavior your site needs.</p>
          </div>
          <Mockup className="card-tint tint-mint glow self-start" variant="terminal" role="group" aria-label="Terminal">
            <Code
              className="grid min-h-14 content-center bg-transparent [&>pre]:bg-transparent [&>pre]:p-0 [&>pre]:whitespace-pre-wrap"
              language="bash"
              copyable
              text={quickStart}
            />
          </Mockup>
          <div>
            <h3 className="mb-2 text-xl font-bold">Docker</h3>
            <p>
              Save the Dockerfile in an empty directory. Create the example site, build the image, and run it. Open{' '}
              <code>http://localhost:8080</code>.
            </p>
          </div>
          <div className="grid gap-4">
            <figure className="min-w-0">
              <figcaption className="mb-2 font-mono text-sm">Dockerfile</figcaption>
              <Code language="docker" text={dockerfile} copyable />
            </figure>
            <Code language="bash" text={dockerCommands} copyable />
          </div>
        </section>

        <CLIReference />
        <ConfigReference />
      </main>

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-divider py-6 text-sm">
        <div className="font-brand flex items-center gap-2 font-semibold">
          <img className="shrink-0" src={logo} alt="" width={32} height={32} />
          <span>Fotone</span>
        </div>
        <p className="m-0">
          Copyright{' '}
          <strong>
            <a className="site-link no-underline" href="https://damianobarbati.github.io/hq/">
              Damiano Barbati
            </a>
          </strong>
        </p>
        <div className="ms-auto flex items-center gap-4 max-phone:ms-0 max-phone:mt-2 max-phone:basis-full">
          <a className="site-action [&>svg]:shrink-0" href="https://linkedin.com/in/damianobarbati">
            <ILinkedIn aria-hidden="true" size="1.25rem" />
            <span>LinkedIn</span>
          </a>
          <ContactButton />
        </div>
      </footer>
    </div>
  );

  return result;
};
