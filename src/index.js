// Worker único: API (/api/*) + arquivos estáticos (binding ASSETS -> pasta public).
// SEGURANÇA: em produção, a API só responde a quem passou pelo Cloudflare Access
// (identidade verificada). Sem Access configurado, a API é negada (403), exceto
// se OPEN_SESSION=1 for definido explicitamente (apenas para testes).
import postgres from 'postgres';

/* ---------- Token da aplicação (JWT HS256 via Web Crypto) ---------- */
const enc = new TextEncoder();
function b64urlStr(str) { return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlBuf(buf) { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlToJson(s) { return JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))))); }
async function hmac(data, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64urlBuf(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
async function signToken(payload, env) {
  const secret = env.JWT_SECRET || 'dev-secret';
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 8 };
  const data = b64urlStr(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' + b64urlStr(JSON.stringify(body));
  return data + '.' + (await hmac(data, secret));
}
async function verifyToken(token, env) {
  try {
    if (!token) return false;
    const secret = env.JWT_SECRET || 'dev-secret';
    const parts = token.split('.'); if (parts.length !== 3) return false;
    if ((await hmac(parts[0] + '.' + parts[1], secret)) !== parts[2]) return false;
    const p = b64urlToJson(parts[1]);
    if (p.exp && p.exp < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch (e) { return false; }
}

/* ---------- Senhas: PBKDF2-SHA256 (Web Crypto) ---------- */
function bufB64(buf) { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64Buf(s) { return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); }
async function hashPassword(senha) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(senha), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return 'pbkdf2$100000$' + bufB64(salt) + '$' + bufB64(bits);
}
async function verifyPassword(senha, stored) {
  try {
    const [alg, iterS, saltS, hashS] = String(stored).split('$');
    if (alg !== 'pbkdf2') return false;
    const key = await crypto.subtle.importKey('raw', enc.encode(senha), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: b64Buf(saltS), iterations: parseInt(iterS, 10), hash: 'SHA-256' }, key, 256);
    return bufB64(bits) === hashS;
  } catch (e) { return false; }
}
/* ---------- Usuários (PostgreSQL) ---------- */
function openSql(env) { return postgres(env.HYPERDRIVE.connectionString, { max: 3, fetch_types: false }); }
async function ensureUsuarios(sql, env) {
  await sql`CREATE TABLE IF NOT EXISTS usuarios (
    id text PRIMARY KEY, nome text NOT NULL, email text UNIQUE NOT NULL, senha_hash text NOT NULL,
    cargo text, departamento text, perfil text DEFAULT 'vendedor', admin boolean DEFAULT false,
    status text DEFAULT 'Ativo', created_at timestamptz DEFAULT now())`;
  const cnt = await sql`SELECT count(*)::int AS n FROM usuarios`;
  if (cnt[0].n === 0) {
    const email = env.ADMIN_EMAIL || 'admin@artecubica.com.br';
    const senha = env.ADMIN_PASSWORD || 'admin';
    await sql`INSERT INTO usuarios (id,nome,email,senha_hash,perfil,admin,status)
      VALUES (${crypto.randomUUID()},'Administrador',${email},${await hashPassword(senha)},'admin',true,'Ativo')`;
  }
}
async function appTokenPayload(request, env) {
  const t = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!(await verifyToken(t, env))) return null;
  try { return b64urlToJson(t.split('.')[1]); } catch (e) { return null; }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
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

      // SEGURANÇA: sem Cloudflare Access. A proteção é o login por senha:
      // /api/auth/login é público (para logar); todo o resto exige o token JWT.

      // POST /api/auth/login → autentica contra a tabela usuarios (senha com hash)
      if (path === '/api/auth/login') {
        if (request.method !== 'POST') return json({ message: 'Método não permitido' }, 405);
        let body; try { body = await request.json(); } catch (e) { return json({ message: 'JSON inválido' }, 400); }
        const { email, senha } = body || {};
        if (!env.HYPERDRIVE || !env.HYPERDRIVE.connectionString) return json({ message: 'Banco não configurado' }, 500);
        const sql = openSql(env);
        try {
          await ensureUsuarios(sql, env);
          const rows = await sql`SELECT * FROM usuarios WHERE lower(email)=lower(${email || ''})`;
          const u = rows[0];
          if (!u || u.status !== 'Ativo' || !(await verifyPassword(senha || '', u.senha_hash))) {
            return json({ message: 'E-mail ou senha inválidos' }, 401);
          }
          const token = await signToken({ sub: u.id, email: u.email, nome: u.nome, role: u.perfil, admin: u.admin }, env);
          return json({ accessToken: token, usuario: { id: u.id, nome: u.nome, email: u.email, perfil: u.perfil, admin: u.admin, role: u.perfil } });
        } finally { ctx.waitUntil(sql.end()); }
      }

      // /api/users → gestão de usuários (apenas admin)
      if (path === '/api/users' || path.startsWith('/api/users/')) {
        const payload = await appTokenPayload(request, env);
        if (!payload) return json({ message: 'Não autorizado' }, 401);
        if (!payload.admin) return json({ message: 'Apenas administrador' }, 403);
        if (!env.HYPERDRIVE || !env.HYPERDRIVE.connectionString) return json({ message: 'Banco não configurado' }, 500);
        const sql = openSql(env);
        try {
          await ensureUsuarios(sql, env);
          if (path === '/api/users' && request.method === 'GET') {
            const rows = await sql`SELECT id,nome,email,cargo,departamento,perfil,admin,status FROM usuarios ORDER BY nome`;
            return json({ usuarios: rows });
          }
          if (path === '/api/users' && request.method === 'POST') {
            const b = await request.json();
            if (!b.nome || !b.email || !b.senha) return json({ message: 'Nome, e-mail e senha são obrigatórios' }, 400);
            const dup = await sql`SELECT 1 FROM usuarios WHERE lower(email)=lower(${b.email})`;
            if (dup.length) return json({ message: 'E-mail já cadastrado' }, 409);
            const id = crypto.randomUUID();
            await sql`INSERT INTO usuarios (id,nome,email,senha_hash,cargo,departamento,perfil,admin,status)
              VALUES (${id},${b.nome},${b.email},${await hashPassword(b.senha)},${b.cargo || ''},${b.departamento || ''},${b.perfil || 'vendedor'},${!!b.admin},${b.status || 'Ativo'})`;
            return json({ id });
          }
          const mm = path.match(/^\/api\/users\/(.+)$/);
          if (mm) {
            const id = mm[1];
            if (request.method === 'PUT') {
              const b = await request.json();
              await sql`UPDATE usuarios SET nome=${b.nome},email=${b.email},cargo=${b.cargo || ''},departamento=${b.departamento || ''},perfil=${b.perfil || 'vendedor'},admin=${!!b.admin},status=${b.status || 'Ativo'} WHERE id=${id}`;
              if (b.senha) await sql`UPDATE usuarios SET senha_hash=${await hashPassword(b.senha)} WHERE id=${id}`;
              return json({ ok: true });
            }
            if (request.method === 'DELETE') {
              const alvo = await sql`SELECT admin FROM usuarios WHERE id=${id}`;
              if (alvo[0] && alvo[0].admin) {
                const n = await sql`SELECT count(*)::int AS n FROM usuarios WHERE admin=true AND status='Ativo'`;
                if (n[0].n <= 1) return json({ message: 'Deve existir ao menos um administrador ativo' }, 400);
              }
              await sql`DELETE FROM usuarios WHERE id=${id}`;
              return json({ ok: true });
            }
          }
          return json({ message: 'Rota não encontrada' }, 404);
        } finally { ctx.waitUntil(sql.end()); }
      }

      // GET/PUT /api/state → dados no PostgreSQL (exige o token da aplicação)
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
            const key = body.chave || chave;

            // ---- Modo MERGE: combina só os registros que o usuário mudou (vários usuários ao mesmo tempo) ----
            if (body.merge) {
              const keys = body.merge.keys || {};
              const delta = body.merge.delta || {};
              const updatedAt = await sql.begin(async (sql) => {
                const rows = await sql`SELECT data FROM app_state WHERE chave = ${key} FOR UPDATE`;
                let state = (rows[0] && rows[0].data && typeof rows[0].data === 'object') ? rows[0].data : {};
                // upserts por chave de registro
                const ups = delta.upserts || {};
                for (const col in ups) {
                  const kf = keys[col] || 'id';
                  if (!Array.isArray(state[col])) state[col] = [];
                  const idx = {}; state[col].forEach((r, i) => { if (r && r[kf] != null) idx[r[kf]] = i; });
                  for (const rec of ups[col]) {
                    const k = rec ? rec[kf] : null;
                    if (k != null && idx[k] != null) state[col][idx[k]] = rec;
                    else { state[col].push(rec); if (k != null) idx[k] = state[col].length - 1; }
                  }
                }
                // deleções por chave de registro
                const dels = delta.deletes || {};
                for (const col in dels) {
                  const kf = keys[col] || 'id';
                  if (Array.isArray(state[col])) {
                    const rm = new Set((dels[col] || []).map(String));
                    state[col] = state[col].filter((r) => !(r && rm.has(String(r[kf]))));
                  }
                }
                // campos avulsos (último a salvar vence)
                const sc = delta.scalars || {};
                for (const k in sc) state[k] = sc[k];
                const w = await sql`
                  INSERT INTO app_state (chave, data, "updatedAt")
                  VALUES (${key}, ${sql.json(state)}, now())
                  ON CONFLICT (chave) DO UPDATE SET data = EXCLUDED.data, "updatedAt" = now()
                  RETURNING "updatedAt"`;
                return w[0].updatedAt;
              });
              return json({ chave: key, updatedAt });
            }

            // ---- Modo COMPLETO: substitui todo o estado (migração/backup/forçar envio) ----
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
          ctx.waitUntil(sql.end());
        }
      }

      return json({ message: 'Rota não encontrada' }, 404);
    }

    // Estáticos (public) via ASSETS
    return env.ASSETS.fetch(request);
  },
};
