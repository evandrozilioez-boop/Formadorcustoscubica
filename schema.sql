-- PostgreSQL (rode uma vez no seu banco, ex.: via psql ou console do PlanetScale)
CREATE TABLE IF NOT EXISTS app_state (
  chave       text        PRIMARY KEY,
  data        jsonb       NOT NULL,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

-- Usuários (autenticação no servidor, senha com hash PBKDF2).
-- O Worker cria esta tabela e o admin inicial automaticamente na 1ª chamada de login,
-- mas você pode criá-la manualmente aqui.
CREATE TABLE IF NOT EXISTS usuarios (
  id           text PRIMARY KEY,
  nome         text NOT NULL,
  email        text UNIQUE NOT NULL,
  senha_hash   text NOT NULL,
  cargo        text,
  departamento text,
  perfil       text DEFAULT 'vendedor',
  admin        boolean DEFAULT false,
  status       text DEFAULT 'Ativo',
  created_at   timestamptz DEFAULT now()
);
