import type { SsgOptions } from 'nano-ssg';

export default {
  site: {
    name: 'Fotone',
    url: 'https://damianobarbati.github.io/fotone/',
    locale: 'en',
    metadata: { social: { image: { url: 'logo.png', alt: 'Fotone', width: 600, height: 600, type: 'image/png' } } },
  },
} satisfies SsgOptions;
