import { readFile, realpath, stat } from 'node:fs/promises';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import { hostSchema, loadEnvironment, portSchema } from './env.ts';

import {
  compilePattern,
  compileRoutes,
  decodePath,
  encodePath,
  isOriginPath,
  isRedirectTarget,
  type RouteRule,
} from './routing.ts';

export const redirectStatusSchema = z.union([
  z.literal(301),
  z.literal(302),
  z.literal(303),
  z.literal(307),
  z.literal(308),
]);

const patternSchema = z.string().refine(isOriginPath);
const rewriteSchema = z.strictObject({ source: patternSchema, destination: z.string().refine(isOriginPath) });

const redirectSchema = z.strictObject({
  source: patternSchema,
  destination: z.string().refine(isRedirectTarget),
  status: redirectStatusSchema.optional(),
});

const headerSchema = z.object({ paths: z.array(patternSchema).min(1) }).catchall(z.string().nullable());

const languagePathSchema = z
  .string()
  .refine((path) => isOriginPath(path) && path !== '/' && !/[^\x21-\x7e]|[?#]/.test(path) && decodePath(path) !== null);

const languageTagSchema = z.string().regex(/^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/i);

const languageRedirectSchema = z
  .unknown()
  .refine(
    (redirect) =>
      typeof redirect === 'object' &&
      redirect !== null &&
      Object.keys(redirect).every((key) => key === key.toLowerCase() && languageTagSchema.safeParse(key).success),
    'Expected lowercase language tags.',
  )
  .pipe(z.object({ default: languagePathSchema }).catchall(languagePathSchema))
  .transform(({ default: fallback, ...languages }) => ({ default: fallback, languages }));

const parseLanguages = ({ value, basePath }: { value: string; basePath: string }) => {
  const tags = value.split(',').map((tag) => languageTagSchema.parse(tag.trim()).toLowerCase());
  const prefix = basePath === '/' ? '' : encodePath(basePath);
  const languages = Object.fromEntries(tags.map((tag) => [tag, `${prefix}/${tag}`]));
  const result = { default: languages[tags[0]], languages };
  return result;
};

const configSchema = z.strictObject({
  basePath: z
    .string()
    .refine((path) => decodePath(path) !== null && (path === '/' || !path.endsWith('/')))
    .default('/'),
  trustedProxies: z.array(z.string()).default([]),
  extensionFallback: z.boolean().default(true),
  cleanUrls: z.boolean().default(true),
  stripTrailingSlash: z.boolean().default(true),
  spaExcludes: z.array(patternSchema).default([]),
  headers: z.array(headerSchema).default([]),
  rewrites: z.array(rewriteSchema).default([]),
  redirects: z.array(redirectSchema).default([]),
  languageRedirect: languageRedirectSchema.nullish(),
});

const secondsSchema = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative());
const cacheSecondsSchema = secondsSchema.refine((value) => value <= 2_147_483_647);
const timeoutSecondsSchema = secondsSchema.refine((value) => value <= 2_147_483);

const reservedHeaders = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

type HeaderValue = string | null;
export type ResponseHeaders = Record<string, HeaderValue>;

const parseHeader = (name: string, value: HeaderValue) => {
  validateHeaderName(name);

  const key = name.toLowerCase();
  if (reservedHeaders.has(key)) throw new Error(`Header ${name} is controlled by the server.`);

  if (value !== null) validateHeaderValue(name, value);

  const result: [string, HeaderValue] = [key, value];
  return result;
};

export const parseRouteRule = ({ name, rule }: { name: 'rewrite' | 'redirect'; rule: string }): RouteRule => {
  const separator = rule.indexOf('=');
  const source = rule.slice(0, separator);
  const target = rule.slice(separator + 1);

  if (separator < 1 || !isOriginPath(source) || !target || /\s/.test(rule)) {
    throw new Error(`--${name} requires a source path and target separated by =.`);
  }

  if (name === 'rewrite') {
    if (!isOriginPath(target)) throw new Error('--rewrite requires a local target path.');

    const result = { source, destination: target };
    return result;
  }

  const hasStatus = /=[0-9]{3}$/.test(target);
  const destination = hasStatus ? target.slice(0, -4) : target;
  if (!isRedirectTarget(destination)) throw new Error('--redirect requires a local path or an absolute HTTP(S) URL.');

  const status = hasStatus ? redirectStatusSchema.parse(Number(target.slice(-3))) : 302;
  const result = { source, destination, status };
  return result;
};

const parseTrustedProxies = (entries: string[]) => {
  const trusted = new BlockList();

  for (const entry of entries) {
    const [address, rawPrefix, ...remaining] = entry.split('/');
    const ip = isIP(address);
    if (!ip || remaining.length) throw new Error('Invalid trusted proxy address.');

    const family = ip === 4 ? 'ipv4' : 'ipv6';

    if (rawPrefix === undefined) {
      trusted.addAddress(address, family);
    } else {
      const prefix = Number(rawPrefix);
      if (!/^\d+$/.test(rawPrefix) || prefix > (ip === 4 ? 32 : 128)) throw new Error('Invalid trusted proxy CIDR.');

      trusted.addSubnet(address, prefix, family);
    }
  }

  return trusted;
};

const parseAuth = (input?: string) => {
  if (input === undefined) return null;

  const separator = input.indexOf(':');
  const username = input.slice(0, separator);
  const password = input.slice(separator + 1);

  if (!username || !password || separator < 1)
    throw new Error('--auth requires a username and password or bcrypt hash.');

  const hashed = password.startsWith('$2y$');

  if (hashed && !/^\$2y\$(?:0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$/.test(password)) {
    throw new Error('--auth contains an invalid htpasswd bcrypt hash.');
  }

  const result = { username, password, hashed };
  return result;
};

type CliValues = {
  host?: string;
  port?: string;
  config?: string;
  spa?: string;
  rewrite?: string[];
  redirect?: string[];
  header?: string[];
  auth?: string;
  'auth-include'?: string[];
  'auth-exclude'?: string[];
  cors?: boolean;
  coop?: boolean;
  coep?: boolean;
  pna?: boolean;
  immutable?: boolean;
  maxage?: string;
  timeout?: string;
  quiet?: boolean;
  'env-json'?: string;
  langs?: string;
};

export const loadConfig = async ({ root, values }: { root: string; values: CliValues }) => {
  const directory = await realpath(root);
  const metadata = await stat(directory);
  if (!metadata.isDirectory()) throw new Error('Static root must be a directory.');

  const env = await loadEnvironment();
  const raw: unknown = values.config ? JSON.parse(await readFile(values.config, 'utf8')) : {};
  const config = configSchema.parse(raw);
  const host = values.host === undefined ? (env.HOST ?? '0.0.0.0') : hostSchema.parse(values.host);
  const port = values.port === undefined ? (env.PORT ?? 0) : portSchema.parse(values.port);
  const auth = parseAuth(values.auth);
  const maxage = values.maxage === undefined ? undefined : cacheSecondsSchema.parse(values.maxage);
  const timeout = timeoutSecondsSchema.parse(values.timeout ?? '30') * 1000;
  const envJson = createEnvJson({ names: values['env-json'], variables: env.variables });

  const languageRedirect =
    values.langs === undefined
      ? config.languageRedirect
      : parseLanguages({ value: values.langs, basePath: config.basePath });

  const spa = values.spa === undefined ? null : decodePath(`/${values.spa.replace(/^\//, '')}`);
  if (values.spa !== undefined && (!spa || spa === '/')) throw new Error('--spa requires a local fallback file.');

  const result = {
    ...config,
    directory,
    host,
    port,
    timeout,
    maxage,
    auth,
    envJson,
    languageRedirect,
    spa,
    values,
    trusted: parseTrustedProxies(config.trustedProxies),
    includes: patternSchema
      .array()
      .parse(values['auth-include'] ?? [])
      .map(compilePattern),
    excludes: patternSchema
      .array()
      .parse(values['auth-exclude'] ?? [])
      .map(compilePattern),
    spaExclusions: config.spaExcludes.map(compilePattern),
    rewrite: compileRoutes([
      ...(values.rewrite ?? []).map((rule) => parseRouteRule({ name: 'rewrite', rule })),
      ...config.rewrites,
    ]),
    redirect: compileRoutes([
      ...(values.redirect ?? []).map((rule) => parseRouteRule({ name: 'redirect', rule })),
      ...config.redirects,
    ]),
    globalHeaders: (values.header ?? []).map((header) => {
      const separator = header.indexOf(':');
      if (separator < 1) throw new Error('--header requires name:value.');

      const result = parseHeader(header.slice(0, separator).trim(), header.slice(separator + 1).trim());
      return result;
    }),
    headerRules: config.headers.map(({ paths, ...headers }) => {
      const result = {
        match: paths.map(compilePattern),
        headers: Object.entries(headers).map(([name, value]) => parseHeader(name, value)),
      };

      return result;
    }),
  };

  return result;
};

const createEnvJson = ({ names, variables }: { names?: string; variables: Record<string, string | undefined> }) => {
  if (names === undefined) return null;

  const entries = names.split(',').map((value) => {
    const name = value.trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new Error('--env-json requires valid environment variable names.');

    const content = variables[name];

    if (!Object.hasOwn(variables, name) || content === undefined)
      throw new Error(`Missing environment variable: ${name}.`);

    const result = [name, content];
    return result;
  });

  const result = JSON.stringify(Object.fromEntries(entries));
  return result;
};

export type ServerConfig = Awaited<ReturnType<typeof loadConfig>>;
