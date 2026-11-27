import { readFile, writeFile } from 'node:fs/promises';

const source = new URL('../../.report/report-combined.json', import.meta.url);
const asset = new URL('./src/public/report-combined.json', import.meta.url);

const copyReport = async () => {
  let report: Buffer;

  try {
    report = await readFile(source);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      await readFile(asset);
      return;
    }

    throw error;
  }

  await writeFile(asset, report);
};

await copyReport();
