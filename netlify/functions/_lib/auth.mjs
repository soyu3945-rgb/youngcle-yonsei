// 공용 인증 유틸 — 비밀번호 해싱(scrypt)과, 서버가 스스로 서명/검증하는 간단한 로그인 토큰(HMAC).
// 외부 인증 서비스나 DB 없이, Netlify Blobs + 이 파일만으로 로그인을 구현합니다.
import crypto from 'node:crypto';

function getSecret() {
  // SESSION_SECRET을 따로 설정 안 했으면 ADMIN_PASSWORD를 대신 사용합니다(최소 설정으로도 동작하도록).
  const secret = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD;
  if (!secret) {
    throw new Error('SESSION_SECRET (또는 ADMIN_PASSWORD) 환경변수가 설정되어 있지 않습니다.');
  }
  return secret;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

// ---- 비밀번호 해싱 (scrypt + 랜덤 salt) ----
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, 64);
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch (e) {
    return false;
  }
}

// ---- 토큰 서명/검증 ----
export function signToken(payload, ttlSeconds) {
  const secret = getSecret();
  const body = { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const encoded = b64url(JSON.stringify(body));
  const sig = b64url(crypto.createHmac('sha256', secret).update(encoded).digest());
  return `${encoded}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const secret = getSecret();
  const [encoded, sig] = token.split('.');
  const expectedSig = b64url(crypto.createHmac('sha256', secret).update(encoded).digest());
  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(encoded).toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export function getBearerToken(req) {
  const h = req.headers.get('authorization') || req.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

// role이 'admin' 또는 'member'인 유효한 토큰인지 확인. 실패하면 null을 반환합니다(호출부에서 401 처리).
export function requireAuth(req, role) {
  const token = getBearerToken(req);
  const payload = verifyToken(token);
  if (!payload) return null;
  if (role && payload.role !== role) return null;
  return payload;
}

export function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
