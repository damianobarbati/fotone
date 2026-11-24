import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import manifest from './package.json' with { type: 'json' };

const { version } = manifest;
const root = import.meta.dirname;
const rustRoot = join(root, 'packages/fotone-rust');
const publishRoot = join(root, '.publish');

const binaries = {
  'fotone-darwin-arm64': 'target/release/fotone-rust',
  'fotone-linux-x64': 'target/x86_64-unknown-linux-musl/release/fotone-rust',
};

const packageManifest = {
  name: 'fotone',
  version,
  description: 'Production static HTTP server',
  keywords: ['cli', 'command', 'http', 'http-server', 'serve', 'server', 'static'],
  repository: { type: 'git', url: `git+${manifest.repository}.git` },
  license: manifest.license,
  type: 'module',
  engines: { node: '>=24' },
  bin: { fotone: 'cli.js' },
  files: ['cli.js', 'bin/'],
};

const syncCargoVersion = async () => {
  const files = [
    { name: 'Cargo.toml', pattern: /^(?<prefix>\[package\]\r?\nname = "fotone-rust"\r?\nversion = ")[^"\r\n]+"$/m },
    { name: 'Cargo.lock', pattern: /^(?<prefix>\[\[package\]\]\r?\nname = "fotone-rust"\r?\nversion = ")[^"\r\n]+"$/m },
  ];

  const updates: { path: string; updated: string }[] = [];

  for (const { name, pattern } of files) {
    const path = join(rustRoot, name);
    const content = await readFile(path, 'utf8');

    if (!pattern.test(content)) {
      throw new Error(`Cannot find the fotone-rust version in ${name}.`);
    }

    const updated = content.replace(pattern, `$<prefix>${version}"`);

    if (updated !== content) {
      updates.push({ path, updated });
    }
  }

  for (const { path, updated } of updates) {
    await writeFile(path, updated);
  }
};

const pack = async () => {
  const sourceReadme = await readFile(join(root, 'README.md'), 'utf8');
  const [intro] = sourceReadme.split(/^## Development[ \t]*\r?$/m, 1);
  const dist = join(root, 'dist');

  await mkdir(dist, { recursive: true });

  const stage = await mkdtemp(join(dist, '.pack-'));

  try {
    const bin = join(stage, 'bin');

    await mkdir(bin);

    for (const [name, source] of Object.entries(binaries)) {
      const executable = join(bin, name);

      await copyFile(join(rustRoot, source), executable);
      await chmod(executable, 0o755);
    }

    const launcher = join(stage, 'cli.js');

    await copyFile(join(rustRoot, 'npm/cli.js'), launcher);
    await chmod(launcher, 0o755);
    await writeFile(join(stage, 'README.md'), `${intro.trimEnd()}\n`);
    await writeFile(join(stage, 'package.json'), JSON.stringify(packageManifest, null, 2));

    await rm(publishRoot, { recursive: true, force: true });
    await rename(stage, publishRoot);

    console.log(`Prepared ${packageManifest.name}@${version} in ${publishRoot}`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
};

await syncCargoVersion();

if (process.argv[2] !== '--sync-version') {
  await pack();
}
