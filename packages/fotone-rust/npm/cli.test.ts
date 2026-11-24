import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const platform = `${process.platform}-${process.arch}`;
const supported = platform === 'darwin-arm64' || platform === 'linux-x64';

describe('fotone npm launcher', () => {
  let directory: string;
  let cli: string;

  it.aroundEach(async (runTest) => {
    directory = await mkdtemp(join(tmpdir(), 'fotone-cli-'));
    cli = join(directory, 'cli.mjs');

    try {
      await copyFile(new URL('./cli.js', import.meta.url), cli);
      await runTest();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.runIf(supported)('passes the argument and exit status through the executable', async () => {
    const bin = join(directory, 'bin');

    await mkdir(bin);
    await writeFile(join(bin, `fotone-${platform}`), '#!/bin/sh\nprintf "%s\\n" "$1"\nexit 23\n', { mode: 0o755 });

    await expect(exec(process.execPath, [cli, 'path with spaces'])).rejects.toMatchObject({
      code: 23,
      stdout: 'path with spaces\n',
    });
  });

  it.runIf(supported)('reports a missing bundled binary', async () => {
    await expect(exec(process.execPath, [cli, '--version'])).rejects.toMatchObject({
      code: 1,
      stderr: `fotone: The bundled binary for ${platform} is missing or cannot run.\n`,
    });
  });

  it('reports an unsupported platform', async () => {
    const overridePlatform = encodeURIComponent('Object.defineProperty(process, "arch", { value: "unsupported" });');

    await expect(
      exec(process.execPath, ['--import', `data:text/javascript,${overridePlatform}`, cli]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: `fotone: Unsupported platform ${process.platform}-unsupported. Fotone supports Apple Silicon and Linux x64.\n`,
    });
  });
});
