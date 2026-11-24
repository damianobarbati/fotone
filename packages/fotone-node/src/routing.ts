import { posix } from 'node:path';

export type RouteRule = { source: string; destination: string; status?: number };
type MatchResult = Record<string, string> | null;
type CompiledPattern = (path: string) => MatchResult;

type LanguagePathInput = { header: string | undefined; languages: Record<string, string>; fallback: string };

const languagePreference = /^([a-z]{1,8}(?:-[a-z0-9]{1,8})*)(?:[ \t]*;[ \t]*q=(0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?))?$/;

export const selectLanguagePath = ({ header, languages, fallback }: LanguagePathInput) => {
  if (!header) return fallback;

  let result = fallback;
  let bestQuality = 0;

  for (const preference of header.split(',')) {
    const match = languagePreference.exec(preference.trim().toLowerCase());
    if (!match) continue;

    let [, language] = match;
    const quality = Number(match[2] ?? 1);
    if (quality <= bestQuality) continue;

    while (!Object.hasOwn(languages, language)) {
      const separator = language.lastIndexOf('-');
      if (separator === -1) break;

      language = language.slice(0, separator);
    }

    if (Object.hasOwn(languages, language)) {
      result = languages[language];
      bestQuality = quality;
    }

    if (bestQuality === 1) break;
  }

  return result;
};

export const compilePattern = (pattern: string): CompiledPattern => {
  const segments = pattern.split('/');
  const named = /^:([A-Za-z_][A-Za-z0-9_]*)(\*)?$/;
  const hasParameters = segments.some((segment) => named.test(segment));

  if (!hasParameters) {
    const result: CompiledPattern = (path) => (posix.matchesGlob(path, pattern) ? {} : null);
    return result;
  }

  const names = new Set<string>();

  const parts = segments.map((segment, index) => {
    const match = named.exec(segment);

    if (!match) {
      const result = { literal: segment };
      return result;
    }

    const [, name, remainder] = match;

    if (names.has(name) || (remainder && index !== segments.length - 1)) {
      throw new Error('Invalid named path pattern.');
    }

    names.add(name);

    const result = { name, remainder: !!remainder };
    return result;
  });

  const result: CompiledPattern = (path) => {
    const pathSegments = path.split('/');
    const values: Record<string, string> = Object.create(null);

    for (const [index, part] of parts.entries()) {
      const segment = pathSegments[index];

      if ('name' in part) {
        if (part.remainder) {
          values[part.name] = pathSegments.slice(index).join('/');
          return values;
        }

        if (!segment) return null;

        values[part.name] = segment;
      } else if (segment !== part.literal) {
        return null;
      }
    }

    return parts.length === pathSegments.length ? values : null;
  };

  return result;
};

export const encodePath = (path: string) => {
  const result = path.split('/').map(encodeURIComponent).join('/');
  return result;
};

export const decodePath = (path: string) => {
  if (!path.startsWith('/') || path.includes('//') || /%2f/i.test(path)) return null;

  try {
    const result = decodeURIComponent(path);

    if (/[\p{Cc}\\]/u.test(result) || result.split('/').some((segment) => segment === '.' || segment === '..')) {
      return null;
    }

    return result;
  } catch {
    return null;
  }
};

export const compileRoutes = (rules: RouteRule[]) => {
  const routes = rules.map((rule) => ({ ...rule, match: compilePattern(rule.source) }));

  const result = (path: string) => {
    for (const { match, destination, status } of routes) {
      const captures = match(path);

      if (captures) {
        const target = destination.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (full, name: string) => {
          const value = captures[name];
          const replacement = value === undefined ? full : encodePath(value);
          return replacement;
        });

        const result = { target, status };
        return result;
      }
    }

    return null;
  };

  return result;
};

export const isPublicPath = (path: string) => {
  const result = !path
    .split('/')
    .some((segment, index) => segment.startsWith('.') && !(index === 1 && segment === '.well-known'));

  return result;
};

export const isOriginPath = (path: string) => {
  const result = path.startsWith('/') && !path.startsWith('//') && !/[\s\\]/.test(path);
  return result;
};

export const isRedirectTarget = (target: string) => {
  const result =
    isOriginPath(target) || (/^https?:\/\//i.test(target) && !/[\s\\]/.test(target) && URL.canParse(target));

  return result;
};
