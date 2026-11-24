export const servers = [
  { id: 'fotone-rust', label: 'Fotone Rust', runOrder: 1 },
  { id: 'fotone', label: 'Fotone Node', runOrder: 2 },
  { id: 'express', label: 'Express', runOrder: 5 },
  { id: 'fastify', label: 'Fastify', runOrder: 3 },
  { id: 'hono', label: 'Hono', runOrder: 4 },
] as const;

export const workloads = [
  { id: 'small', title: '4 KiB identity', label: '4 KiB static file' },
  { id: 'large', title: '1 MiB identity', label: '1 MiB static file' },
  { id: 'brotli', title: '4 KiB Brotli', label: 'Brotli variant' },
  { id: 'revalidation', title: '304 revalidation', label: '304 revalidation' },
] as const;
