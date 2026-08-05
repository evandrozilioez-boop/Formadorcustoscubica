// Utilitários de autenticação (JWT HS256 via Web Crypto) e respostas JSON com CORS.
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

export async function signToken(payload, env) {
  const secret = env.JWT_SECRET || 'dev-secret';
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 8 }; // 8h
  const h = b64urlStr(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64urlStr(JSON.stringify(body));
  const data = h + '.' + p;
  return data + '.' + (await hmac(data, secret));
}

export async function verifyToken(token, env) {
  try {
    if (!token) return false;
    const secret = env.JWT_SECRET || 'dev-secret';
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [h, p, s] = parts;
    if ((await hmac(h + '.' + p, secret)) !== s) return false;
    const payload = JSON.parse(decodeURIComponent(escape(atob(p.replace(/-/g, '+').replace(/_/g, '/')))));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch (e) {
    return false;
  }
}

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};
export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}
export function options() {
  return new Response(null, { status: 204, headers: CORS });
}
