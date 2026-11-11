import { mkdir, copyFile } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('public', { recursive: true });
await Promise.all(['index.html', 'styles.css', 'audio-worklet.js'].map(file => copyFile(file, `public/${file}`)));
await build({ entryPoints: ['client.js'], bundle: true, minify: true,
  platform: 'browser', target: 'es2022', outfile: 'public/app.js' });
