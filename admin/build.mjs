// Bundles the admin panel into dist/ (served by the API at /admin/).
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/main.tsx'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  jsx: 'automatic',
  outfile: 'dist/app.js',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});
await copyFile('src/index.html', 'dist/index.html');
