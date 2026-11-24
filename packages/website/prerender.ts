import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createServer, type Plugin } from 'vite';

export const prerender = ({ root }: { root: string }): Plugin => {
  const result: Plugin = {
    name: 'prerender',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: async (html) => {
        const server = await createServer({
          root,
          configFile: false,
          optimizeDeps: { noDiscovery: true, include: [] },
          server: { middlewareMode: true, watch: null, ws: false },
        });

        try {
          const { App } = (await server.ssrLoadModule(
            '/components/App.tsx',
          )) as typeof import('./src/components/App.tsx');

          const markup = renderToString(createElement(App));
          const result = html.replace('<div id="root"></div>', () => `<div id="root">${markup}</div>`);
          return result;
        } finally {
          await server.close();
        }
      },
    },
  };

  return result;
};
