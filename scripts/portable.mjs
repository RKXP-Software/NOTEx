// Monta a versão portátil (zip): notex.exe + arquivo "portable" (liga o modo portátil) + LEIA-ME.
// Uso: npm run portable   (depois de `npm run tauri build`; grava em distribuicao/v<versão>/)
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const versao = JSON.parse(readFileSync("package.json", "utf8")).version;
const exe = join("src-tauri", "target", "release", "notex.exe");
if (!existsSync(exe)) throw new Error(`Falta ${exe}: rode npm run tauri build antes.`);

const destino = join("distribuicao", `v${versao}`);
const pasta = join("distribuicao", ".portable-tmp", "NOTEx-Portatil");
rmSync(join("distribuicao", ".portable-tmp"), { recursive: true, force: true });
mkdirSync(pasta, { recursive: true });
mkdirSync(destino, { recursive: true });

copyFileSync(exe, join(pasta, "NOTEx.exe"));
writeFileSync(join(pasta, "portable"), "Este arquivo liga o modo portátil do NOTEx. Não apague.\r\n");
writeFileSync(
  join(pasta, "LEIA-ME.txt"),
  [
    `NOTEx ${versao} — versão portátil`,
    "",
    "Não precisa instalar: abra NOTEx.exe.",
    "Tudo fica na pasta 'Dados' ao lado do programa (configuração, sessão e cadernos),",
    "então você pode levar a pasta inteira num pendrive ou copiá-la para outro PC.",
    "",
    "O arquivo 'portable' precisa ficar ao lado do NOTEx.exe. Sem ele, o programa usa",
    "as pastas do usuário (como a versão instalada).",
    "Requer o WebView2 (já vem no Windows 10/11 atualizado).",
    "",
  ].join("\r\n"),
);

const zip = resolve(destino, `NOTEx-${versao}-Windows-Portatil.zip`);
rmSync(zip, { force: true });
execFileSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${resolve(pasta)}' -DestinationPath '${zip}'`], { stdio: "inherit" });
rmSync(join("distribuicao", ".portable-tmp"), { recursive: true, force: true });
console.log(zip);
