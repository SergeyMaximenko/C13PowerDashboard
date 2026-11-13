// Copies the pages from public/ into dist/ for GitHub Pages and adds a content version to the scripts and styles,
// so a browser never combines new HTML with an old cached script. Data comes from the Cloudflare Worker.
//  - index.html: the main page (app.js, styles.css)
//  - generator.html: the separate generator report (generator.js imports generator-lib.js, generator.css)
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
export async function buildPages(directory = path.join(root, 'dist')) {
  await mkdir(directory, { recursive: true });
  const pub = name => path.join(root, 'public', name);

  let html = await readFile(pub('index.html'), 'utf8');
  for (const asset of ['app.js', 'styles.css']) {
    html = html.replace('./' + asset + '"', './' + asset + '?v=' + version(await readFile(pub(asset))) + '"');
  }
  await writeFile(path.join(directory, 'index.html'), html);

  // The report page: the import inside generator.js is versioned too (a module is cached by its address).
  const lib = await readFile(pub('generator-lib.js'));
  const script = (await readFile(pub('generator.js'), 'utf8'))
    .replace("from './generator-lib.js'", "from './generator-lib.js?v=" + version(lib) + "'");
  await writeFile(path.join(directory, 'generator.js'), script);
  let report = await readFile(pub('generator.html'), 'utf8');
  report = report.replace('./generator.js"', './generator.js?v=' + version(script) + '"')
    .replace('./generator.css"', './generator.css?v=' + version(await readFile(pub('generator.css'))) + '"');
  await writeFile(path.join(directory, 'generator.html'), report);

  for (const name of ['app.js', 'styles.css', 'generator-lib.js', 'generator.css', 'favicon.svg', 'iphone-step-1.png', 'iphone-step-2.png', 'iphone-step-3.png'])
    await copyFile(pub(name), path.join(directory, name));
  await writeFile(path.join(directory, '.nojekyll'), '');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildPages();
  console.log('Сторінки підготовлено в папці dist.');
}
