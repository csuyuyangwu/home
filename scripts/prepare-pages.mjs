import { cp, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = resolve(root, '.pages-dist');
await mkdir(destination, { recursive: true });
await copyFile(resolve(root, 'index.html'), resolve(destination, 'index.html'));
await cp(resolve(root, 'static'), resolve(destination, 'static'), { recursive: true });
// Publish only browser assets, never the backend workspace or local secrets.
console.log('Prepared .pages-dist (index.html + static assets).');
