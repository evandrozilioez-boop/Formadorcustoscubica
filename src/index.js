// Worker unificado: serve assets estaticos e roteia /api/* (login + state).
import { verifyToken, signToken, json, options } from '../functions/_lib/auth.js';
import postgres from 'postgres';

async function handleLogin(request, env) {
  if (request.method === 'OPTIONS') return options();
  if (request.method !== 'POST') return json({ message: 'Metodo nao permitido' }, 405);

  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'JSON invalido' }, 400); }

  const { email, senha } = body || {};
  if (!email || email !== env.AUTH_EMAIL || senha !== env.AUTH_PASSWORD) {
    return json({ message: 'Credenciais invalidas' }, 401);
  }

  const accessToken = await signToken({ sub: email, email, role: 'admin' }, env);
  return json({ accessToken, usuario: { email } });
}

async function handleState(request, env, ctx) {
  if (request.method === 'OPTIONS') return options();

  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!(await verifyToken(token, env))) return json({ message: 'Nao autorizado' }, 401);

  if (!env.HYPERDRIVE || !env.HYPERDRIVE.connectionString) {
    return json({ message: 'PostgreSQL/Hyperdrive nao configurado (binding HYPERDRIVE)' }, 500);
  }

  const url = new URL(request.url);
  const chave = url.searchParams.get('chave') || 'default';
  const sql = postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false });

  try {
    if (request.method === 'GET') {
      const rows = await sql`SELECT data, "updatedAt" FROM app_state WHERE chave = ${chave}`;
      const row = rows[0];
      return json({ chave, data: row ? row.data : null, updatedAt: row ? row.updatedAt : null });
    }

    if (request.method === 'PUT') {
      let body;
      try { body = await request.json(); } catch (e) { return json({ message: 'JSON invalido' }, 400); }
      const key = body.chave || chave;
      const data = body.data || {};
      const rows = await sql`
        INSERT INTO app_state (chave, data, "updatedAt")
        VALUES (${key}, ${sql.json(data)}, now())
        ON CONFLICT (chave) DO UPDATE SET data = EXCLUDED.data, "updatedAt" = now()
        RETURNING "updatedAt"`;
      return json({ chave: key, updatedAt: rows[0].updatedAt });
    }

    return json({ message: 'Metodo nao permitido' }, 405);
  } catch (e) {
    return json({ message: 'Erro no banco: ' + (e && e.message ? e.message : String(e)) }, 500);
  } finally {
    ctx.waitUntil(sql.end());
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/auth/login') return handleLogin(request, env);
    if (url.pathname === '/api/state') return handleState(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
};
