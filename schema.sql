-- PostgreSQL (rode uma vez no seu banco, ex.: via psql ou console do PlanetScale)
CREATE TABLE IF NOT EXISTS app_state (
  chave       text        PRIMARY KEY,
  data        jsonb       NOT NULL,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
