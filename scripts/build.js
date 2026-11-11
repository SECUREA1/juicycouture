import { mkdir, copyFile, cp } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('public', { recursive: true });
await Promise.all(['index.html', 'styles.css', 'audio-worklet.js', 'crown.svg'].map(file => copyFile(file, `public/${file}`)));
await mkdir('public/graphics', { recursive: true });
await cp('assets', 'public/graphics', { recursive: true });
await Promise.all(['coin-medallion.jpeg', 'juicy-banner.jpeg'].map(file => copyFile(file, `public/graphics/${file}`)));
await build({ entryPoints: ['client.js'], bundle: true, minify: true,
  platform: 'browser', inject: ['browser-globals.js'], target: 'es2022', outfile: 'public/app.js' });
