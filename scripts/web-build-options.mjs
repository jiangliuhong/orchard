import { fileURLToPath } from 'node:url';

export const webBuildOptions = {
  entryPoints: ['src/web/App.tsx'], bundle: true, minify: true, format: 'iife',
  platform: 'browser', target: 'es2020', outfile: 'dist/server/client.js',
  loader: { '.ttf': 'dataurl', '.svg': 'dataurl' },
};

export const editorWorkerBuildOptions = {
  entryPoints: [fileURLToPath(import.meta.resolve('monaco-editor/editor/editor.worker.js'))],
  bundle: true, minify: true, format: 'iife', platform: 'browser', target: 'es2020',
  outfile: 'dist/server/editor-assets/editor.worker.js',
};
