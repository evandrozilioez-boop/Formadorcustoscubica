// GET/PUT /api/state → lê e grava o estado do app no PostgreSQL (via Cloudflare Hyperdrive).
import postgres from 'postgres';
import { verifyToken, json, options } from '../_lib/auth.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return options();

  // Autorização (Bearer token emitido por /api/auth/login)
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!(await verifyToken(token, env))) return json({ message: 'Não autorizado' }, 401);

  if (!env.HYPERDRIVE || !env.HYPERDRIVE.connectionString) {
    return json({ message: 'PostgreSQL/Hyperdrive não configurado (binding HYPERDRIVE)' }, 500);
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
      try { body = await request.json(); } catch (e) { return json({ message: 'JSON inválido' }, 400); }
      const key = body.chave || chave;
      const data = body.data || {};
      const rows = await sql`
        INSERT INTO app_state (chave, data, "updatedAt")
        VALUES (${key}, ${sql.json(data)}, now())
        ON CONFLICT (chave) DO UPDATE SET data = EXCLUDED.data, "updatedAt" = now()
        RETURNING "updatedAt"`;
      return json({ chave: key, updatedAt: rows[0].updatedAt });
    }

    return json({ message: 'Método não permitido' }, 405);
  } catch (e) {
    return json({ message: 'Erro no banco: ' + (e && e.message ? e.message : String(e)) }, 500);
  } finally {
    context.waitUntil(sql.end());
  }
}
