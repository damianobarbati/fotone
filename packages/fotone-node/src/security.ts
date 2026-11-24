import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import bcrypt from 'bcrypt';
import type { ServerConfig } from './config.ts';

const parseBasicAuth = (header?: string) => {
  if (!header) return null;

  const token = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
  if (!token) return null;

  const decoded = Buffer.from(token[1], 'base64');
  const value = decoded.toString('utf8');
  const separator = value.indexOf(':');
  if (separator < 1 || !Buffer.from(value).equals(decoded)) return null;

  const result = { username: value.slice(0, separator), password: value.slice(separator + 1) };
  return result;
};

const digest = (text: string) => {
  const result = createHash('sha256').update(text).digest();
  return result;
};

export const createAuthorize = (config: ServerConfig) => {
  const { auth, includes, excludes } = config;
  const credentials = auth ?? { username: '', password: '', hashed: false };
  const usernameDigest = auth ? digest(credentials.username) : null;
  const passwordDigest = credentials.hashed ? null : digest(credentials.password);
  const hash = credentials.hashed ? `$2b$${credentials.password.slice(4)}` : null;
  let activeComparisons = 0;

  const authorize = async ({ path, header }: { path: string; header?: string }) => {
    if (
      !usernameDigest ||
      (includes.length && !includes.some((match) => match(path))) ||
      excludes.some((match) => match(path))
    )
      return true;

    const supplied = parseBasicAuth(header);
    if (!supplied || !timingSafeEqual(usernameDigest, digest(supplied.username))) return false;

    if (passwordDigest) {
      const result = timingSafeEqual(passwordDigest, digest(supplied.password));
      return result;
    }

    if (!hash || Buffer.byteLength(supplied.password) > 72 || activeComparisons >= 4) return false;

    activeComparisons++;

    try {
      const result: boolean = await bcrypt.compare(supplied.password, hash);
      return result;
    } finally {
      activeComparisons--;
    }
  };

  return authorize;
};

const normalizeAddress = (value: string) => {
  const address = value.trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const result = mapped ? mapped[1] : address;
  return result;
};

export const clientAddress = ({
  peer,
  forwarded,
  trusted,
}: {
  peer?: string;
  forwarded?: string | string[];
  trusted: ServerConfig['trusted'];
}) => {
  const address = normalizeAddress(peer ?? '');
  const kind = isIP(address);
  if (!kind || !trusted.check(address, kind === 4 ? 'ipv4' : 'ipv6') || !forwarded) return address;

  const raw = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  const chain = raw.split(',').map(normalizeAddress);
  if (chain.some((hop) => !isIP(hop))) return address;

  for (let index = chain.length - 1; index >= 0; index--) {
    const hop = chain[index];
    if (!trusted.check(hop, isIP(hop) === 4 ? 'ipv4' : 'ipv6')) return hop;
  }

  return chain[0];
};
