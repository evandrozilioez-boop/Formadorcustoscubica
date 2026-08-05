# Precificador — 100% Cloudflare (com PostgreSQL)

Solução inteira na Cloudflare, com **PostgreSQL de verdade**:

- **Frontend:** Cloudflare **Pages** (o app em `public/index.html`).
- **API:** Cloudflare **Pages Functions** (Workers no edge) em `functions/api/*` — mesma origem do app, sem CORS.
- **Banco:** **PostgreSQL** acessado via Cloudflare **Hyperdrive** (pooling + cache). O Postgres pode ser o **PlanetScale Postgres faturado pela própria Cloudflare** (criado dentro do painel da Cloudflare) ou outro Postgres gerenciado (Neon, Supabase, RDS…).

O mesmo app já fala com esta API (`/api/auth/login` e `/api/state`), então nada muda no frontend.

## Estrutura

```
precificador-cloudflare/
  public/
    index.html          # o app (Cloudflare Pages serve isto)
    _headers
  functions/
    _lib/auth.js        # JWT (HS256) + CORS
    api/auth/login.js   # POST /api/auth/login
    api/state.js        # GET/PUT /api/state (grava no Postgres via Hyperdrive)
  schema.sql            # tabela app_state (rodar 1x no Postgres)
  wrangler.toml         # bindings (Hyperdrive) e flags
  package.json          # dependência: postgres (driver)
```

## Passo a passo

### 1) Subir no GitHub
GitHub Desktop → Add Local Repository → esta pasta → Create → Commit → **Publish repository** (Private).

### 2) Criar o PostgreSQL na Cloudflare (PlanetScale Postgres)
No painel da Cloudflare: **Storage & Databases → Database → Create → PlanetScale Postgres** (faturado pela sua conta Cloudflare). Ou use um Postgres gerenciado que você já tenha.
Guarde a **connection string** do banco.

### 3) Criar a tabela
Rode o `schema.sql` no banco (console do PlanetScale, ou `psql "<connection-string>" -f schema.sql`).

### 4) Criar o Hyperdrive (aponta para o Postgres)
- Painel: **Storage & Databases → Hyperdrive → Create configuration** e cole a connection string do Postgres. Copie o **Hyperdrive ID**.
- Cole o id em `wrangler.toml` (campo `id` do bloco `[[hyperdrive]]`).

### 5) Publicar no Cloudflare Pages
- **Workers & Pages → Create → Pages → Connect to Git** e selecione o repositório.
- Build: **Build command** `npm install` · **Build output directory** `public`.
- Em **Settings → Functions**:
  - **Compatibility flags:** `nodejs_compat`
  - **Bindings → Hyperdrive:** adicione `HYPERDRIVE` apontando para o Hyperdrive criado.
  - **Environment variables (Secrets):**
    - `JWT_SECRET` = um segredo forte e aleatório (obrigatório)
    - `OPEN_SESSION` = `1` → liga a **conexão automática** (abre e já conecta)
    - `AUTH_EMAIL` / `AUTH_PASSWORD` = opcionais (só para o login manual por senha)

### 6) Conectar — automático (recomendado)
Com `OPEN_SESSION=1`, **basta abrir** `https://SEU-PROJETO.pages.dev` em qualquer navegador ou dispositivo: o app conecta sozinho ao banco (indicador ☁ = "conectado"), sem configurar nada. É isso que evita ficar "offline" em outro navegador.

> **Segurança:** com `OPEN_SESSION=1`, quem tiver o link consegue ler/gravar os dados — ok para uso interno com link privado. Para proteger de verdade **mantendo o automático**, ative **Cloudflare Access** no projeto Pages e libere só os e-mails da equipe (aí pode até remover `OPEN_SESSION`).

### 6b) Conexão manual (alternativa)
Sem sessão automática: defina `AUTH_EMAIL`/`AUTH_PASSWORD` e, no app, **Configurações → ☁ Nuvem** → informe a URL do site + esse e-mail/senha → **Salvar & Conectar** (fica salvo por navegador).

## Observações

- Como API e app ficam no mesmo domínio (Pages), **não há problema de CORS**.
- O estado do app é guardado como **JSONB** na tabela `app_state`. Robusto e rápido para o volume de uma indústria; e o Postgres permite evoluir para tabelas relacionais (produtos, materiais, engenharia) quando quiser.
- Alternativa ainda mais simples (sem Postgres): trocar por **Cloudflare D1** (SQLite serverless) — 100% nativo e sem dependências. Suficiente para este porte, mas o Postgres é a opção mais robusta para crescer.

## Autenticação
O login da API usa as variáveis `AUTH_EMAIL` / `AUTH_PASSWORD` (uma conta de serviço para o app sincronizar). Os **usuários e perfis do dia a dia** continuam no próprio app (parte dos dados sincronizados).
