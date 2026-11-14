// Copies the page from public/ into dist/ for GitHub Pages and adds a content version to the scripts and styles,
// so a browser never combines new HTML with an old cached script. Data comes from the Cloudflare Worker.
//  - index.html: the page with the tabs "Стан", "Паливо та ТО", "Генератор" (app.js, generator.js + generator-lib.js, styles.css)
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
export async function buildPages(directory = path.join(root, 'dist')) {
  await mkdir(directory, { recursive: true });
  const pub = name => path.join(root, 'public', name);

  // The tabs script imports generator-lib.js: the import is versioned too (a module is cached by its address).
  const lib = await readFile(pub('generator-lib.js'));
  const tabsScript = (await readFile(pub('generator.js'), 'utf8'))
    .replace("from './generator-lib.js'", "from './generator-lib.js?v=" + version(lib) + "'");
  await writeFile(path.join(directory, 'generator.js'), tabsScript);

  let html = await readFile(pub('index.html'), 'utf8');
  for (const asset of ['app.js', 'styles.css']) {
    html = html.replace('./' + asset + '"', './' + asset + '?v=' + version(await readFile(pub(asset))) + '"');
  }
  html = html.replace('./generator.js"', './generator.js?v=' + version(tabsScript) + '"');
  await writeFile(path.join(directory, 'index.html'), html);

  for (const name of ['app.js', 'styles.css', 'generator-lib.js', 'favicon.svg', 'iphone-step-1.png', 'iphone-step-2.png', 'iphone-step-3.png'])
    await copyFile(pub(name), path.join(directory, name));
  await writeFile(path.join(directory, '.nojekyll'), '');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildPages();
  console.log('Сторінки підготовлено в папці dist.');
}
