import cx from 'clsx-tw';
import { Code } from 'nano-ux';
import { ReferenceTable } from './ReferenceTable.tsx';

const example = {
  languageRedirect: { default: '/en/home', en: '/en/home', it: '/it/benvenuto' },
  headers: [{ paths: ['/assets/**'], 'Cache-Control': 'public, max-age=86400' }],
  redirects: [{ source: '/old/:path*', destination: '/guide/:path', status: 301 }],
};

const columns = [
  { label: 'Option' },
  { label: 'Type', nowrap: true },
  { label: 'Default', nowrap: true },
  { label: 'Description' },
];

const options: [string, string, string, string][] = [
  [
    'basePath',
    'string',
    '"/"',
    'Public URL prefix for static files. Start with / and omit the trailing slash except for /. The health endpoint stays at /health.',
  ],
  [
    'trustedProxies',
    'string[]',
    '[]',
    'IPv4 or IPv6 addresses and CIDR ranges. Fotone uses X-Forwarded-For to determine the client IP only if the direct peer is trusted.',
  ],
  ['extensionFallback', 'boolean', 'true', 'Try the .html file when an extensionless path has no exact file.'],
  ['cleanUrls', 'boolean', 'true', 'Redirect requests for existing .html files to URLs without the extension.'],
  [
    'stripTrailingSlash',
    'boolean',
    'true',
    'Redirect paths with a trailing slash to the path without it. Keep the slash on /.',
  ],
  ['spaExcludes', 'string[]', '[]', 'Public path patterns that skip SPA fallback. Applies when --spa is enabled.'],
  ['headers', 'object[]', '[]', 'Set or remove response headers for matching public paths.'],
  ['rewrites', 'object[]', '[]', 'Serve a local path under the static root without changing the browser URL.'],
  ['redirects', 'object[]', '[]', 'Send the browser to a local path or an absolute HTTP or HTTPS URL.'],
  [
    'languageRedirect',
    'object',
    'off',
    'Redirect requests for / based on Accept-Language. Use --langs to override these destinations. Explicit redirects take precedence.',
  ],
];

const ruleFields: [string, string, string, string][] = [
  [
    'headers[].paths',
    'string[]',
    'Required',
    'One or more public path patterns. Apply the rule once if any pattern matches.',
  ],
  [
    'headers[].<name>',
    'string or null',
    'Optional',
    'Use the header name as the key. Set a string value or use null to remove a value set earlier. Fotone reserves framing and encoding headers.',
  ],
  ['rewrites[].source', 'string', 'Required', 'Public path pattern to match.'],
  ['rewrites[].destination', 'string', 'Required', 'Local path starting with /, relative to the static root.'],
  ['redirects[].source', 'string', 'Required', 'Public path pattern to match.'],
  ['redirects[].destination', 'string', 'Required', 'Local path starting with / or an absolute HTTP or HTTPS URL.'],
  ['redirects[].status', 'number', '302', 'Allowed status codes are 301, 302, 303, 307, and 308.'],
  ['languageRedirect.default', 'string', 'Required', 'Local path to use when no configured language matches.'],
  [
    'languageRedirect.<tag>',
    'string',
    'Optional',
    'Use a lowercase language tag as the key and a local path as its value. The redirect keeps the original query string.',
  ],
];

type ConfigReferenceProps = { className?: string };

export const ConfigReference = ({ className }: ConfigReferenceProps) => {
  const result = (
    <section id="config-reference" className={cx('doc-section', className)} aria-labelledby="configuration">
      <div>
        <h2 id="configuration">Config Reference</h2>
        <p>
          Pass a JSON file with <code>--config</code>. All top-level keys are optional. Fotone rejects unknown keys.
        </p>
        <Code language="bash" copyable text="npx fotone ./dist --config fotone.json" />
      </div>
      <ReferenceTable label="JSON configuration options" columns={columns} rows={options} />
      <div>
        <h3 className="mb-3 text-lg font-semibold">Rule fields</h3>
        <ReferenceTable label="JSON configuration rule fields" columns={columns} rows={ruleFields} />
      </div>
      <div className="section-copy">
        <p>
          Rules match public paths using exact paths, globs such as <code>/assets/**</code>, or named segments such as{' '}
          <code>/users/:id</code>. A final <code>:path*</code> captures zero or more segments. Use <code>:path</code> in
          the rewrite or redirect destination to insert the captured value.
        </p>
        <p>
          Redirects run before rewrites. For each rule type, the first match wins. Fotone checks CLI rules before JSON
          rules. Header rules run in file order after generated headers and CLI headers.
        </p>
      </div>
      <Code language="json" copyable text={JSON.stringify(example, null, 2)} />
    </section>
  );

  return result;
};
