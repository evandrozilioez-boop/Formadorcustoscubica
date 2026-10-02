# Segurança — sem Cloudflare Access

A proteção agora fica **no próprio app**, sem depender do Cloudflare Access:

- **Login por e-mail e senha**, validado **no servidor** contra a tabela `usuarios` do PostgreSQL.
- **Senhas com hash** (PBKDF2‑SHA256 + salt por usuário) — nunca em texto puro nem no navegador.
- Após o login, o servidor emite um **token JWT** (assinado com `JWT_SECRET`) que autoriza as chamadas de dados.
- **Única rota pública** é `/api/auth/login`. Todo o resto (`/api/state`, `/api/users`) exige o token.

## Como funciona
1. A pessoa abre o site → cai na **tela de login** do app.
2. Digita e-mail + senha → o servidor confere o hash no banco → devolve o token da sessão.
3. Com o token, o app carrega e salva os dados. Sem token válido, a API responde **401**.

## Configuração (variáveis no projeto → Settings → Variables)
- `JWT_SECRET` = um texto **aleatório e longo** (obrigatório; sem ele os tokens ficam previsíveis).
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` = (opcional) admin inicial. Se não definir, usa `admin@artecubica.com.br` / `admin`.
- Mantenha o binding **`HYPERDRIVE`** e a flag **`nodejs_compat`**.
- **Não** são mais necessárias: `ACCESS_TEAM`, `ACCESS_AUD`, `OPEN_SESSION` (pode remover).

## Desligar o Cloudflare Access (importante)
Se o site ainda estiver protegido pelo Access, ele vai continuar pedindo login do Cloudflare antes do app. Para remover:
- **Zero Trust → Access → Applications** → abra a aplicação de `artecubica.app` → **Delete** (ou remova o domínio dela).

## Acesso somente consulta
- Perfis com **"Pode editar dados" desmarcado** (ex.: **Consulta**, criado automaticamente, e **Vendedor**) só visualizam: no app os botões de alteração somem e os campos ficam travados; continuam liberados busca, filtros, simulador, impressão e exportação para Excel.
- O **servidor também recusa** (`403`) qualquer gravação em `/api/state` vinda desses perfis, mesmo que alguém tente pelo navegador.
- Para dar acesso de consulta: **Configurações → Usuários → Novo usuário**, perfil **Consulta**. Os menus visíveis ajustam-se em **Permissões de menu**.

## Boas práticas
- **Troque a senha do admin** logo no primeiro acesso (Configurações → Usuários).
- Cadastre um usuário por pessoa; use senhas fortes.
- Backups: confira a política do seu Postgres (PlanetScale/Neon) no painel.
- (Opcional, reforço) dá para adicionar limite de tentativas de login para dificultar força bruta — me peça se quiser.

## Teste
- `https://SEU-SITE/api/state` sem token → **401 Não autorizado**.
- Abrir o site → tela de login → entrar com e-mail/senha → funciona.
- Entrar com um usuário de perfil **Consulta** → aparece o selo "👁 somente consulta" e não há botões de alteração.
