# NOTEx

Bloco de notas leve para **Windows** e **Android**, com abas em colunas e linhas, cadernos, edição visual e sincronização entre o computador e o celular.

Feito com [Tauri 2](https://tauri.app) (núcleo em Rust, interface web com TypeScript), TipTap (editor visual) e CodeMirror 6 (editor de texto). O instalador do Windows tem cerca de 2,5 MB e o APK cerca de 13 MB.

Site, política de privacidade e termos: <https://rkxp-software.github.io/notex-site/>

## Funcionalidades

- **Cadernos e notas:** cada caderno é uma pasta no disco com arquivos `.md` e `.txt` comuns, que abrem em qualquer outro editor. Há subpastas, ícones por pasta e por caderno (botão direito) e uma lixeira por caderno (`.lixeira`). Apagar nunca remove o arquivo de verdade.
- **Nota rápida:** `Ctrl+N` cria uma nota no caderno "Rápidas", sem pedir nome. Ao terminar a primeira linha, o arquivo é renomeado com ela.
- **Abas em grade:** arraste uma aba para a borda de um painel para dividir em colunas e linhas; os divisores se ajustam arrastando (duplo clique iguala os lados).
- **Editor visual** para `.md` (negrito, itálico, títulos, listas, tarefas, citação, código, links, tabelas, imagens) que grava Markdown; `Ctrl+Shift+M` alterna para o Markdown cru. Os `.txt` abrem como texto puro. Dá para converter `.md` ↔ `.txt` pelo menu da nota.
- **Salvamento automático** e sessão restaurada (abas, grade, zoom, tema). A codificação (UTF-8 ou Windows-1252), o BOM e o fim de linha dos arquivos são preservados.
- **Zoom** do texto (50% a 300%), tema claro e escuro.
- **Escolha onde guardar os cadernos:** pasta padrão configurável, mover um caderno para outra pasta ou adicionar uma pasta existente.

### Sincronização

Os dois caminhos funcionam com o mesmo motor de três vias (versão local, versão remota e a da última sincronização):

| | Como funciona |
|---|---|
| **Conexão direta** | O PC roda um servidor (porta 47800/TCP, descoberta na 47801/UDP). O celular é pareado uma vez por QR code. Funciona na rede local e também por redes mesh (NordVPN Meshnet, Tailscale). As mensagens são cifradas com ChaCha20-Poly1305 usando a chave do QR code, que nunca é transmitida. |
| **Google Drive** | Login no PC pelo navegador (OAuth com PKCE, escopo `drive.file`: o NOTEx só enxerga o que ele mesmo criou). O celular pareado recebe o acesso do PC pelo canal cifrado. Com o Drive ligado, os dois aparelhos sincronizam só por ele. |

Regras comuns: sincroniza ao abrir, depois de cada alteração e quando o outro lado muda. Apagar de um lado apaga do outro (para a lixeira do caderno, ou do Drive). Se a mesma nota for editada nos dois aparelhos, a versão do PC fica no nome original e a outra vira uma cópia `(conflito …)`, sem perder texto. Cadernos, pastas e ícones também são sincronizados.

## Atalhos (desktop)

| Atalho | Ação |
|---|---|
| `Ctrl+N` / `Ctrl+O` / `Ctrl+S` | Nova nota rápida / abrir arquivo / salvar tudo |
| `Ctrl+W`, `Ctrl+Tab`, `Ctrl+PgUp/PgDn` | Fechar aba / trocar de aba |
| `Ctrl+\` / `Ctrl+Shift+\` | Dividir à direita / abaixo |
| `Ctrl+Alt+←/→` | Mover o foco entre painéis |
| `Ctrl+Shift+E` | Mostrar/ocultar a barra lateral |
| `Ctrl+Shift+T` | Alternar tema claro/escuro |
| `Ctrl+Shift+M` | Editor visual ↔ Markdown cru |
| `Ctrl+K` | Inserir/editar link |
| `Ctrl` `+` / `-` / `0`, `Ctrl`+roda | Zoom |
| `Tab` / `Shift+Tab` | Aumentar/diminuir recuo (listas e parágrafos) |
| `F2` | Renomear |

No celular: abas no topo, um painel por vez, barra lateral como gaveta (☰), menus ao pressionar e segurar, e o botão Voltar do Android fecha menu, diálogo e gaveta.

## Instalação

Os instaladores ficam em `distribuicao/v<versão>/` (fora do git; `npm run distribuir` copia os da versão atual, mantendo o histórico):

- **Windows:** `NOTEx-<versão>-Windows-Instalador.exe`. O instalador pergunta se instala **somente para o usuário atual** ou **para todos os usuários**. Na opção "para todos", a configuração fica em `C:\ProgramData\NOTEx` e os cadernos padrão em `C:\Users\Public\Documents\NOTEx`, compartilhados entre os usuários. Rodar o instalador de uma versão nova por cima atualiza a instalação. O desinstalador fica em Configurações → Aplicativos; a opção de apagar dados limpa só a configuração e **nunca apaga as notas**.
- **Android:** `NOTEx-<versão>-Android.apk`, assinado. Copie para o celular e abra (o Android pede para permitir a instalação de fontes desconhecidas). Atualizações precisam ser assinadas com a mesma chave.

Na primeira vez, o Firewall do Windows pode bloquear a conexão direta: libere as portas 47800 (TCP) e 47801 (UDP) para o NOTEx.

## Desenvolvimento

Requisitos: Node.js 20+, Rust estável, e (para o Android) JDK 17, Android SDK e NDK.

```bash
npm install
npm run tauri dev        # app desktop em modo de desenvolvimento
npm run dev              # só a interface, no navegador (com disco simulado)
npm test                 # testes da interface (Vitest)
cd src-tauri && cargo test   # testes do núcleo (Rust)
npm run tauri build      # instalador do Windows em src-tauri/target/release/bundle/nsis
npm run apk              # APK assinado de release (veja o Android abaixo)
npm run icon             # regera os ícones a partir de icons-src/icon.svg
```

### Android

Configure `ANDROID_HOME`, `NDK_HOME` e `JAVA_HOME`. No Windows é preciso ativar o **Modo de Desenvolvedor** (o build cria links simbólicos). O APK de release é assinado com a chave indicada em `src-tauri/gen/android/keystore.properties` (arquivo local, fora do git, que aponta para um `.jks`). Sem esse arquivo o build gera um APK sem assinatura.

### Google Drive

O login precisa de um cliente OAuth do tipo "App para computador" no Google Cloud Console. Grave as credenciais em `src-tauri/google.secret.json` (ignorado pelo git):

```json
{ "client_id": "…apps.googleusercontent.com", "client_secret": "…" }
```

Elas são embutidas no build. Sem esse arquivo, o NOTEx funciona normalmente e só o botão do Google Drive fica indisponível.

### Estrutura

```
src/                 Interface (TypeScript)
  app.ts             Controlador: cadernos, abas, sessão, atalhos
  layout.ts          Grade de painéis (funções puras, testadas)
  doc.ts             Documento aberto e salvamento automático
  editors/           Editor visual (TipTap) e de texto (CodeMirror)
  ui/                Barra lateral, abas, barra de ferramentas, diálogos, painel de sincronização
  dev/               Disco simulado para rodar a interface no navegador
src-tauri/src/       Núcleo (Rust)
  textfile.rs        Leitura/gravação (codificação, BOM, EOL, gravação atômica)
  notebooks.rs       Cadernos, pastas, lixeira, validação de caminhos
  meta.rs            Ícones (.notex.json dentro do caderno)
  sync/              Protocolo, motor de três vias, servidor HTTP, cliente, Google Drive
  sync_app.rs        Integração da sincronização com o app (PC e celular)
src-tauri/windows/   Ganchos do instalador NSIS
tests/               Testes da interface
PLANO.md             Planejamento e situação das fases
```

## Situação

Fases 0 a 4 concluídas (ambiente, desktop, Android, sincronização direta e Google Drive). Versão 0.4.2: correções do Drive e do celular. Próxima: glossário (busca em todos os cadernos e termos com definição). Detalhes em [PLANO.md](PLANO.md).
