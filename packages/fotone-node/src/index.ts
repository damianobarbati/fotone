#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { type ParseArgsOptionsConfig, parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { createFotoneServer } from './server.ts';

type CliOption = ParseArgsOptionsConfig[string] & { value?: string; defaultLabel?: string; description: string };

const defaultTimeoutSeconds = '30';

const options = {
  host: { type: 'string', value: '<host>', defaultLabel: '0.0.0.0', description: 'Bind address' },
  port: { type: 'string', value: '<port>', defaultLabel: '0', description: 'Bind TCP port (0 lets the OS choose)' },
  spa: { type: 'string', value: '[=<file>]', defaultLabel: 'off', description: 'Enable SPA fallback to index.html' },
  langs: {
    type: 'string',
    value: '<tags>',
    description: 'Redirect / by browser language. Use comma-separated tags with the default first.',
  },
  rewrite: {
    type: 'string',
    multiple: true,
    value: '<pattern>=<replacement>',
    description: 'Rewrite matching URLs to local paths (repeatable)',
  },
  redirect: {
    type: 'string',
    multiple: true,
    value: '<source>=<target>[=<status>]',
    description: 'Redirect matching URLs (repeatable, default status: 302)',
  },
  header: {
    type: 'string',
    short: 'H',
    multiple: true,
    value: '<name:value>',
    description: 'Add a response header (repeatable)',
  },
  auth: {
    type: 'string',
    value: '<user:password|htpasswd>',
    description: 'Enable Basic Auth with a password or htpasswd bcrypt record',
  },
  'auth-include': {
    type: 'string',
    multiple: true,
    value: '<path-or-glob>',
    description: 'Include Basic Auth only for matching paths (repeatable)',
  },
  'auth-exclude': {
    type: 'string',
    multiple: true,
    value: '<path-or-glob>',
    description: 'Exclude Basic Auth for matching paths (repeatable)',
  },
  cors: { type: 'boolean', description: 'Set Access-Control-Allow-Origin' },
  coop: { type: 'boolean', description: 'Set Cross-Origin-Opener-Policy' },
  coep: { type: 'boolean', description: 'Set Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy' },
  pna: { type: 'boolean', description: 'Set Access-Control-Allow-Private-Network' },
  immutable: { type: 'boolean', short: 'i', description: 'Set Cache-Control: immutable' },
  maxage: { type: 'string', short: 'm', value: '<seconds>', description: 'Set Cache-Control: max-age=<seconds>' },
  timeout: {
    type: 'string',
    short: 't',
    default: defaultTimeoutSeconds,
    value: '<seconds>',
    description: 'Set idle timeout in seconds (0 disables it)',
  },
  'env-json': {
    type: 'string',
    value: '<names>',
    description: 'Expose comma-separated environment variables as JSON at /env',
  },
  quiet: { type: 'boolean', short: 'q', description: 'Suppress output and logs' },
  config: { type: 'string', short: 'c', value: '<file>', description: 'Load a JSON configuration file' },
  help: { type: 'boolean', short: 'h', description: 'Show help' },
  version: { type: 'boolean', short: 'v', description: 'Show version' },
} as const satisfies Record<string, CliOption>;

const printHelp = () => {
  const entries: [string, CliOption][] = Object.entries(options);

  const rows = entries.map(([name, option]) => {
    const alias = option.short ? `-${option.short}, ` : '';
    let argument = '';

    if (option.value) {
      argument = option.value.startsWith('[') ? option.value : ` ${option.value}`;
    }

    const label = `${alias}--${name}${argument}`;
    const unsetLabel = option.type === 'boolean' ? 'off' : 'none';
    const defaultLabel = option.defaultLabel ?? String(option.default ?? unsetLabel);
    const result = { label, defaultLabel, description: option.description };
    return result;
  });

  const columns = { label: 'Option', defaultLabel: 'Default', description: 'Description' };
  const labelWidth = Math.max(...rows.map(({ label }) => label.length), columns.label.length);
  const defaultWidth = Math.max(...rows.map(({ defaultLabel }) => defaultLabel.length), columns.defaultLabel.length);

  const lines = [columns, ...rows].map(
    ({ label, defaultLabel, description }) =>
      `  ${label.padEnd(labelWidth)}  ${defaultLabel.padEnd(defaultWidth)}  ${description}`,
  );

  console.log(['Usage:', '  fotone-node <root> [options]', '', 'Options:', ...lines].join('\n'));
};

const run = async () => {
  const args = process.argv.slice(2);

  for (const [index, arg] of args.entries()) {
    if (arg === '--') break;

    if (arg === '--spa') args[index] = '--spa=index.html';
  }

  const { values, positionals } = parseArgs({ args, options, allowPositionals: true });

  if (values.help) {
    printHelp();
    return;
  }

  if (values.version) {
    const manifestPath = findPackageJSON(import.meta.url);
    if (!manifestPath) throw new Error('Package version is unavailable.');

    const { version } = JSON.parse(readFileSync(manifestPath, 'utf8'));

    console.log(version);
    return;
  }

  if (positionals.length !== 1 || !positionals[0]) throw new Error('Specify one static root directory.');

  const config = await loadConfig({ root: positionals[0], values });
  const server = createFotoneServer(config);
  const address = await server.start();

  if (!config.values.quiet) {
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;

    console.log(`Listening on http://${host}:${address.port}`);
  }

  const stop = async () => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await server.stop();
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
};

try {
  await run();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unexpected CLI error.';

  console.error(`fotone-node: ${message}`);
  process.exitCode = 1;
}
