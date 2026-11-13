import { build } from 'esbuild';
import { createPluginBundlerPresets } from '@paperclipai/plugin-sdk/bundlers';

const { esbuild: presets } = createPluginBundlerPresets({
  manifestEntry: 'src/manifest.js',
  workerEntry: 'src/worker.js',
  uiEntry: 'src/ui/index.jsx',
});

await Promise.all([build(presets.worker), build(presets.manifest), build({ ...presets.ui, jsx: 'automatic' })]);
