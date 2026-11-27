import preset from 'nano-ssg/react';
import { mergeConfig } from 'vite';

export default mergeConfig(preset, { base: '/fotone/' });
