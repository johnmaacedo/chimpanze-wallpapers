'use strict';
// Builds the optional AI packages the app downloads (electron/components.js) from
// resources/models and resources/bin, into release/ai/*.zip, and writes their sizes to
// electron/components-sizes.json. Upload the zips to the GitHub release "modelos-ia-1".
//   node build/make-ai-packages.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { LIST } = require('../electron/components');

const root = path.join(__dirname, '..');
const res = path.join(root, 'resources');
const out = path.join(root, 'release', 'ai');
fs.mkdirSync(out, { recursive: true });
const sizes = {};
for (const [id, c] of Object.entries(LIST)) {
  const entries = [...c.models.map((m) => `models/${m}`), ...c.bins.map((b) => `bin/${b}`)];
  for (const e of entries) if (!fs.existsSync(path.join(res, e))) throw new Error(`Falta ${e} em resources/ (copie da instalação).`);
  const zip = path.join(out, c.asset);
  fs.rmSync(zip, { force: true });
  // Windows' tar (bsdtar) writes zip files and the app unpacks them with the same tool.
  const tar = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe');
  execFileSync(tar, ['-a', '-cf', zip, '-C', res, ...entries], { stdio: 'inherit' });
  sizes[c.asset] = fs.statSync(zip).size;
  console.log(id.padEnd(8), c.asset.padEnd(28), Math.round(sizes[c.asset] / 1048576), 'MB');
}
fs.writeFileSync(path.join(root, 'electron', 'components-sizes.json'), JSON.stringify(sizes, null, 2) + '\n');
