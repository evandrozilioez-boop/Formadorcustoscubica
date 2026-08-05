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
    - `AUTH_EMAIL` = e-mail para login na API (ex.: `admin@artecubica.com.br`)
    - `AUTH_PASSWORD` = senha da API
    - `JWT_SECRET` = um segredo forte e aleatório

### 6) Conectar o app ao banco
Abra o app publicado (`https://SEU-PROJETO.pages.dev`) → **Configurações → ☁ Nuvem / Banco de Dados**:
- **URL da API:** a própria URL do site (ex.: `https://SEU-PROJETO.pages.dev`)
- **E-mail / Senha:** os mesmos de `AUTH_EMAIL` / `AUTH_PASSWORD`
- **Salvar & Conectar** → o indicador ☁ deve ficar "conectado" e os dados passam a ser gravados no PostgreSQL.

## Observações

- Como API e app ficam no mesmo domínio (Pages), **não há problema de CORS**.
- O estado do app é guardado como **JSONB** na tabela `app_state`. Robusto e rápido para o volume de uma indústria; e o Postgres permite evoluir para tabelas relacionais (produtos, materiais, engenharia) quando quiser.
- Alternativa ainda mais simples (sem Postgres): trocar por **Cloudflare D1** (SQLite serverless) — 100% nativo e sem dependências. Suficiente para este porte, mas o Postgres é a opção mais robusta para crescer.

## Autenticação
O login da API usa as variáveis `AUTH_EMAIL` / `AUTH_PASSWORD` (uma conta de serviço para o app sincronizar). Os **usuários e perfis do dia a dia** continuam no próprio app (parte dos dados sincronizados).
