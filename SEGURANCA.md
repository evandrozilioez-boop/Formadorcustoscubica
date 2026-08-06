# Segurança — deixar o sistema realmente protegido

Nenhum sistema é 100% "inviolável", mas com os passos abaixo você chega a um nível **empresarial**: só quem você autorizar (por e-mail, com verificação de identidade) consegue abrir o site ou acessar os dados. Qualquer outra pessoa recebe **Acesso negado**.

A proteção tem 3 camadas:

## Camada 1 — Cloudflare Access (a porta de entrada)
Coloca o site inteiro atrás de login corporativo (Google, Microsoft ou código por e-mail). Quem não estiver na lista **nem carrega a página**.

1. No painel Cloudflare → **Zero Trust** (Access).
2. **Access → Applications → Add an application → Self-hosted**.
3. **Application domain:** o domínio do seu site (ex.: `precificador.pages.dev` ou o seu domínio próprio).
4. **Policies:** crie uma política **Allow** com a regra **Emails** (ou **Emails ending in @suaempresa.com.br**) listando quem pode entrar.
5. Salve. Anote o **Application Audience (AUD) Tag** (aparece na aba **Overview** da aplicação) e o **Team domain** (o prefixo em `SEU-TIME.cloudflareaccess.com`, em Zero Trust → Settings → Custom Pages / General).

## Camada 2 — A API só confia em quem passou pelo Access
O Worker (`src/index.js`) já vem preparado: ele **valida a assinatura** do token do Cloudflare Access em cada chamada de API. Configure as variáveis no projeto (Settings → Variables and Secrets):

- `ACCESS_TEAM` = o prefixo do seu time (ex.: `suaempresa`, de `suaempresa.cloudflareaccess.com`)
- `ACCESS_AUD` = o **Application Audience (AUD) Tag** copiado no passo anterior
- `JWT_SECRET` = um texto **aleatório e longo** (obrigatório — não deixe em branco)
- **Remova** `OPEN_SESSION` (ou deixe diferente de `1`). Com `OPEN_SESSION=1` a API fica **aberta** — use só para teste.

Depois faça **Retry deployment**.

Como fica: sem um token de Access válido, **toda** rota `/api/*` responde **403 (Acesso negado)**. Com Access ativo, o navegador do usuário autorizado envia o token automaticamente e tudo funciona.

## Autenticação de usuários (no servidor, com hash)
O login do app agora é validado **no servidor**: os usuários ficam na tabela `usuarios` do PostgreSQL, com **senha protegida por hash (PBKDF2‑SHA256, com salt por usuário)** — nunca em texto puro nem no navegador.

- O **admin inicial** é criado automaticamente na primeira tentativa de login. Defina (opcional) as variáveis `ADMIN_EMAIL` e `ADMIN_PASSWORD` no projeto; se não definir, usa `admin@artecubica.com.br` / `admin`. **Troque a senha assim que entrar.**
- Cadastro/edição/exclusão de usuários (Configurações → Usuários) grava direto no banco (apenas administradores).
- Observação: no ambiente edge (Worker) usa‑se PBKDF2 (nativo, seguro) em vez do bcrypt, que estoura o limite de CPU do Worker. Se preferir bcrypt literal, o backend Node (pasta `../backend`) já usa bcrypt e pode hospedar a autenticação em Railway/Render.

## Camada 3 — Boas práticas
- **HTTPS**: já é automático na Cloudflare.
- **Senhas do app**: a tela de login do app e os perfis são para organizar quem vê o quê **dentro** do sistema — a segurança de verdade é o Access (camada 1). Evite reaproveitar senhas importantes ali.
- **Backups**: confira a política de backup do seu Postgres (PlanetScale/Neon) no painel.
- **Menos gente com acesso**: mantenha a lista do Access enxuta; remova quem sai da empresa.

## Teste rápido
- Abra `https://SEU-SITE/api/state` **sem estar logado no Access** → deve dar **403** (antes dava `{"message":"Não autorizado"}` ou 401 — agora é bloqueado antes).
- Abrindo o site normalmente (logado no Access) → o app conecta e funciona.

> Resumo: **Cloudflare Access + `ACCESS_TEAM`/`ACCESS_AUD` + `JWT_SECRET` forte + sem `OPEN_SESSION`**. Isso fecha os furos e deixa o acesso restrito só a quem você autorizar.
