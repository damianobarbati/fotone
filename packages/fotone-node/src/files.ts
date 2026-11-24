import { type BigIntStats, constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { isPublicPath } from './routing.ts';

const mimeTypes = new Map(
  Object.entries({
    avif: 'image/avif',
    br: 'application/octet-stream',
    cjs: 'application/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    gif: 'image/gif',
    gz: 'application/gzip',
    htm: 'text/html; charset=utf-8',
    html: 'text/html; charset=utf-8',
    ico: 'image/x-icon',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    js: 'application/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    map: 'application/json; charset=utf-8',
    mjs: 'application/javascript; charset=utf-8',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    ogg: 'audio/ogg',
    otf: 'font/otf',
    pdf: 'application/pdf',
    png: 'image/png',
    svg: 'image/svg+xml',
    ttf: 'font/ttf',
    txt: 'text/plain; charset=utf-8',
    wasm: 'application/wasm',
    wav: 'audio/wav',
    webm: 'video/webm',
    webp: 'image/webp',
    woff: 'font/woff',
    woff2: 'font/woff2',
    xml: 'application/xml; charset=utf-8',
    zip: 'application/zip',
  }),
);

const encodings = [
  { name: 'br', suffix: '.br' },
  { name: 'gzip', suffix: '.gz' },
  { name: 'identity', suffix: '' },
] as const;

type Encoding = (typeof encodings)[number]['name'];

const identityVariants = [
  { ...encodings[2], quality: 1 },
  { ...encodings[0], quality: 0 },
  { ...encodings[1], quality: 0 },
];

const brotliVariants = [
  { ...encodings[0], quality: 1 },
  { ...encodings[2], quality: 1 },
  { ...encodings[1], quality: 0 },
];

export const getEncodings = (header?: string) => {
  if (header === undefined || header === '' || header === 'identity') return identityVariants;

  if (header === 'br') return brotliVariants;

  const accepted = new Map<string, number>();

  for (const entry of (header ?? '').split(',')) {
    const [coding, ...parameters] = entry.trim().toLowerCase().split(';');
    const name = coding.trim();
    const quality = parameters.map((parameter) => parameter.trim()).find((parameter) => parameter.startsWith('q='));
    let value = 1;

    if (quality !== undefined) {
      const raw = quality.slice(2);

      value = /^(0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/.test(raw) ? Number(raw) : 0;
    }

    accepted.set(name, value);
  }

  const wildcard = accepted.get('*');

  const result = encodings
    .map((variant) => {
      const defaultQuality = variant.name === 'identity' ? Number(wildcard !== 0) : (wildcard ?? 0);
      const result = { ...variant, quality: accepted.get(variant.name) ?? defaultQuality };
      return result;
    })
    .sort((left, right) => right.quality - left.quality);

  return result;
};

const isUnavailable = (error: unknown) => {
  const result =
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'ENAMETOOLONG'].includes(error.code);

  return result;
};

const getMetadata = async (filename: string) => {
  try {
    const metadata = await lstat(filename, { bigint: true });
    if (!metadata.isFile()) return null;

    return metadata;
  } catch (error) {
    if (isUnavailable(error)) return null;
    throw error;
  }
};

type Encodings = ReturnType<typeof getEncodings>;
type AssetInput = { directory: string; path: string; variants: Encodings };
export type Asset = { path: string; filename: string; encoding: Encoding; metadata: BigIntStats };

export const matchesAsset = ({ current, expected }: { current: BigIntStats; expected: BigIntStats }) => {
  const result =
    current.isFile() &&
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.size === expected.size &&
    current.mtimeNs === expected.mtimeNs &&
    current.ctimeNs === expected.ctimeNs;

  return result;
};

export const openAsset = async ({ filename, metadata }: Asset) => {
  try {
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

    try {
      const current = await handle.stat({ bigint: true });
      if (matchesAsset({ current, expected: metadata })) return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }

    await handle.close();
    return null;
  } catch (error) {
    if (isUnavailable(error)) return null;
    throw error;
  }
};

export const selectAsset = async ({ directory, path, variants }: AssetInput): Promise<Asset | 406 | null> => {
  if (path === '/' || path.endsWith('/') || !isPublicPath(path)) return null;

  const filename = resolve(directory, `.${path}`);

  for (const variant of variants) {
    const candidate = filename + variant.suffix;
    const metadata = await getMetadata(candidate);
    if (!metadata) continue;

    const parent = dirname(candidate);

    try {
      if ((await realpath(parent)) !== parent) return null;
    } catch (error) {
      if (isUnavailable(error)) return null;
      throw error;
    }

    if (variant.quality === 0) return 406;

    const result = { path, filename: candidate, encoding: variant.name, metadata };
    return result;
  }

  return null;
};

export const mimeType = (path: string) => {
  const result = mimeTypes.get(extname(path).slice(1).toLowerCase()) ?? 'application/octet-stream';
  return result;
};
