// Sets the Windows .exe icon and version info without Wine (pure JS, resedit).
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const ResEdit = await import('resedit');
  const PE = await import('pe-library');
  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  let exe = path.join(context.appOutDir, exeName);
  if (!fs.existsSync(exe)) {
    const alt = fs.readdirSync(context.appOutDir).find((f) => f.toLowerCase().endsWith('.exe') && !/uninstall/i.test(f));
    exe = path.join(context.appOutDir, alt);
  }
  const data = fs.readFileSync(exe);
  const pe = PE.NtExecutable.from(data, { ignoreCert: true });
  const res = PE.NtExecutableResource.from(pe);
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, ico.icons.map((i) => i.data));
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  if (vi) {
    const v = context.packager.appInfo.version.split('.').map(Number);
    vi.setFileVersion(v[0], v[1], v[2], 0, 1033);
    vi.setProductVersion(v[0], v[1], v[2], 0, 1033);
    vi.setStringValues({ lang: 1033, codepage: 1200 }, {
      FileDescription: 'Chimpanzé Wallpapers',
      ProductName: 'Chimpanzé Wallpapers',
      CompanyName: 'João Victor de Macedo',
      OriginalFilename: path.basename(exe),
      InternalName: 'ChimpanzeWallpapers',
      LegalCopyright: '© João Victor de Macedo',
    });
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(pe);
  fs.writeFileSync(exe, Buffer.from(pe.generate()));
  console.log('  • afterPack: ícone e versão aplicados em', path.basename(exe));
};
