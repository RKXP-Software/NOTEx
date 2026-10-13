// Gera o instalador do Windows que ATUALIZA por cima de uma instalação existente, sem pedir para
// desinstalar antes.
//
// O instalador padrão do Tauri, ao achar o NOTEx já instalado, mostra uma página "desinstalar antes
// de instalar" (marcada por padrão). Aqui o roteiro NSIS gerado pelo Tauri é ajustado: se a versão
// instalada for igual ou mais antiga, entra no "modo atualização" (o mesmo da atualização
// automática do Tauri): sem página, sem desinstalar, arquivos substituídos no mesmo lugar, e
// configuração e notas intactas. Versão mais nova instalada (downgrade) continua perguntando.
//
// Uso: npm run instalador          (compila o app, ajusta o roteiro e gera o instalador)
//      npm run instalador -- --so-ajustar   (só ajusta e refaz o instalador, sem recompilar)

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
if (!process.argv.includes("--so-ajustar")) {
  const r = spawnSync(npx, ["tauri", "build"], { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const nsi = join("src-tauri", "target", "release", "nsis", "x64", "installer.nsi");
if (!existsSync(nsi)) throw new Error(`Roteiro do instalador não encontrado: ${nsi}`);

const MARCA = "; NOTEx: atualizar por cima";
let texto = readFileSync(nsi, "utf8");
if (!texto.includes(MARCA)) {
  const original = "  ${If} $PassiveMode = 1\n    Call PageLeaveReinstall\n  ${Else}\n    nsDialogs::Create 1018";
  const novo =
    `  ${MARCA}: já instalado em versão igual ou mais antiga (não é a migração do WiX) entra no modo\n` +
    "  ; atualização, que pula a página e não desinstala nada.\n" +
    "  ${If} $WixMode <> 1\n" +
    "  ${AndIf} $R0 <> -1\n" +
    "    StrCpy $UpdateMode 1\n" +
    "  ${EndIf}\n" +
    "  ${If} $PassiveMode = 1\n" +
    "  ${OrIf} $UpdateMode = 1\n" +
    "    Call PageLeaveReinstall\n" +
    "  ${Else}\n    nsDialogs::Create 1018";
  const eol = texto.includes("\r\n") ? "\r\n" : "\n";
  const alvo = original.split("\n").join(eol);
  if (!texto.includes(alvo)) {
    throw new Error("O roteiro do instalador mudou (nova versão do Tauri?): ajuste scripts/instalador.mjs.");
  }
  texto = texto.replace(alvo, novo.split("\n").join(eol));
  writeFileSync(nsi, texto, "utf8"); // mantém o BOM UTF-8 que já existe no texto lido
}

const nsisDir = join(process.env.LOCALAPPDATA ?? "", "tauri", "NSIS");
const makensis = join(nsisDir, "makensis.exe");
if (!existsSync(makensis)) throw new Error(`makensis não encontrado em ${makensis}`);
// O roteiro grava "nsis-output.exe" na pasta de trabalho; o Tauri depois move para bundle/nsis.
const versao = JSON.parse(readFileSync("package.json", "utf8")).version;
const destino = join("src-tauri", "target", "release", "bundle", "nsis", `NOTEx_${versao}_x64-setup.exe`);
execFileSync(makensis, ["-INPUTCHARSET", "UTF8", "-OUTPUTCHARSET", "UTF8", "-V2", "installer.nsi"], {
  stdio: "inherit",
  cwd: dirname(nsi),
  env: { ...process.env, NSISDIR: nsisDir, NSISCONFDIR: nsisDir },
});
const gerado = join(dirname(nsi), "nsis-output.exe");
copyFileSync(gerado, destino);
rmSync(gerado, { force: true });
console.log("Instalador gerado com atualização automática por cima.");
