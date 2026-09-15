// 회원별 쉐도잉 세트(회차별 문장/단어) 관리 — 반드시 관리자 토큰이 필요합니다.
// GET  /api/admin-sets?username=xxx            → { sets: [{id,title,createdAt,...}] }  (목록)
// GET  /api/admin-sets?username=xxx&id=yyy      → { set: {...} }                        (상세)
// POST /api/admin-sets  { action:'create', username, title, sentences, words }
// POST /api/admin-sets  { action:'update', username, id, title, sentences, words }
// POST /api/admin-sets  { action:'delete', username, id }
import { requireAuth, jsonResponse } from './_lib/auth.mjs';
import { listSets, getSet, createSet, updateSet, deleteSet } from './_lib/store.mjs';

export default async (req) => {
  const auth = requireAuth(req, 'admin');
  if (!auth) return jsonResponse({ error: 'unauthorized' }, 401);

  const url = new URL(req.url);

  if (req.method === 'GET') {
    const username = url.searchParams.get('username');
    if (!username) return jsonResponse({ error: 'username_required' }, 400);
    const id = url.searchParams.get('id');
    if (id) {
      const set = await getSet(username, id);
      if (!set) return jsonResponse({ error: 'set_not_found' }, 404);
      return jsonResponse({ set });
    }
    const sets = await listSets(username);
    return jsonResponse({ sets });
  }

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
    const action = body && body.action;
    const username = body && body.username;
    if (!username) return jsonResponse({ error: 'username_required' }, 400);

    try {
      if (action === 'create') {
        const set = await createSet(username, { title: body.title, sentences: body.sentences, words: body.words });
        return jsonResponse({ set });
      }
      if (action === 'update') {
        if (!body.id) return jsonResponse({ error: 'id_required' }, 400);
        const set = await updateSet(username, body.id, { title: body.title, sentences: body.sentences, words: body.words });
        return jsonResponse({ set });
      }
      if (action === 'delete') {
        if (!body.id) return jsonResponse({ error: 'id_required' }, 400);
        await deleteSet(username, body.id);
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: 'unknown_action' }, 400);
    } catch (e) {
      return jsonResponse({ error: e.message || 'error' }, 400);
    }
  }

  return jsonResponse({ error: 'method_not_allowed' }, 405);
};

export const config = { path: '/api/admin-sets' };
