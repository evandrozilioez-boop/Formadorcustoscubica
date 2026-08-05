// GET /api/session → emite um token automaticamente (sem digitar senha).
// Segurança:
//  - Se o site estiver protegido por Cloudflare Access, o header
//    "Cf-Access-Jwt-Assertion" existe e a sessão é liberada (recomendado).
//  - Sem Access, só libera se a variável OPEN_SESSION = "1" (link privado).
import { signToken, json, options } from '../_lib/auth.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return options();

  const accessJwt = request.headers.get('Cf-Access-Jwt-Assertion');
  const openMode = env.OPEN_SESSION === '1';

  if (!accessJwt && !openMode) {
    return json({ message: 'Sessão automática indisponível. Ative Cloudflare Access ou defina OPEN_SESSION=1.' }, 403);
  }

  const email = request.headers.get('Cf-Access-Authenticated-User-Email') || env.AUTH_EMAIL || 'auto@local';
  const accessToken = await signToken({ sub: email, email, role: 'admin' }, env);
  return json({ accessToken, usuario: { email } });
}
