import { readFileSync, writeFileSync } from 'node:fs';
import * as ResEdit from 'resedit';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const exePath = new URL('../release/win-unpacked/Pixel Conquest.exe', import.meta.url);
const exe = ResEdit.NtExecutable.from(readFileSync(exePath), { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(exe);

const iconFile = ResEdit.Data.IconFile.from(readFileSync(new URL('../build/icon.ico', import.meta.url)));
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const groupId = groups.length ? groups[0].id : 1;
const lang = groups.length ? groups[0].lang : 1033;
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, iconFile.icons.map((i) => i.data));

const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
if (vi) {
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  vi.setFileVersion(major, minor, patch, 0);
  vi.setProductVersion(major, minor, patch, 0);
  for (const l of vi.getAllLanguagesForStringValues()) {
    vi.setStringValues(l, {
      ProductName: 'Pixel Conquest',
      FileDescription: 'Pixel Conquest',
      CompanyName: 'NICE_STUD',
      LegalCopyright: '© 2026 NICE_STUD',
      OriginalFilename: 'Pixel Conquest.exe',
      InternalName: 'Pixel Conquest',
      FileVersion: pkg.version,
      ProductVersion: pkg.version,
    });
  }
  vi.outputToResourceEntries(res.entries);
}
res.outputResource(exe);
writeFileSync(exePath, Buffer.from(exe.generate()));
console.log('exe patched');
