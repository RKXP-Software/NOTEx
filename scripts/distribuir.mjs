// Copia o instalador e o APK da versão atual para distribuicao/v<versão>/ (histórico por versão).
// Uso: npm run distribuir   (depois de `npm run tauri build` e `npm run apk`)
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const versao = JSON.parse(readFileSync("package.json", "utf8")).version;
const destino = join("distribuicao", `v${versao}`);
const origens = [
  [join("src-tauri", "target", "release", "bundle", "nsis", `NOTEx_${versao}_x64-setup.exe`), `NOTEx-${versao}-Windows-Instalador.exe`],
  [join("src-tauri", "gen", "android", "app", "build", "outputs", "apk", "universal", "release", "app-universal-release.apk"), `NOTEx-${versao}-Android.apk`],
];

mkdirSync(destino, { recursive: true });
for (const [de, nome] of origens) {
  if (!existsSync(de)) {
    console.warn(`Não encontrado (pulado): ${de}`);
    continue;
  }
  copyFileSync(de, join(destino, nome));
  console.log(`${destino}/${nome}`);
}
