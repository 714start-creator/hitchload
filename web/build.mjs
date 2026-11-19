// Builds the website into dist/ (served by the API server at /).
// The JS and CSS get content hashes so browsers can cache them forever.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
const r = await build({
  entryPoints: ['src/main.tsx'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  jsx: 'automatic',
  write: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});
const js = r.outputFiles[0].contents;
const css = await readFile('src/styles.css');
const hash = (b) => createHash('sha256').update(b).digest('hex').slice(0, 10);
const jsName = `app.${hash(js)}.js`;
const cssName = `styles.${hash(css)}.css`;
await writeFile(`dist/${jsName}`, js);
await writeFile(`dist/${cssName}`, css);
const html = (await readFile('src/index.html', 'utf8')).replace('/app.js', `/${jsName}`).replace('/styles.css', `/${cssName}`);
await writeFile('dist/index.html', html);
await cp('src/public', 'dist', { recursive: true });
console.log(`built ${jsName} (${(js.length / 1024).toFixed(0)} KB), ${cssName}`);
