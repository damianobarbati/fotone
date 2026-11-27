import cx from 'clsx-tw';
import { ReferenceTable } from './ReferenceTable.tsx';

const options: [string, string, string][] = [
  ['--host <host>', '0.0.0.0', 'Bind address. Uses HOST when this option is omitted.'],
  ['--port <port>', '0', 'Bind TCP port. Uses PORT when this option is omitted. Port 0 lets the OS choose.'],
  ['--spa[=<file>]', 'off', 'Enable SPA fallback. Bare --spa uses index.html.'],
  [
    '--langs <tags>',
    'none',
    'Redirect / by browser language. Use comma-separated tags with the default first, such as en,it,fr.',
  ],
  ['--rewrite <pattern>=<replacement>', 'none', 'Rewrite matching URLs to local paths. Repeatable.'],
  ['--redirect <source>=<target>[=<status>]', 'none', 'Redirect matching URLs. Repeatable. Status defaults to 302.'],
  ['-H, --header <name:value>', 'none', 'Add a response header. Repeatable.'],
  ['--auth <user:password|htpasswd>', 'none', 'Enable Basic Auth with a password or an Apache bcrypt record.'],
  ['--auth-include <path-or-glob>', 'none', 'Protect only matching paths with Basic Auth. Repeatable.'],
  ['--auth-exclude <path-or-glob>', 'none', 'Exclude matching paths from Basic Auth. Repeatable.'],
  ['--cors', 'off', 'Set Access-Control-Allow-Origin.'],
  ['--coop', 'off', 'Set Cross-Origin-Opener-Policy.'],
  ['--coep', 'off', 'Set Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy.'],
  ['--pna', 'off', 'Set Access-Control-Allow-Private-Network.'],
  ['-i, --immutable', 'off', 'Set the Cache-Control to immutable.'],
  ['-m, --maxage <seconds>', 'none', 'Set the Cache-Control max-age in seconds.'],
  ['-t, --timeout <seconds>', '30', 'Set the idle timeout in seconds. Use 0 to disable it.'],
  ['--env-json <names>', 'none', 'Expose a comma-separated list of environment variables as JSON at /env.'],
  ['-q, --quiet', 'off', 'Suppress output and logs.'],
  ['-c, --config <file>', 'none', 'Load a JSON configuration file.'],
  ['-h, --help', 'off', 'Show help and exit.'],
  ['-v, --version', 'off', 'Show the version and exit.'],
];

type CLIReferenceProps = { className?: string };

export const CLIReference = ({ className }: CLIReferenceProps) => {
  const result = (
    <section id="cli-reference" className={cx('doc-section', className)} aria-labelledby="cli-reference-title">
      <div>
        <h2 id="cli-reference-title">CLI Reference</h2>
        <code>{'npx fotone <root> [options]'}</code>
        <p>
          Fotone serves <code>index.html</code> at directory URLs when that file exists. Use <code>--spa</code> to serve
          a fallback page for unmatched routes.
        </p>
      </div>
      <ReferenceTable
        label="CLI options"
        columns={[{ label: 'Options' }, { label: 'Default', nowrap: true }, { label: 'Description' }]}
        rows={options}
      />
    </section>
  );

  return result;
};
