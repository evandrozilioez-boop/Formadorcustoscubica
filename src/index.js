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
/* ---------- Merge de 3 vias (campo a campo) ----------
   cur = versão no banco, base = versão que o usuário tinha quando começou a editar,
   loc = versão editada pelo usuário. Só o que ESTE usuário mudou sobrescreve o banco;
   o resto (mudado por outros) é preservado. Mesmo campo mudado pelos dois = vale o último. */
const eqJ = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const idArr = (a) => Array.isArray(a) && a.every((e) => isObj(e) && e.id != null);
function merge3(cur, base, loc) {
  if (eqJ(loc, base)) return cur;      // eu não mudei → fica o do banco
  if (eqJ(cur, base)) return loc;      // só eu mudei
  if (isObj(cur) && isObj(base) && isObj(loc)) {
    const out = {};
    for (const k of new Set([...Object.keys(cur), ...Object.keys(loc), ...Object.keys(base)])) {
      const v = merge3(cur[k], base[k], loc[k]); if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (idArr(cur) && idArr(base) && idArr(loc)) return mergeIdArr(cur, base, loc);
  return loc;                          // os dois mudaram o mesmo campo → vale o último a salvar
}
// Listas de itens com id (ex.: variações): mescla item a item.
function mergeIdArr(cur, base, loc) {
  const m = (a) => new Map(a.map((e) => [String(e.id), e]));
  const C = m(cur), B = m(base), out = [], seen = new Set();
  for (const e of loc) {
    const id = String(e.id); seen.add(id);
    if (B.has(id) && !C.has(id)) { if (!eqJ(e, B.get(id))) out.push(e); continue; } // outro excluiu: some, a menos que eu tenha alterado
    out.push(C.has(id) ? merge3(C.get(id), B.get(id), e) : e);
  }
  for (const e of cur) {
    const id = String(e.id); if (seen.has(id)) continue;
    if (B.has(id) && eqJ(e, B.get(id))) continue; // eu excluí (e ninguém alterou)
    out.push(e);                                   // novo de outro usuário (ou alterado por outro)
  }
  return out;
}
const hasOwn = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

/* ---------- Aprovação da Engenharia (mesma regra do app) ----------
   Perfil com engAprovacao (e sem engAprova/admin) não altera a VERSÃO APROVADA de uma ficha com
   cadastro concluído: o servidor guarda em "aprovado" a versão anterior até um aprovador liberar. */
const numS = (v) => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : 0; }; // igual ao num() do app
const engRowSig = (r) => { const o = {}; Object.keys(r || {}).sort().forEach((x) => { const v = r[x]; if (x === 'id' || x[0] === '_' || v === '' || v == null || v === false) return; o[x] = v; }); return JSON.stringify(o); };
const engTecVazio = (t) => !t || (!t.materialId && !t.materialCod && !numS(t.consumo));
const engTecSig = (t) => engTecVazio(t) ? '' : JSON.stringify({ m: t.materialCod || '', c: String(t.consumo == null ? '' : t.consumo) });
function engNorm(c) {
  const b = {}; Object.keys((c && c.blocos) || {}).sort().forEach((k) => { let rows = (c.blocos[k] || []).map(engRowSig); if (k === 'madeira') rows = rows.sort(); if (rows.length) b[k] = rows; });
  const t = ((c && c.tecidos) || []).filter((x) => !engTecVazio(x)).map((x) => x.classe + '|' + engTecSig(x)).sort();
  return JSON.stringify({ b, t, o: [...((c && c.ocultos) || [])].sort(), m: (c && c.madeiraOrd) || '' });
}
const engConteudo = (e) => JSON.parse(JSON.stringify({ blocos: e.blocos || {}, tecidos: e.tecidos || [], ocultos: e.ocultos || [], madeiraOrd: e.madeiraOrd || '' }));
const engEmCadastro = (e) => !!e && (e.cadastro ? e.cadastro === 'em' : engNorm(e) === engNorm({}));
function exigeAprovacaoEng(state, payload) {
  if (payload.admin) return false;
  const pf = (Array.isArray(state.perfis) ? state.perfis : []).find((p) => p && p.key === payload.role);
  if (!pf || pf.admin) return false;
  // mesmo padrão do app enquanto o perfil ainda não foi configurado: DESENVOLVIMENTO precisa de aprovação; PCP aprova
  const precisa = pf.engAprovacao !== undefined ? pf.engAprovacao : /desenvolv/i.test(pf.nome || '');
  const aprova = pf.engAprova !== undefined ? pf.engAprova : /\bpcp\b/i.test(pf.nome || '');
  return !!(precisa && !aprova);
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

      // POST /api/auth/refresh → renova o token de quem ainda está logado (sessão não expira no meio do trabalho)
      if (path === '/api/auth/refresh') {
        if (request.method !== 'POST') return json({ message: 'Método não permitido' }, 405);
        const payload = await appTokenPayload(request, env);
        if (!payload) return json({ message: 'Não autorizado' }, 401);
        if (!env.HYPERDRIVE || !env.HYPERDRIVE.connectionString) return json({ message: 'Banco não configurado' }, 500);
        const sql = openSql(env);
        try {
          const rows = await sql`SELECT * FROM usuarios WHERE id=${payload.sub}`;
          const u = rows[0];
          if (!u || u.status !== 'Ativo') return json({ message: 'Usuário inativo' }, 401);
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
        const payload = await appTokenPayload(request, env);
        if (!payload) return json({ message: 'Não autorizado' }, 401);
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
            // Perfil "somente consulta" (Pode editar dados = desmarcado) não grava nada no banco.
            if (!payload.admin) {
              const pr = await sql`SELECT data->'perfis' AS perfis FROM app_state WHERE chave = ${key}`;
              const perfis = pr[0] && Array.isArray(pr[0].perfis) ? pr[0].perfis : null;
              if (perfis) {
                const pf = perfis.find((p) => p && p.key === payload.role);
                if (!pf || !(pf.admin || pf.editar)) return json({ message: 'Perfil somente consulta: sem permissão para alterar dados' }, 403);
              }
            }

            // ---- Modo MERGE: combina só os registros que o usuário mudou (vários usuários ao mesmo tempo) ----
            if (body.merge) {
              const keys = body.merge.keys || {};
              const delta = body.merge.delta || {};
              const result = await sql.begin(async (sql) => {
                const rows = await sql`SELECT data FROM app_state WHERE chave = ${key} FOR UPDATE`;
                let state = (rows[0] && rows[0].data && typeof rows[0].data === 'object') ? rows[0].data : {};
                // upserts por chave de registro
                const ups = delta.upserts || {};
                const bases = delta.bases || {};
                const exige = exigeAprovacaoEng(state, payload);
                const engAntes = new Map();
                if (exige && Array.isArray(state.engenharias)) state.engenharias.forEach((e) => { if (e && e.id != null) engAntes.set(e.id, JSON.parse(JSON.stringify(e))); });
                for (const col in ups) {
                  const kf = keys[col] || 'id';
                  if (!Array.isArray(state[col])) state[col] = [];
                  const idx = {}; state[col].forEach((r, i) => { if (r && r[kf] != null) idx[r[kf]] = i; });
                  for (const rec of ups[col]) {
                    const k = rec ? rec[kf] : null;
                    if (k != null && idx[k] != null) {
                      // com a "base" do usuário: mescla campo a campo; sem base (cliente antigo): substitui
                      state[col][idx[k]] = hasOwn(bases[col], k) ? merge3(state[col][idx[k]], bases[col][k], rec) : rec;
                    } else { state[col].push(rec); if (k != null) idx[k] = state[col].length - 1; }
                  }
                }
                // aprovação da engenharia: a versão aprovada de ficha concluída não muda por este perfil
                if (exige && Array.isArray(ups.engenharias)) {
                  for (const rec of ups.engenharias) {
                    const id = rec && rec.id; const cur = engAntes.get(id); if (!cur || engEmCadastro(cur)) continue;
                    const m = state.engenharias.find((e) => e && e.id === id); if (!m) continue;
                    m.cadastro = 'concluido';
                    const baseline = cur.aprovado || engConteudo(cur);
                    if (engNorm(m) === engNorm(baseline)) { delete m.aprovado; delete m.aprovPend; delete m.devol; }
                    else { m.aprovado = baseline; if (!m.aprovPend) m.aprovPend = { por: payload.nome || payload.email || '', em: new Date().toISOString() }; }
                  }
                }
                // deleções por chave de registro
                const dels = delta.deletes || {};
                for (const col in dels) {
                  const kf = keys[col] || 'id';
                  if (Array.isArray(state[col])) {
                    let rm = new Set((dels[col] || []).map(String));
                    if (exige && col === 'engenharias') rm = new Set([...rm].filter((k) => engEmCadastro(engAntes.get(k)))); // não exclui ficha concluída
                    state[col] = state[col].filter((r) => !(r && rm.has(String(r[kf]))));
                  }
                }
                // campos avulsos (último a salvar vence)
                const sc = delta.scalars || {}, scb = delta.scalarBases || {};
                for (const k in sc) state[k] = hasOwn(scb, k) ? merge3(state[k], scb[k], sc[k]) : sc[k];
                const w = await sql`
                  INSERT INTO app_state (chave, data, "updatedAt")
                  VALUES (${key}, ${sql.json(state)}, now())
                  ON CONFLICT (chave) DO UPDATE SET data = EXCLUDED.data, "updatedAt" = now()
                  RETURNING "updatedAt"`;
                return { updatedAt: w[0].updatedAt, state };
              });
              // Devolve o estado MESCLADO para o cliente convergir imediatamente.
              return json({ chave: key, updatedAt: result.updatedAt, data: result.state });
            }

            // ---- Modo COMPLETO: substitui todo o estado (migração/backup/forçar envio) ----
            if (!payload.admin) {
              const pr2 = await sql`SELECT data->'perfis' AS perfis FROM app_state WHERE chave = ${key}`;
              if (exigeAprovacaoEng({ perfis: pr2[0] && pr2[0].perfis }, payload)) return json({ message: 'Perfil com aprovação de engenharia não pode substituir todos os dados' }, 403);
            }
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
