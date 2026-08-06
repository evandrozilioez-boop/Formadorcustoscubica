// Worker único: API (/api/*) + arquivos estáticos (binding ASSETS -> pasta public).
import postgres from 'postgres';

/* ---------- Auth: JWT HS256 via Web Crypto ---------- */
const enc = new TextEncoder();
function b64urlStr(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlBuf(buf) {
  let s = ''; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmac(data, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return b64urlBuf(sig);
}
async function signToken(payload, env) {
  const secret = env.JWT_SECRET || 'dev-secret';
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 8 };
  const h = b64urlStr(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64urlStr(JSON.stringify(body));
  const data = h + '.' + p;
  return data + '.' + (await hmac(data, secret));
}
async function verifyToken(token, env) {
  try {
    if (!token) return false;
    const secret = env.JWT_SECRET || 'dev-secret';
    const parts = token.split('.'); if (parts.length !== 3) return false;
    const [h, p, s] = parts;
    if ((await hmac(h + '.' + p, secret)) !== s) return false;
    const payload = JSON.parse(decodeURIComponent(escape(atob(p.replace(/-/g, '+').replace(/_/g, '/')))));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch (e) { return false; }
}
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith('/api/')) {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

      // POST /api/auth/login
      if (path === '/api/auth/login') {
        if (request.method !== 'POST') return json({ message: 'Método não permitido' }, 405);
        let body; try { body = await request.json(); } catch (e) { return json({ message: 'JSON inválido' }, 400); }
        const { email, senha } = body || {};
        if (!email || email !== env.AUTH_EMAIL || senha !== env.AUTH_PASSWORD) return json({ message: 'Credenciais inválidas' }, 401);
        return json({ accessToken: await signToken({ sub: email, email, role: 'admin' }, env), usuario: { email } });
      }

      // GET /api/session (conexão automática — liberada por padrão)
      if (path === '/api/session') {
        // Para blindar: defina REQUIRE_ACCESS=1 e proteja o site com Cloudflare Access.
        const requireAccess = env.REQUIRE_ACCESS === '1';
        const accessJwt = request.headers.get('Cf-Access-Jwt-Assertion');
        if (requireAccess && !accessJwt) return json({ message: 'Acesso exigido (Cloudflare Access).' }, 403);
        const email = request.headers.get('Cf-Access-Authenticated-User-Email') || env.AUTH_EMAIL || 'auto@local';
        return json({ accessToken: await signToken({ sub: email, email, role: 'admin' }, env), usuario: { email } });
      }

      // GET/PUT /api/state (PostgreSQL via Hyperdrive)
      if (path === '/api/state') {
        const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
        if (!(await verifyToken(token, env))) return json({ message: 'Não autorizado' }, 401);
        if (!env.HYPERDRIVE || !env.HYPERDRIVE.connectionString) return json({ message: 'PostgreSQL/Hyperdrive não configurado' }, 500);
        const chave = url.searchParams.get('chave') || 'default';
        const sql = postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false });
        try {
          if (request.method === 'GET') {
            const rows = await sql`SELECT data, "updatedAt" FROM app_state WHERE chave = ${chave}`;
            const row = rows[0];
            return json({ chave, data: row ? row.data : null, updatedAt: row ? row.updatedAt : null });
          }
          if (request.method === 'PUT') {
            let body; try { body = await request.json(); } catch (e) { return json({ message: 'JSON inválido' }, 400); }
            const key = body.chave || chave; const data = body.data || {};
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
          ctx.waitUntil(sql.end());
        }
      }

      return json({ message: 'Rota não encontrada' }, 404);
    }

    // Demais rotas → arquivos estáticos (public) via ASSETS
    return env.ASSETS.fetch(request);
  },
};
