// Netlify Blobs 기반 저장소 — 회원 계정(아이디/비번)과 회원별 쉐도잉 세트(회차별 문장/단어)를 저장합니다.
// 별도 DB 없이 Netlify가 제공하는 Blobs 스토리지만 사용합니다(같은 사이트에 자동으로 연결됨).
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import { hashPassword, verifyPassword } from './auth.mjs';

function membersStore() {
  return getStore({ name: 'shadowing-members', consistency: 'strong' });
}
function setsStore() {
  return getStore({ name: 'shadowing-sets', consistency: 'strong' });
}

function normUsername(u) {
  return String(u || '').trim().toLowerCase();
}

/* ===================== 회원(멤버) ===================== */

export async function listMembers() {
  const store = membersStore();
  const { blobs } = await store.list();
  // ⚠️ Netlify Blobs의 list()는 각 항목의 metadata를 함께 돌려주지 않아서(키/etag만 옴),
  // 회원마다 실제 레코드를 따로 읽어와야 가입일 등을 정확히 알 수 있습니다.
  const records = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' })));
  const out = records
    .filter(Boolean)
    .map(r => ({ username: r.username, createdAt: r.createdAt || null }));
  out.sort((a, b) => (a.username < b.username ? -1 : 1));
  return out;
}

export async function getMember(username) {
  const store = membersStore();
  return await store.get(normUsername(username), { type: 'json' });
}

export async function createMember(username, password) {
  const uname = normUsername(username);
  if (!uname) throw new Error('username_required');
  if (!password || String(password).length < 4) throw new Error('password_too_short');
  const store = membersStore();
  const existing = await store.get(uname, { type: 'json' });
  if (existing) throw new Error('username_taken');
  const createdAt = new Date().toISOString();
  await store.setJSON(uname, { username: uname, passwordHash: hashPassword(password), createdAt }, { metadata: { createdAt } });
  return { username: uname, createdAt };
}

export async function resetMemberPassword(username, password) {
  const uname = normUsername(username);
  if (!password || String(password).length < 4) throw new Error('password_too_short');
  const store = membersStore();
  const existing = await store.get(uname, { type: 'json' });
  if (!existing) throw new Error('member_not_found');
  existing.passwordHash = hashPassword(password);
  await store.setJSON(uname, existing, { metadata: { createdAt: existing.createdAt } });
  return { username: uname };
}

export async function deleteMember(username) {
  const uname = normUsername(username);
  const store = membersStore();
  await store.delete(uname);
  // 그 회원의 쉐도잉 세트도 함께 정리합니다.
  const sStore = setsStore();
  const { blobs } = await sStore.list({ prefix: `${uname}/` });
  await Promise.all(blobs.map(b => sStore.delete(b.key)));
}

export async function verifyMemberLogin(username, password) {
  const uname = normUsername(username);
  const store = membersStore();
  const record = await store.get(uname, { type: 'json' });
  if (!record) return false;
  return verifyPassword(password, record.passwordHash);
}

/* ===================== 쉐도잉 세트(회차별 문장/단어) ===================== */

export async function createSet(username, { title, sentences, words }) {
  const uname = normUsername(username);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const data = {
    id,
    username: uname,
    title: title && title.trim() ? title.trim() : `${createdAt.slice(0, 10)} 수업`,
    createdAt,
    sentences: Array.isArray(sentences) ? sentences : [],
    words: Array.isArray(words) ? words : [],
  };
  const store = setsStore();
  await store.setJSON(`${uname}/${id}`, data, {
    metadata: { title: data.title, createdAt, sentenceCount: data.sentences.length, wordCount: data.words.length },
  });
  return data;
}

export async function updateSet(username, id, { title, sentences, words }) {
  const uname = normUsername(username);
  const store = setsStore();
  const key = `${uname}/${id}`;
  const existing = await store.get(key, { type: 'json' });
  if (!existing) throw new Error('set_not_found');
  const updated = {
    ...existing,
    title: title && title.trim() ? title.trim() : existing.title,
    sentences: Array.isArray(sentences) ? sentences : existing.sentences,
    words: Array.isArray(words) ? words : existing.words,
    updatedAt: new Date().toISOString(),
  };
  await store.setJSON(key, updated, {
    metadata: { title: updated.title, createdAt: updated.createdAt, sentenceCount: updated.sentences.length, wordCount: updated.words.length },
  });
  return updated;
}

export async function deleteSet(username, id) {
  const uname = normUsername(username);
  const store = setsStore();
  await store.delete(`${uname}/${id}`);
}

export async function listSets(username) {
  const uname = normUsername(username);
  const store = setsStore();
  const { blobs } = await store.list({ prefix: `${uname}/` });
  // ⚠️ list()는 metadata를 함께 돌려주지 않으므로, 세트마다 실제 레코드를 따로 읽어서
  // 제목/문장수/단어수/등록일을 정확히 계산합니다.
  const records = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' })));
  const out = records
    .filter(Boolean)
    .map(r => ({
      id: r.id,
      title: r.title || '(제목 없음)',
      createdAt: r.createdAt || null,
      sentenceCount: Array.isArray(r.sentences) ? r.sentences.length : 0,
      wordCount: Array.isArray(r.words) ? r.words.length : 0,
    }));
  out.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return out;
}

export async function getSet(username, id) {
  const uname = normUsername(username);
  const store = setsStore();
  return await store.get(`${uname}/${id}`, { type: 'json' });
}
