// POST /api/admin-login   body: { password }  →  200 { token }  /  401 { error }
// 관리자 비밀번호 하나로 로그인합니다(Netlify 환경변수 ADMIN_PASSWORD와 비교).
import { signToken, jsonResponse } from './_lib/auth.mjs';

const ADMIN_TOKEN_TTL = 60 * 60 * 12; // 12시간

export default async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);

  let body;
  try { body = await req.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }

  const password = String((body && body.password) || '');
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    return jsonResponse({ error: 'not_configured', message: 'Netlify 환경변수 ADMIN_PASSWORD가 설정되어 있지 않습니다.' }, 500);
  }
  if (!password || password !== adminPassword) {
    return jsonResponse({ error: 'invalid_password' }, 401);
  }

  const token = signToken({ role: 'admin' }, ADMIN_TOKEN_TTL);
  return jsonResponse({ token, expiresIn: ADMIN_TOKEN_TTL });
};

export const config = { path: '/api/admin-login' };
