// netlify/functions/similar-expressions.mjs
//
// 브라우저(shadowing.html)에서 POST /api/similar-expressions 로 호출하는 서버리스 함수입니다.
// 실제 AI 호출(Groq)은 여기, 서버 쪽에서만 이루어지고 API 키는 Netlify 환경변수(GROQ_API_KEY)에만
// 저장됩니다 — 브라우저(클라이언트) 코드에는 API 키가 절대 포함되지 않습니다.
//
// 설정 방법:
//   Netlify 대시보드 → Site configuration → Environment variables → Add a variable
//   Key: GROQ_API_KEY   Value: (console.groq.com 에서 발급받은 키, gsk_로 시작)
// 환경변수를 새로 추가/변경한 뒤에는 배포를 다시 트리거해야 반영됩니다(Deploys → Trigger deploy).
//
// 이 함수가 실패하거나 GROQ_API_KEY가 설정되지 않은 경우, shadowing.html은 자동으로
// 사전(오프라인) 기반 유사 표현 생성으로 대체되므로 사이트 자체가 깨지지는 않습니다.

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-20b'; // 빠르고 저렴한 Groq 프로덕션 모델
const MAX_SENTENCE_LEN = 300;
const TIMEOUT_MS = 10000;

export default async (req) => {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405);
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    // 키가 아직 등록 전이면 클라이언트가 알아서 사전 기반으로 대체합니다.
    return jsonResponse({ error: 'GROQ_API_KEY not configured' }, 500);
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return jsonResponse({ error: 'invalid JSON body' }, 400);
  }

  const sentence = (body && typeof body.sentence === 'string') ? body.sentence.trim() : '';
  if (!sentence) return jsonResponse({ error: 'sentence is required' }, 400);
  if (sentence.length > MAX_SENTENCE_LEN) return jsonResponse({ error: 'sentence too long' }, 400);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const groqRes = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.8,
        max_tokens: 400,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You help English learners practice shadowing. Given one English sentence, ' +
              'produce exactly 4 alternative ways to say the same thing in natural, spoken, ' +
              'everyday English. Keep the meaning the same. Vary the wording/structure across ' +
              'the 4 options. Do not add explanations. Respond ONLY with strict JSON of the form ' +
              '{"variants": ["...", "...", "...", "..."]} with exactly 4 strings in the array.',
          },
          { role: 'user', content: sentence },
        ],
      }),
      signal: controller.signal,
    });

    if (!groqRes.ok) {
      return jsonResponse({ error: `groq HTTP ${groqRes.status}` }, 502);
    }

    const data = await groqRes.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return jsonResponse({ error: 'empty groq response' }, 502);

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      return jsonResponse({ error: 'unparseable groq response' }, 502);
    }

    const variants = Array.isArray(parsed?.variants)
      ? parsed.variants.filter((v) => typeof v === 'string' && v.trim()).slice(0, 4)
      : null;

    if (!variants || variants.length !== 4) {
      return jsonResponse({ error: 'unexpected variants shape' }, 502);
    }

    return jsonResponse({ variants });
  } catch (err) {
    const isAbort = err && err.name === 'AbortError';
    return jsonResponse({ error: isAbort ? 'groq timeout' : 'groq request failed' }, 502);
  } finally {
    clearTimeout(timer);
  }
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
};
