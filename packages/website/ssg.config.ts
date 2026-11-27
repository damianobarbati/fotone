import type { SsgOptions } from 'nano-ssg';

export default {
  site: {
    name: 'Fotone',
    url: 'https://damianobarbati.github.io/fotone/',
    locale: 'en',
    metadata: {
      social: {
        card: 'summary_large_image',
        image: { url: 'mark.png', alt: 'Fotone', width: 600, height: 314, type: 'image/png' },
      },
    },
  },
} satisfies SsgOptions;
