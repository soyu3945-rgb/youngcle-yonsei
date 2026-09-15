// 회원(아이디/비번) 관리 — 반드시 관리자 토큰이 필요합니다.
// GET  /api/admin-members              → { members: [{username, createdAt}] }
// POST /api/admin-members  { action: 'create', username, password }
// POST /api/admin-members  { action: 'reset-password', username, password }
// POST /api/admin-members  { action: 'delete', username }
import { requireAuth, jsonResponse } from './_lib/auth.mjs';
import { listMembers, createMember, resetMemberPassword, deleteMember } from './_lib/store.mjs';

const ERROR_MESSAGES = {
  username_required: '아이디를 입력해주세요.',
  password_too_short: '비밀번호는 4자 이상이어야 해요.',
  username_taken: '이미 사용 중인 아이디예요.',
  member_not_found: '해당 회원을 찾을 수 없어요.',
};

export default async (req) => {
  const auth = requireAuth(req, 'admin');
  if (!auth) return jsonResponse({ error: 'unauthorized' }, 401);

  if (req.method === 'GET') {
    const members = await listMembers();
    return jsonResponse({ members });
  }

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
    const action = body && body.action;

    try {
      if (action === 'create') {
        const member = await createMember(body.username, body.password);
        return jsonResponse({ member });
      }
      if (action === 'reset-password') {
        const member = await resetMemberPassword(body.username, body.password);
        return jsonResponse({ member });
      }
      if (action === 'delete') {
        await deleteMember(body.username);
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: 'unknown_action' }, 400);
    } catch (e) {
      const msg = ERROR_MESSAGES[e.message] || e.message || '오류가 발생했어요.';
      return jsonResponse({ error: e.message, message: msg }, 400);
    }
  }

  return jsonResponse({ error: 'method_not_allowed' }, 405);
};

export const config = { path: '/api/admin-members' };
