// POST /api/auth/login  → valida credenciais (variáveis de ambiente) e devolve um token JWT.
import { signToken, json, options } from '../../_lib/auth.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return options();
  if (request.method !== 'POST') return json({ message: 'Método não permitido' }, 405);

  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'JSON inválido' }, 400); }

  const { email, senha } = body || {};
  if (!email || email !== env.AUTH_EMAIL || senha !== env.AUTH_PASSWORD) {
    return json({ message: 'Credenciais inválidas' }, 401);
  }

  const accessToken = await signToken({ sub: email, email, role: 'admin' }, env);
  return json({ accessToken, usuario: { email } });
}
