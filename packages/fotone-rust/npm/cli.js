#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, constants as fsConstants } from 'node:fs/promises';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';

const run = async () => {
  const platform = `${process.platform}-${process.arch}`;

  if (platform !== 'darwin-arm64' && platform !== 'linux-x64') {
    throw new Error(`Unsupported platform ${platform}. Fotone supports Apple Silicon and Linux x64.`);
  }

  const executable = fileURLToPath(new URL(`./bin/fotone-${platform}`, import.meta.url));

  try {
    await access(executable, fsConstants.X_OK);
  } catch (error) {
    throw new Error(`The bundled binary for ${platform} is missing or cannot run.`, { cause: error });
  }

  const child = spawn(executable, process.argv.slice(2), { stdio: 'inherit' });
  const onInterrupt = () => child.kill('SIGINT');
  const onTerminate = () => child.kill('SIGTERM');

  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);

  try {
    const [code, signal] = await once(child, 'exit');
    const result = code ?? 128 + constants.signals[signal];
    return result;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
};

try {
  process.exitCode = await run();
} catch (error) {
  console.error(`fotone: ${error.message}`);
  process.exitCode = 1;
}
