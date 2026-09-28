// Copies the browser build of ExcelJS from node_modules into vendor/ (committed), so the app
// never needs a CDN. Run after `npm install`:  npm run vendor
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(root, 'node_modules', 'exceljs');
const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;

let js = readFileSync(join(pkgDir, 'dist', 'exceljs.min.js'), 'utf8');
// Drop the source-map comment so browser dev tools never try to fetch a .map file.
js = js.replace(/\n?\/\/# sourceMappingURL=.*\s*$/, '\n');

mkdirSync(join(root, 'vendor'), { recursive: true });
writeFileSync(join(root, 'vendor', 'exceljs.min.js'), js);
writeFileSync(join(root, 'vendor', 'exceljs.LICENSE.txt'), readFileSync(join(pkgDir, 'LICENSE'), 'utf8'));
writeFileSync(join(root, 'vendor', 'README.md'),
  `# Vendored libraries\n\n` +
  `- \`exceljs.min.js\`: ExcelJS ${version} (MIT, see \`exceljs.LICENSE.txt\`), browser build from the npm package ` +
  `\`exceljs@${version}\` (\`dist/exceljs.min.js\`) with the source-map comment removed. ` +
  `Loaded on demand by the Import / Export tab; it makes no network requests.\n\n` +
  `To refresh: \`npm install\` then \`npm run vendor\`.\n`);
console.log(`vendor/exceljs.min.js <- exceljs ${version} (${js.length} bytes)`);
