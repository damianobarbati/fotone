import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { z } from 'zod';

export const portSchema = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0).max(65535));

export const hostSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[^\s\p{Cc}]+$/u);

const envSchema = z.object({ HOST: hostSchema.optional(), PORT: portSchema.optional() });

export const loadEnvironment = async () => {
  let envFile: Record<string, string | undefined> = {};

  try {
    const content = await readFile('.env', 'utf8');

    envFile = parseEnv(content);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }

  const variables = { ...envFile, ...process.env };
  const env = envSchema.parse(variables);
  const result = { ...env, variables };
  return result;
};
