/* ==========================================================================
   shadowing-engine.js
   shadowing.html 안에 있던 "듣기(TTS) / 따라 말하기(STT) / 번역 / 문법 설명 /
   비슷한 표현 생성" 로직을 그대로 옮겨서, admin.html / member.html 에서도
   재사용할 수 있게 만든 공용 엔진입니다. (shadowing.html 자체는 손대지 않았어요.)

   사용법: <script src="js/shadowing-engine.js"></script> 를 넣으면
   전역 변수 window.ShadowingEngine 에 아래 함수/값들이 들어있습니다.
     - escapeHTML(s)
     - loadTranslationInto(krSpanEl, text)
     - buildShadowingControls(targetText)  → 듣기/따라 말하기 UI DOM 반환
     - explainDifference(x, o)             → 문법 해설 텍스트
     - buildVariantBlock(sentenceText)     → "비슷한 표현 4개" DOM (또는 null)
     - parseFeedbackBlock(text, pairMode)  → { newSentences, newWords }
     - parseWordsBlock(text)               → string[]
     - hasTTS, hasSTT
========================================================================== */
(function (global) {
  'use strict';

  function escapeHTML(s) { return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  /* ===================== 번역 ===================== */
  const translationCache = new Map();

  async function translateOnceGoogle(text, target, source, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${source}&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) throw new Error('google translate HTTP ' + resp.status);
      const data = await resp.json();
      const translated = Array.isArray(data) && Array.isArray(data[0])
        ? data[0].map(seg => (Array.isArray(seg) ? seg[0] : '')).join('')
        : '';
      if (!translated) throw new Error('empty google translation');
      return translated;
    } finally {
      clearTimeout(timer);
    }
  }

  async function translateOnceMyMemory(text, target, source, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${source}|${target}`;
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) throw new Error('translate HTTP ' + resp.status);
      const data = await resp.json();
      const translated = data && data.responseData && data.responseData.translatedText;
      if (!translated) throw new Error('empty translation');
      if (/mymemory warning|invalid|quota/i.test(translated)) throw new Error('quota/limit response: ' + translated);
      return translated;
    } finally {
      clearTimeout(timer);
    }
  }

  async function translateOnce(text, target, source, timeoutMs) {
    try {
      return await translateOnceGoogle(text, target, source, timeoutMs);
    } catch (err) {
      console.warn('구글 번역 실패, MyMemory로 대체합니다:', err);
      return await translateOnceMyMemory(text, target, source, timeoutMs);
    }
  }

  async function translateText(text, target = 'ko', source = 'en', retries = 2) {
    if (!text || !text.trim()) return '';
    const key = `${source}|${target}|${text}`;
    if (translationCache.has(key)) return translationCache.get(key);
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const translated = await translateOnce(text, target, source, 6000);
        translationCache.set(key, translated);
        return translated;
      } catch (err) {
        lastErr = err;
        if (attempt < retries) await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
      }
    }
    console.warn('translation failed after retries:', lastErr);
    return null;
  }

  function loadTranslationInto(krSpan, text) {
    if (!krSpan) return;
    krSpan.textContent = '번역 중...';
    translateText(text).then(tr => {
      if (!krSpan.isConnected) return;
      if (tr) {
        krSpan.textContent = tr;
        krSpan.classList.remove('kr-text-retry');
        krSpan.onclick = null;
      } else {
        krSpan.textContent = '번역 실패 (인터넷 연결을 확인하고 클릭하면 다시 시도해요) 🔄';
        krSpan.classList.add('kr-text-retry');
        krSpan.onclick = () => loadTranslationInto(krSpan, text);
      }
    });
  }

  /* ===================== TTS/STT 지원 여부 ===================== */
  const hasTTS = 'speechSynthesis' in window;
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  const hasSTT = !!SpeechRecognitionCtor;
  const isMobileDevice = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

  let micWarmupPromise = null;
  function warmupMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.resolve(null);
    if (!micWarmupPromise) {
      micWarmupPromise = navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    }
    return micWarmupPromise;
  }

  function compareWords(target, heard) {
    const norm = s => s.toLowerCase().replace(/[^a-z0-9'\s]/g, '').split(/\s+/).filter(Boolean);
    const tw = norm(target);
    const hw = norm(heard);
    const dp = Array.from({ length: tw.length + 1 }, () => new Array(hw.length + 1).fill(0));
    for (let i = tw.length - 1; i >= 0; i--)
      for (let j = hw.length - 1; j >= 0; j--)
        dp[i][j] = tw[i] === hw[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

    let i = 0, j = 0, html = '', matched = 0;
    while (i < tw.length && j < hw.length) {
      if (tw[i] === hw[j]) { html += `<span class="w-ok">${escapeHTML(tw[i])}</span>`; matched++; i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { html += `<span class="w-miss">${escapeHTML(tw[i])}</span>`; i++; }
      else { html += `<span class="w-extra">${escapeHTML(hw[j])}</span>`; j++; }
    }
    while (i < tw.length) { html += `<span class="w-miss">${escapeHTML(tw[i])}</span>`; i++; }
    while (j < hw.length) { html += `<span class="w-extra">${escapeHTML(hw[j])}</span>`; j++; }

    const score = tw.length ? Math.round((matched / tw.length) * 100) : 0;
    return { score, html };
  }

  function buildShadowingControls(targetText) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="controls">
        <select class="rate-select">
          <option value="1">보통 속도</option>
          <option value="0.8">약간 천천히</option>
          <option value="0.6" selected>천천히</option>
        </select>
        <span class="repeat-field" style="display:flex; align-items:center; gap:4px;">
          <input type="number" class="repeat-input" min="1" max="30" value="10" style="width:52px; background:var(--input-bg); border:1px solid var(--border); border-radius:8px; color:var(--text); padding:6px 8px; font-size:0.82rem; font-family:inherit;">
          <span style="font-size:0.78rem; color:var(--muted);">회 반복</span>
        </span>
        <label class="mic-toggle-label" style="display:flex; align-items:center; gap:4px; font-size:0.78rem; color:var(--muted); cursor:${hasSTT ? 'pointer' : 'not-allowed'};" title="${hasSTT ? '마이크가 안 되거나 오류가 계속 나면 체크를 꺼서 듣기만 연습하세요.' : '이 브라우저는 음성 인식을 지원하지 않습니다(Chrome 권장)'}">
          <input type="checkbox" class="mic-toggle" ${hasSTT ? 'checked' : 'disabled'}> 🎙️ 마이크 사용
        </label>
        <button class="btn-primary btn-small practice-btn" ${hasTTS ? '' : 'disabled title="이 브라우저는 TTS를 지원하지 않습니다"'}>▶ 연습 시작</button>
        <span class="repeat-count-badge" style="display:none;"></span>
        <span class="score-badge" style="display:none;"></span>
      </div>
      <div class="heard" style="display:none;"></div>
      <div class="word-compare"></div>
    `;
    const practiceBtn = wrap.querySelector('.practice-btn');
    const rateSelect = wrap.querySelector('.rate-select');
    const repeatInput = wrap.querySelector('.repeat-input');
    const micToggle = wrap.querySelector('.mic-toggle');
    const scoreBadge = wrap.querySelector('.score-badge');
    const repeatCountBadge = wrap.querySelector('.repeat-count-badge');
    const heardEl = wrap.querySelector('.heard');
    const compareEl = wrap.querySelector('.word-compare');

    let runState = { stopped: true, activeRecognition: null };
    let shadowingCount = 0;

    function speakOnce(rate) {
      return new Promise(resolve => {
        const utter = new SpeechSynthesisUtterance(targetText);
        utter.lang = 'en-US';
        utter.rate = rate;
        const voices = window.speechSynthesis.getVoices();
        const enVoice = voices.find(v => v.lang === 'en-US') || voices.find(v => v.lang.startsWith('en'));
        if (enVoice) utter.voice = enVoice;
        utter.onend = resolve;
        utter.onerror = resolve;
        window.speechSynthesis.speak(utter);
      });
    }

    let sharedRecognition = null;
    function getSharedRecognition() {
      if (!sharedRecognition) {
        sharedRecognition = new SpeechRecognitionCtor();
        sharedRecognition.lang = 'en-US';
        sharedRecognition.interimResults = false;
        sharedRecognition.maxAlternatives = 1;
      }
      return sharedRecognition;
    }

    function runOneRecognition(onReady) {
      return new Promise((resolve) => {
        let settled = false;
        const settle = (val) => { if (!settled) { settled = true; resolve(val); } };

        const recognition = getSharedRecognition();
        runState.activeRecognition = recognition;

        let heard = null;
        recognition.onstart = () => { if (onReady) onReady(); };
        recognition.onresult = (event) => { heard = event.results[0][0].transcript; };
        recognition.onerror = (event) => { if (!heard) settle({ ok: false, error: event.error }); };
        recognition.onend = () => { settle(heard ? { ok: true, heard } : { ok: false, error: 'no-speech' }); };
        try { recognition.start(); }
        catch (e) { settle({ ok: false, error: 'start-failed' }); }
      });
    }

    function micPermissionErrorHTML(errorCode) {
      if (errorCode === 'not-allowed' || errorCode === 'service-not-allowed') {
        if (location.protocol === 'file:') {
          return '⚠️ 마이크 권한이 계속 다시 요청돼요. 이 파일을 직접 열어서 쓸 때(file://) 크롬이 마이크 허용 상태를 저장하지 못해서 생기는 문제예요.<br>'
            + '해결 방법: 주소창의 🔒/카메라 아이콘을 눌러 "이 사이트에서 항상 허용"으로 바꿔보시거나, https 주소로 배포해서 사용해주세요. "🎙️ 마이크 사용" 체크를 끄면 듣기만으로도 계속 연습할 수 있어요.';
        }
        return '⚠️ 마이크 권한이 거부됐어요. 주소창의 🔒 아이콘을 눌러 마이크 권한을 "허용"으로 바꾸거나, "🎙️ 마이크 사용" 체크를 끄고 듣기만으로 연습해보세요.';
      }
      return null;
    }

    // 듣기(TTS)와 따라 말하기(마이크)를 버튼 하나로 합친 연습 루프입니다.
    // "🎙️ 마이크 사용" 체크가 꺼져 있으면(마이크가 안 될 때) 마이크 단계는 건너뛰고 듣기만 반복합니다.
    practiceBtn.addEventListener('click', async () => {
      if (!runState.stopped) {
        runState.stopped = true;
        window.speechSynthesis.cancel();
        if (runState.activeRecognition) { try { runState.activeRecognition.abort(); } catch (e) {} }
        practiceBtn.textContent = '▶ 연습 시작';
        return;
      }
      if (!hasTTS) return;
      window.speechSynthesis.cancel();

      let count = parseInt(repeatInput.value, 10);
      if (!count || count < 1) count = 1;
      if (count > 30) count = 30;
      repeatInput.value = count;

      const useMic = hasSTT && micToggle.checked;
      const rate = parseFloat(rateSelect.value);

      runState = { stopped: false, activeRecognition: null };
      heardEl.style.display = 'none';
      scoreBadge.style.display = 'none';
      compareEl.innerHTML = '';

      if (useMic) await warmupMic();

      for (let i = 1; i <= count; i++) {
        if (runState.stopped) break;
        practiceBtn.textContent = `⏹ 정지 (${i}/${count})`;
        await speakOnce(rate);
        if (runState.stopped) break;

        if (useMic) {
          practiceBtn.textContent = `⏹ 정지 · 마이크 준비 중 (${i}/${count})`;
          const result = await runOneRecognition(() => {
            if (!runState.stopped) practiceBtn.textContent = `⏹ 정지 · 🗣️ 지금 말씀하세요! (${i}/${count})`;
          });
          if (runState.stopped) break;

          if (result.ok) {
            shadowingCount++;
            repeatCountBadge.style.display = 'inline-flex';
            repeatCountBadge.textContent = `🗣️ 따라 말한 횟수 ${shadowingCount}`;

            heardEl.style.display = 'block';
            heardEl.textContent = `👂 인식된 발음 (${i}/${count}): "${result.heard}"`;
            const { score, html } = compareWords(targetText, result.heard);
            compareEl.innerHTML = html;
            scoreBadge.style.display = 'inline-flex';
            scoreBadge.textContent = `일치도 ${score}%`;
            scoreBadge.className = 'score-badge ' + (score >= 85 ? 'good' : score >= 60 ? 'mid' : 'bad');
          } else {
            const permHTML = micPermissionErrorHTML(result.error);
            heardEl.style.display = 'block';
            if (permHTML) {
              heardEl.innerHTML = permHTML;
              break; // 권한 문제는 반복해도 소용없으니 멈춥니다 (마이크 사용 체크를 끄면 계속 진행 가능)
            }
            heardEl.textContent = `⚠️ ${i}번째 시도에서 소리를 인식하지 못했어요 (${result.error}). 계속 진행합니다.`;
          }
        }

        if (!runState.stopped && i < count) await new Promise(r => setTimeout(r, useMic ? 700 : 500));
      }
      runState.stopped = true;
      runState.activeRecognition = null;
      practiceBtn.textContent = '▶ 연습 시작';
    });

    return wrap;
  }

  if (hasTTS) window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();

  function isSecureContextForMic() {
    const isLocalhost = ['localhost', '127.0.0.1'].includes(location.hostname);
    return location.protocol === 'https:' || isLocalhost;
  }

  /* ===================== x: / o: / w: 텍스트 파서 (공용) ===================== */
  // "x:", "x-", "x " 뿐 아니라 "[x]"(대괄호, 뒤에 공백 있어도/없어도) 형식도 인식합니다.
  const X_PREFIX_RE = /^(?:\[x\]\s*|x\s*(?:[:：\-－]\s*|\s+))/i;
  const O_PREFIX_RE = /^(?:\[o\]\s*|o\s*(?:[:：\-－]\s*|\s+))/i;
  const W_PREFIX_RE = /^(?:\[w\]\s*|w\s*(?:[:：\-－]\s*|\s+))/i;

  function parseFeedbackBlock(text, pairMode) {
    const lines = text.split('\n');
    const newSentences = [];
    const newWords = [];
    let pendingX = '';
    let pendingPairX = null;
    lines.forEach(raw => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      if (X_PREFIX_RE.test(line)) {
        pendingX = line.replace(X_PREFIX_RE, '');
      } else if (O_PREFIX_RE.test(line)) {
        const o = line.replace(O_PREFIX_RE, '');
        if (o) newSentences.push({ x: pendingX, o });
        pendingX = '';
      } else if (W_PREFIX_RE.test(line)) {
        const w = line.replace(W_PREFIX_RE, '');
        if (w) newWords.push(w);
      } else if (pairMode) {
        if (pendingPairX === null) {
          pendingPairX = line;
        } else {
          newSentences.push({ x: pendingPairX, o: line, hideX: true });
          pendingPairX = null;
        }
      } else {
        newSentences.push({ x: pendingX, o: line });
        pendingX = '';
      }
    });
    if (pendingPairX !== null) {
      newSentences.push({ x: '', o: pendingPairX });
    }
    return { newSentences, newWords };
  }

  // 이미 저장된 문장/단어에 "[x]", "[o]", "x:", "o:" 같은 접두어가 실수로 남아있어도
  // 화면에 보여줄 때는 항상 깔끔하게 지워서 보여줍니다(과거에 저장된 데이터도 자동으로 교정됨).
  function stripLeadingLabel(text) {
    if (!text) return text;
    return String(text).trim().replace(X_PREFIX_RE, '').replace(O_PREFIX_RE, '').replace(W_PREFIX_RE, '').trim();
  }

  function parseWordsBlock(text) {
    return text
      .split(/[,\n]+/)
      .flatMap(chunk => chunk.trim().split(/\s+/))
      .map(w => w.replace(W_PREFIX_RE, '').trim())
      .filter(Boolean);
  }

  /* ===================== 문법 설명 엔진 (오프라인, 패턴 기반) ===================== */
  function normWords(s) {
    return s.toLowerCase().replace(/[.,!?;:]/g, '').split(/\s+/).filter(Boolean);
  }

  const BE_VERBS = ['am', 'is', 'are', 'was', 'were', 'be', 'been', 'being'];
  const AUX_VERBS = ['do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should', 'must', 'may', 'might', 'shall'];
  const MODAL_TO_PHRASES = ["have to", "has to", "had to", "need to", "needs to", "want to", "wants to", "going to", "used to", "try to", "tries to", "love to", "like to", "plan to", "planning to", "decide to", "decided to"];
  const PREPOSITIONS = ['to', 'at', 'in', 'on', 'for', 'of', 'with', 'from', 'by', 'about', 'into', 'onto', 'over', 'under', 'between', 'among', 'through', 'during', 'after', 'before', 'around', 'near', 'without', 'against', 'toward', 'towards', 'across'];
  const ARTICLES = ['a', 'an', 'the'];
  const PRONOUNS = ['i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'this', 'that', 'these', 'those'];
  const COMMON_VERBS = ['go', 'goes', 'went', 'come', 'comes', 'came', 'get', 'gets', 'got', 'take', 'takes', 'took', 'make', 'makes', 'made', 'do', 'does', 'did', 'have', 'has', 'had', 'eat', 'eats', 'ate', 'play', 'plays', 'played', 'study', 'studies', 'studied', 'work', 'works', 'worked', 'watch', 'watches', 'watched', 'meet', 'meets', 'met', 'see', 'sees', 'saw', 'visit', 'visits', 'visited', 'buy', 'buys', 'bought', 'read', 'reads', 'stay', 'stays', 'stayed', 'feel', 'feels', 'felt', 'think', 'thinks', 'thought', 'know', 'knows', 'knew', 'say', 'says', 'said', 'tell', 'tells', 'told', 'give', 'gives', 'gave', 'use', 'uses', 'used', 'find', 'finds', 'found', 'want', 'wants', 'wanted', 'need', 'needs', 'needed', 'try', 'tries', 'tried', 'call', 'calls', 'called', 'ask', 'asks', 'asked', 'wear', 'wears', 'wore', 'sleep', 'sleeps', 'slept', 'run', 'runs', 'ran', 'walk', 'walks', 'walked', 'talk', 'talks', 'talked', 'speak', 'speaks', 'spoke', 'write', 'writes', 'wrote', 'listen', 'listens', 'listened', 'live', 'lives', 'lived'];
  const VERB_HINTS_SUFFIX = /(ed|ing|s)$/;

  function isPrep(w) { return PREPOSITIONS.includes(w); }
  function isArticle(w) { return ARTICLES.includes(w); }
  function isBe(w) { return BE_VERBS.includes(w); }
  function isAux(w) { return AUX_VERBS.includes(w); }
  function isPronoun(w) { return PRONOUNS.includes(w); }
  function looksLikeVerb(w) { return COMMON_VERBS.includes(w) || isBe(w) || isAux(w) || VERB_HINTS_SUFFIX.test(w); }

  function diffWordOps(xw, ow) {
    const n = xw.length, m = ow.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = xw[i] === ow[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const raw = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (xw[i] === ow[j]) { raw.push({ type: 'same', xw: xw[i], ow: ow[j] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { raw.push({ type: 'del', xw: xw[i] }); i++; }
      else { raw.push({ type: 'ins', ow: ow[j] }); j++; }
    }
    while (i < n) { raw.push({ type: 'del', xw: xw[i] }); i++; }
    while (j < m) { raw.push({ type: 'ins', ow: ow[j] }); j++; }

    const ops = [];
    let k = 0;
    while (k < raw.length) {
      if (raw[k].type === 'same') { ops.push({ type: 'same', words: [raw[k].xw] }); k++; continue; }
      let dels = [], inss = [];
      while (k < raw.length && raw[k].type === 'del') { dels.push(raw[k].xw); k++; }
      while (k < raw.length && raw[k].type === 'ins') { inss.push(raw[k].ow); k++; }
      if (dels.length && inss.length) ops.push({ type: 'replace', from: dels, to: inss });
      else if (dels.length) ops.push({ type: 'delete', words: dels });
      else if (inss.length) ops.push({ type: 'insert', words: inss });
    }
    return ops;
  }

  function describeReplace(fromArr, toArr) {
    const from = fromArr.join(' '), to = toArr.join(' ');
    const TENSE_PAIRS = [["don't", "didn't"], ["doesn't", "didn't"], ["isn't", "wasn't"], ["aren't", "weren't"],
      ["is", "was"], ["are", "were"], ["am", "was"], ["do", "did"], ["does", "did"], ["will", "would"]];
    for (const [pres, past] of TENSE_PAIRS) {
      if (from === pres && to === past) {
        return `📌 시제(때) 오류 — "${pres}" → "${past}"\n동사 "${pres}"는 현재 시제인데, 이 문장은 이미 지나간 일(과거)을 말하고 있어요. 영어는 동사 자체의 형태를 바꿔서 시제를 나타내므로, 과거의 일에는 반드시 과거형 "${past}"를 써야 해요. 한국어는 "나는 어제 학교에 가요"처럼 시간부사만 바꿔도 되지만, 영어는 그렇게 하면 문법 오류가 됩니다.`;
      }
    }
    if (fromArr.length === 1 && toArr.length === 1) {
      const f = fromArr[0], t = toArr[0];
      if ((t === f + 's' || t === f + 'es') && !isBe(f) && !isAux(f) && !looksLikeVerb(f)) {
        return `📌 명사의 수(단수/복수) 오류 — "${f}" → "${t}"\n영어 명사는 하나(단수)인지 여럿(복수)인지에 따라 형태가 달라져요. 가리키는 대상이 두 개 이상이라면 명사 끝에 -s(또는 -es)를 붙여 복수형으로 써야 해요. 한국어 명사는 단/복수에 따라 형태가 거의 바뀌지 않아서("사과 한 개"나 "사과 여러 개"나 둘 다 "사과") 한국인 학습자가 자주 놓치는 부분이에요.`;
      }
      if ((t === f + 's' || t === f + 'es') && (looksLikeVerb(f) || looksLikeVerb(t))) {
        return `📌 주어-동사 수일치 오류 — "${f}" → "${t}"\n주어가 3인칭 단수(he, she, it 또는 사람/사물 이름 하나)일 때, 현재 시제 동사에는 반드시 -s(또는 -es)를 붙여야 해요. 그래서 동사원형 "${f}"가 아니라 "${t}"가 맞는 형태예요. 주어가 I, you, we, they이거나 복수일 때는 -s를 붙이지 않는다는 점도 함께 기억해두세요.`;
      }
      if (isPrep(f) && isPrep(t)) {
        return `📌 전치사 오류 — "${f}" → "${t}"\n전치사는 뜻이 비슷해 보여도 쓰임이 서로 다른 경우가 많아서, 문맥에 맞는 전치사를 골라 써야 해요. 이 문장에서는 "${f}"가 아니라 "${t}"를 쓰는 것이 관용적으로(원어민들이 실제로 쓰는 방식으로) 자연스러워요. 전치사는 규칙보다 표현 단위(연어, collocation)로 통째로 외워두는 게 좋아요.`;
      }
      if (isArticle(f) || isArticle(t)) {
        return `📌 관사 오류 — "${f}" → "${t}"\n영어는 명사 앞에 무엇을 쓰는지(a/an, the, 또는 아무것도 안 씀)로 그 명사가 "특정한 것"인지 "막연한 하나"인지를 구분해요. 한국어에는 관사 개념이 없어서 자주 실수하는 부분인데, 여기서는 "${t}"를 쓰는 것이 맞아요.`;
      }
      if (isPronoun(f) || isPronoun(t)) {
        return `📌 대명사/인칭 오류 — "${f}" → "${t}"\n문장 속 주어나 목적어 역할에 맞는 대명사 형태를 써야 해요. "${f}" 대신 "${t}"를 쓰는 것이 문맥(주격/목적격 또는 가리키는 대상)에 맞아요.`;
      }
      if (looksLikeVerb(f) && looksLikeVerb(t)) {
        return `📌 동사 형태 오류 — "${f}" → "${t}"\n같은 동사라도 시제나 형태(원형/과거형/과거분사/-ing형 등)에 따라 모양이 달라져요. 이 문장의 시제·문형에 맞는 형태는 "${f}"가 아니라 "${t}"예요.`;
      }
      return `📌 단어 선택 오류 — "${f}" → "${t}"\n"${f}"라는 단어 자체가 틀린 것은 아니지만, 이 문맥에서는 "${t}"가 의미상 더 정확하고 원어민이 실제로 쓰는 자연스러운 표현이에요.`;
    }
    return `📌 표현 교체 — "${from}" → "${to}"\n이 부분은 단어 하나가 아니라 표현 전체가 더 자연스러운 말로 바뀌었어요. 한국어 표현을 단어 하나하나 그대로 영어로 옮기기보다, 영어에서 실제로 쓰이는 표현 덩어리(구/관용표현) 단위로 익혀두는 것이 좋아요.`;
  }

  function describeInsert(words, prevWord, nextWord) {
    const phrase = words.join(' ');
    if (words.length === 1) {
      const w = words[0];
      if (isPrep(w)) {
        return `📌 전치사 "${w}" 누락\n"${prevWord || '(문장 앞부분)'}"과(와) "${nextWord || '(뒤 단어)'}" 사이에 전치사 "${w}"가 빠져 있었어요. 전치사는 명사(구)가 문장 속에서 시간·장소·방향·대상 등 어떤 역할을 하는지 표시해주는 말이라서, 빠지면 두 단어의 관계가 불명확해져요.`;
      }
      if (isArticle(w)) {
        return `📌 관사 "${w}" 누락\n"${nextWord || '뒤에 오는 명사'}" 앞에 관사 "${w}"가 빠져 있었어요. 셀 수 있는 명사가 하나만 있을 때는 그 앞에 a/an(막연한 하나) 또는 the(특정한 것)를 반드시 붙여야 해요. 한국어에는 이런 관사가 없어서 한국인 학습자가 가장 자주 빠뜨리는 부분이에요.`;
      }
      if (isBe(w)) {
        return `📌 be동사 "${w}" 누락\n주어 뒤에 be동사 "${w}"가 빠져 있었어요. 영어 문장은 "주어 + 동사"가 기본 골격이라서, 형용사나 명사로 끝나는 서술(예: "행복하다", "학생이다")을 하려면 반드시 be동사가 있어야 해요. 한국어는 "나 행복"처럼 동사 없이도 자연스럽지만, 영어에서는 문법 오류가 됩니다.`;
      }
      if (isAux(w) && MODAL_TO_PHRASES.some(p => p.startsWith(w))) {
        return `📌 조동사/준조동사 "${w}" 누락\n"${w}"가 빠져 있었어요. 이 단어는 뒤에 오는 동사의 의미(의무·필요·경험 등)를 더해주는 조동사 역할을 해서, 빠지면 문장의 의미와 형태가 달라져요.`;
      }
      if (looksLikeVerb(w)) {
        if (prevWord === 'to' || MODAL_TO_PHRASES.some(p => p.endsWith('to'))) {
          return `📌 본동사 "${w}" 누락 (to부정사 구조)\n"to" 뒤에는 반드시 동사원형이 와서 "to ${w}"(부정사) 형태를 만들어야 하는데, 정작 동사 "${w}"가 빠지고 "to" 뒤에 명사(장소·대상 등)만 바로 나와 있었어요. "have to / need to / want to / going to"처럼 "동사 + to" 표현 뒤에는 명사가 아니라 반드시 "동사원형"이 와야 해서, 뜻을 완성하려면 "${w}"와 같은 동사를 넣어줘야 해요. 예: "I have to Seoul"(✗, 동사 없음) → "I have to go to Seoul"(✓, go라는 본동사가 있음).`;
        }
        return `📌 본동사 "${w}" 누락\n문장에 술어 역할을 할 동사 "${w}"가 빠져 있었어요. 영어 문장은 명사(구)만 나열해서는 완전한 문장이 될 수 없고, 반드시 주어의 동작이나 상태를 나타내는 동사가 있어야 해요.`;
      }
      return `📌 단어 "${w}" 추가\n"${w}"가 새로 들어가면서 문장의 의미가 더 정확하고 자연스러워졌어요.`;
    }
    const first = words[0];
    if (looksLikeVerb(first) && (prevWord === 'to' || MODAL_TO_PHRASES.some(p => p.split(' ').includes(prevWord)))) {
      return `📌 본동사 "${first}" 누락 (to부정사 구조)\n"to" 뒤에는 반드시 동사원형이 와서 "to ${first}"(부정사) 형태를 만들어야 하는데, 정작 동사 "${first}"가 빠지고 "to" 뒤에 명사(장소·대상 등)만 바로 나와 있었어요. "have to / need to / want to / going to"처럼 "동사 + to" 표현 뒤에는 명사가 아니라 반드시 "동사원형"이 와야 해서, 뜻을 완성하려면 "${phrase}"처럼 동사를 넣어줘야 해요. 예: "I have to Seoul"(✗, 동사 없음) → "I have to ${phrase} Seoul"(✓, 본동사가 있음).`;
    }
    return `📌 표현 "${phrase}" 추가\n이 부분이 문장에 통째로 추가되면서 의미가 더 분명하고 자연스러워졌어요. 한국어에서는 생략해도 자연스러운 부분이 영어에서는 명시적으로 들어가야 하는 경우가 많아요.`;
  }

  function describeDelete(words) {
    const phrase = words.join(' ');
    return `📌 불필요한 표현 "${phrase}" 삭제\n"${phrase}"는 이 문장에서는 없어도 되거나, 있으면 오히려 어색한 표현이라 빠졌어요. 한국어를 단어 그대로 영어로 옮기는 "직역" 과정에서 이런 군더더기 표현이 자주 생기는데, 영어식으로 더 간결하게 표현하는 연습이 필요해요.`;
  }

  function explainDifference(x, o) {
    if (!x || !x.trim()) return '';
    const xw = normWords(x);
    const ow = normWords(o);
    if (!xw.length) return '';

    const notes = [];

    if (xw.length <= 3 && ow.length >= xw.length * 2) {
      notes.push(`📌 문장 조각(단답형) 오류\n"${x}"처럼 단어 몇 개만으로 대답하면 구어체에서는 통해도 격식 있는 완전한 문장이 아니에요. 영어 문장의 기본 구조는 "주어(Subject) + 동사(Verb) + (목적어/보어)"이므로, "${o}"처럼 주어와 동사를 모두 갖춘 문장으로 말하는 연습이 필요해요.`);
    }

    const ops = diffWordOps(xw, ow);
    ops.forEach(op => {
      if (op.type === 'replace') notes.push(describeReplace(op.from, op.to));
      else if (op.type === 'insert') {
        const idx = ops.indexOf(op);
        const prevSame = [...ops.slice(0, idx)].reverse().find(o2 => o2.type === 'same');
        const nextSame = ops.slice(idx + 1).find(o2 => o2.type === 'same');
        notes.push(describeInsert(op.words, prevSame ? prevSame.words[0] : '', nextSame ? nextSame.words[0] : ''));
      }
      else if (op.type === 'delete') notes.push(describeDelete(op.words));
    });

    if (notes.length === 0) {
      notes.push('📌 문장 구조 분석\n단어 구성은 같지만 어순이나 표현 방식이 더 자연스럽게 다듬어졌어요. 위 취소선(✗) 문장과 비교하며 어순 차이를 확인해보세요.');
    }

    const oHasBe = ow.some(isBe);
    const structureNote = `\n📖 문장 구조 정리: "${o}" 는 ${oHasBe ? '[주어] + [be동사] + [보어/설명]' : '[주어] + [동사] + [목적어/부가어]'} 구조의 완전한 문장입니다.`;

    return notes.join('\n\n') + structureNote;
  }

  /* ===================== 비슷한 표현 4개 (사전 기반) ===================== */
  const PARAPHRASE_DICT = [
    [/\ba lot of\b/gi, ['plenty of', 'lots of', 'a good amount of', 'quite a few']],
    [/\bi think\b/gi, ['I believe', 'I feel like', 'In my opinion,', 'It seems to me']],
    [/\bi want to\b/gi, ["I'd like to", "I'm planning to", 'I hope to', "I'm hoping to"]],
    [/\bi like\b/gi, ['I enjoy', "I'm a fan of", 'I really like', "I'm into"]],
    [/\bi love\b/gi, ['I really love', 'I adore', "I'm crazy about", 'I truly enjoy']],
    [/\bi feel proud of myself\b/gi, ['I feel really proud', "I'm proud of myself", 'It makes me proud', 'I feel a sense of pride']],
    [/\bmakes? me excited\b/gi, ['get me excited', 'make me feel thrilled', 'make me really happy', 'get me pumped']],
    [/\ba perfect score\b/gi, ['a perfect mark', 'full marks', '100 percent', 'top marks']],
    [/\bstayed at home\b/gi, ['stayed home', 'stayed in', 'spent the day at home', "didn't go out"]],
    [/\bwhere can i\b/gi, ["where's the best place to", 'do you know where I can', 'where would I go to', 'is there a place where I can']],
    [/\bwhere do i\b/gi, ["where's the best place to", 'do you know where I should', 'where should I', 'is there a place where I should']],
    [/\bhow can i\b/gi, ["what's the best way to", 'do you know how I can', 'how would I', 'is there a way I can']],
    [/\bhow do i\b/gi, ["what's the best way to", 'do you know how I should', 'how should I', 'is there a way I should']],
    [/\bwhat should i\b/gi, ['what do you think I should', 'any idea what I should', "what's the best thing to", 'what would you suggest I']],
    [/\bwhen can i\b/gi, ['what time can I', 'do you know when I can', 'when would be a good time to', 'is there a time I can']],
    [/\bdo you know\b/gi, ['could you tell me', 'would you happen to know', 'any idea', 'can you tell me']],
    [/\bcan i\b/gi, ['could I', 'may I', 'is it possible for me to', 'would it be okay if I']],
    [/\bcan you\b/gi, ['could you', 'would you', 'is it possible for you to', 'would you mind if you']],
    [/\bis there\b/gi, ['do you know if there is', 'i wonder if there is', 'could there be', 'by any chance, is there']],
    [/\bhow much\b/gi, ["what's the price for", 'what does it cost for', 'roughly how much', 'about how much']],
    [/\bwhat time\b/gi, ['at what time', 'around what time', 'roughly when', 'do you know what time']],
    [/\bdoesn't like\b/gi, ["isn't a fan of", "doesn't really like", "isn't into", "isn't really keen on"]],
    [/\bdoesn't want\b/gi, ["isn't looking to", "doesn't really want", "isn't interested in", "isn't up for"]],
    [/\bdoesn't have\b/gi, ["is without", "doesn't happen to have", "is missing", "doesn't currently have"]],
    [/\bvisited\b/gi, ['went to', 'traveled to', 'made a trip to', 'stopped by']],
    [/\bwent to\b/gi, ['visited', 'traveled to', 'headed to', 'made a trip to']],
    [/\bwatched\b/gi, ['saw', 'checked out', 'caught', 'sat through']],
    [/\bate\b/gi, ['had', 'grabbed', 'enjoyed', 'tried']],
    [/\bbought\b/gi, ['picked up', 'got', 'purchased', 'grabbed']],
    [/\bmet\b/gi, ['ran into', 'got together with', 'caught up with', 'hung out with']],
    [/\bsaw\b/gi, ['spotted', 'noticed', 'caught sight of', 'ran into']],
    [/\bplayed\b/gi, ['took part in', 'joined in on', 'had a go at', 'enjoyed playing']],
    [/\bstudied\b/gi, ['looked into', 'went over', 'reviewed', 'worked through']],
    [/\bfinished\b/gi, ['wrapped up', 'completed', 'got done with', 'wound up']],
    [/\bstarted\b/gi, ['began', 'kicked off', 'got going on', 'set out on']],
    [/\bdecided\b/gi, ['made up my mind', 'chose', 'settled on', 'went with']],
    [/\bforgot\b/gi, ['couldn’t remember', 'slipped my mind (', 'lost track of', 'blanked on']],
    [/\brealized\b/gi, ['noticed', 'figured out', 'came to see', 'discovered']],
    [/\btried\b/gi, ['gave it a shot', 'attempted', 'gave it a try', 'had a go']],
    [/\bwanted\b/gi, ['felt like', 'was hoping', 'was in the mood for', 'really wanted']],
    [/\bneeded\b/gi, ['had to have', 'required', 'was in need of', 'ended up needing']],
    [/\bhelped\b/gi, ['gave a hand with', 'assisted with', 'lent a hand with', 'pitched in on']],
    [/\bfound\b/gi, ['came across', 'discovered', 'spotted', 'ran across']],
    [/\bwrote\b/gi, ['put together', 'drafted', 'jotted down', 'typed up']],
    [/\bread\b/gi, ['went through', 'looked over', 'got through', 'checked out']],
    [/\bcalled\b/gi, ['phoned', 'gave a call to', 'rang up', 'reached out to']],
    [/\basked\b/gi, ['checked with', 'wondered out loud to', 'reached out to', 'put the question to']],
    [/\bcooked\b/gi, ['made', 'whipped up', 'prepared', 'threw together']],
    [/\bspent\b/gi, ['put in', 'used up', 'set aside', 'devoted']],
    [/\bworked on\b/gi, ['put time into', 'focused on', 'spent time on', 'worked away at']],
    [/\btraveled\b/gi, ['went', 'took a trip', 'traveled around', 'made a trip']],
    [/\barrived\b/gi, ['got in', 'showed up', 'landed', 'made it there']],
    [/\bstayed\b/gi, ['remained', 'hung around', 'stuck around', 'kept staying']],
    [/\bhappy\b/gi, ['glad', 'pleased', 'delighted', 'thrilled']],
    [/\bsad\b/gi, ['upset', 'down', 'unhappy', 'blue']],
    [/\bgood\b/gi, ['great', 'nice', 'solid', 'decent']],
    [/\bbad\b/gi, ['not great', 'poor', 'rough', 'unpleasant']],
    [/\bnice\b/gi, ['great', 'lovely', 'pleasant', 'wonderful']],
    [/\bgreat\b/gi, ['awesome', 'fantastic', 'wonderful', 'excellent']],
    [/\binteresting\b/gi, ['fascinating', 'intriguing', 'engaging', 'compelling']],
    [/\bboring\b/gi, ['dull', 'tedious', 'not very interesting', 'a bit flat']],
    [/\bdifficult\b/gi, ['hard', 'challenging', 'tough', 'tricky']],
    [/\beasy\b/gi, ['simple', 'straightforward', 'not hard', 'a breeze']],
    [/\bimportant\b/gi, ['essential', 'crucial', 'key', 'significant']],
    [/\bexcited\b/gi, ['thrilled', 'pumped', 'stoked', 'really looking forward to it']],
    [/\bproud\b/gi, ['pleased with myself', 'satisfied', 'delighted', 'accomplished']],
    [/\btired\b/gi, ['exhausted', 'worn out', 'sleepy', 'beat']],
    [/\bbusy\b/gi, ['swamped', 'tied up', 'occupied', 'slammed']],
    [/\bcomfortable\b/gi, ['cozy', 'relaxed', 'at ease', 'comfy']],
    [/\bbeautiful\b/gi, ['gorgeous', 'lovely', 'stunning', 'pretty']],
    [/\bexpensive\b/gi, ['pricey', 'costly', 'a bit much', 'overpriced']],
    [/\bcheap\b/gi, ['affordable', 'inexpensive', 'budget-friendly', 'a good deal']],
    [/\bfast\b/gi, ['quick', 'speedy', 'rapid', 'swift']],
    [/\bslow\b/gi, ['sluggish', 'unhurried', 'gradual', 'leisurely']],
    [/\bdelicious\b/gi, ['tasty', 'yummy', 'amazing', 'mouthwatering']],
    [/\bfun\b/gi, ['enjoyable', 'entertaining', 'a good time', 'a blast']],
    [/\bscary\b/gi, ['frightening', 'creepy', 'terrifying', 'spooky']],
    [/\bangry\b/gi, ['mad', 'annoyed', 'frustrated', 'upset']],
    [/\bworried\b/gi, ['concerned', 'anxious', 'nervous', 'uneasy']],
    [/\bnervous\b/gi, ['anxious', 'on edge', 'a little worried', 'jittery']],
    [/\bconfident\b/gi, ['sure of myself', 'self-assured', 'certain', 'assured']],
    [/\bconfused\b/gi, ['puzzled', 'lost', 'mixed up', 'unsure']],
    [/\bfamily\b/gi, ['family members', 'loved ones', 'relatives', 'folks']],
    [/\bfriends\b/gi, ['buddies', 'close friends', 'pals', 'people I know']],
  ];

  function toTitleCaseFirst(str) {
    if (!str) return str;
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  function generateSimilarExpressions(sentence) {
    const base = (sentence || '').trim();
    if (!base) return [];

    const matches = [];
    PARAPHRASE_DICT.forEach(([re, alts]) => {
      const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
      const globalRe = new RegExp(re.source, flags);
      let m;
      while ((m = globalRe.exec(base)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        const overlaps = matches.some(mm => start < mm.end && end > mm.start);
        if (!overlaps) matches.push({ start, end, text: m[0], alts });
        if (globalRe.lastIndex === m.index) globalRe.lastIndex++;
      }
    });
    matches.sort((a, b) => a.start - b.start);

    const rawVariants = [];
    if (matches.length) {
      for (let i = 0; i < 4; i++) {
        let out = '';
        let cursor = 0;
        matches.forEach(mm => {
          out += base.slice(cursor, mm.start);
          const alt = mm.alts[i % mm.alts.length];
          const isCapitalized = mm.text.charAt(0) === mm.text.charAt(0).toUpperCase() && mm.text.charAt(0) !== mm.text.charAt(0).toLowerCase();
          out += isCapitalized ? toTitleCaseFirst(alt) : alt;
          cursor = mm.end;
        });
        out += base.slice(cursor);
        rawVariants.push({ text: out, changed: true });
      }
    }

    const starters = ['Actually, ', 'Honestly, ', 'You know, ', 'To be honest, '];
    const lowerBase = base.charAt(0).toLowerCase() + base.slice(1);
    const seen = new Set();
    const result = [];
    for (let i = 0; i < 4; i++) {
      const v = rawVariants[i];
      let text = (v && !seen.has(v.text)) ? v.text : (starters[i] + lowerBase);
      if (!seen.has(text)) { seen.add(text); result.push(text); }
    }
    let si = 0;
    while (result.length < 4 && si < starters.length) {
      const candidate = starters[si] + lowerBase;
      if (!seen.has(candidate)) { seen.add(candidate); result.push(candidate); }
      si++;
    }
    return result.slice(0, 4);
  }

  /* ===================== 비슷한 표현 4개 — AI 우선, 실패시 사전 기반 대체 ===================== */
  const AI_CACHE_KEY = 'bek_ai_paraphrase_cache_v2';
  const AI_ENDPOINT = '/api/similar-expressions';
  const AI_TIMEOUT_MS = 12000;

  function loadAICache() {
    try {
      const raw = localStorage.getItem(AI_CACHE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }
  function saveAICacheEntry(sentence, variants) {
    try {
      const cache = loadAICache();
      cache[sentence] = variants;
      const keys = Object.keys(cache);
      if (keys.length > 300) delete cache[keys[0]];
      localStorage.setItem(AI_CACHE_KEY, JSON.stringify(cache));
    } catch (e) { /* localStorage 사용 불가 환경이면 그냥 캐싱을 건너뜁니다 */ }
  }
  function getCachedAIVariants(sentence) {
    const v = loadAICache()[sentence];
    return (Array.isArray(v) && v.length === 4) ? v : null;
  }

  async function fetchAIParaphrases(sentence) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
      const res = await fetch(AI_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sentence }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const data = await res.json();
      if (Array.isArray(data.variants) && data.variants.length === 4) return data.variants;
    } catch (e) {
      console.warn('[shadowing] AI 비슷한 표현 생성 실패 — 사전 기반으로 대체합니다.', e);
    }
    return null;
  }

  function buildVariantBlock(sentenceText) {
    const dictVariants = generateSimilarExpressions(sentenceText);
    const cached = getCachedAIVariants(sentenceText);
    const initialVariants = cached || dictVariants;
    const initialIsAI = !!cached;
    if (!initialVariants.length) return null;

    const variantWrap = document.createElement('details');
    variantWrap.className = 'variant-details';
    variantWrap.open = false;

    const summary = document.createElement('summary');
    variantWrap.appendChild(summary);

    const body = document.createElement('div');
    variantWrap.appendChild(body);

    function paint(variants, isAI) {
      summary.textContent = `🗣️ 비슷한 표현 ${variants.length}개로 더 연습하기${isAI ? ' (AI)' : ''}`;
      body.innerHTML = '';
      variants.forEach(vText => {
        const vEl = document.createElement('div');
        vEl.className = 'item variant-item';
        const vLine = document.createElement('div');
        vLine.className = 'o-line';
        vLine.textContent = `➜ ${vText}`;
        vEl.appendChild(vLine);
        vEl.appendChild(buildShadowingControls(vText));
        body.appendChild(vEl);
      });
    }

    paint(initialVariants, initialIsAI);

    if (!cached) {
      fetchAIParaphrases(sentenceText).then(aiVariants => {
        if (!aiVariants) return;
        saveAICacheEntry(sentenceText, aiVariants);
        if (!variantWrap.isConnected) return;
        paint(aiVariants, true);
      });
    }

    return variantWrap;
  }

  /* ===================== 전체 요약 텍스트 (복사용) ===================== */
  // 회차의 문장(교정 전/후 + 문법 해석)과 단어를 사람이 읽기 좋은 텍스트로 모아줍니다.
  function buildSummaryText(sentences, words) {
    const lines = [];
    if (sentences && sentences.length) {
      lines.push('=== 문장 ===');
      sentences.forEach((item, idx) => {
        const x = stripLeadingLabel(item.x);
        const o = stripLeadingLabel(item.o);
        lines.push('');
        lines.push(`[${idx + 1}]`);
        if (x) lines.push(`교정 전: ${x}`);
        lines.push(`교정 후: ${o}`);
        if (x) lines.push(`문법 해석: ${explainDifference(x, o)}`);
      });
    }
    if (words && words.length) {
      lines.push('');
      lines.push('=== 단어 ===');
      words.forEach(w => lines.push(stripLeadingLabel(w)));
    }
    return lines.length ? lines.join('\n') : '아직 등록된 내용이 없어요.';
  }

  /* ===================== 연습 화면 전체 렌더링 (문장 카드 + 단어 카드 + 요약) =====================
     member.html(회원 연습 화면)과 admin.html(관리자 미리보기)이 똑같은 화면을 그릴 수 있도록
     공용화했습니다. container 안의 내용을 지우고 다시 그립니다. */
  function renderPracticeSet(container, set) {
    container.innerHTML = '';
    const sentences = (set && set.sentences) || [];
    const words = (set && set.words) || [];

    if (sentences.length) {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<h2>① 문장 쉐도잉</h2><div class="card-desc">각 문장을 듣고, 마이크로 따라 말해보세요.</div>`;
      const list = document.createElement('div');
      list.className = 'list';
      sentences.forEach(item => {
        const x = stripLeadingLabel(item.x);
        const o = stripLeadingLabel(item.o);
        const explanation = x ? explainDifference(x, o) : '';
        const el = document.createElement('div');
        el.className = 'item';
        el.innerHTML = `
          <div class="item-top">
            <div style="flex:1;">
              ${x && !item.hideX ? `<div class="x-line">✗ ${escapeHTML(x)}</div>` : ''}
              <div class="o-line">✓ ${escapeHTML(o)}</div>
              <div class="kr-meaning">🇰🇷 뜻: <span class="kr-text">번역 중...</span></div>
              ${explanation ? `<div class="explain-block">🔎 <b>왜 틀렸을까요?</b> ${escapeHTML(explanation)}</div>` : ''}
            </div>
          </div>
        `;
        loadTranslationInto(el.querySelector('.kr-meaning .kr-text'), o);
        el.appendChild(buildShadowingControls(o));
        const variantBlock = buildVariantBlock(o);
        if (variantBlock) el.appendChild(variantBlock);
        list.appendChild(el);
      });
      card.appendChild(list);
      container.appendChild(card);
    }

    if (words.length) {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<h2>② 단어 발음 연습</h2><div class="card-desc">단어를 듣고, 마이크로 따라 말해보세요.</div>`;
      const list = document.createElement('div');
      list.className = 'list';
      words.forEach(rawWord => {
        const w = stripLeadingLabel(rawWord);
        const el = document.createElement('div');
        el.className = 'item';
        el.innerHTML = `
          <div class="item-top">
            <div style="flex:1;">
              <div class="word-line">${escapeHTML(w)}</div>
              <div class="kr-meaning">🇰🇷 뜻: <span class="kr-text">번역 중...</span></div>
            </div>
          </div>
        `;
        loadTranslationInto(el.querySelector('.kr-meaning .kr-text'), w);
        el.appendChild(buildShadowingControls(w));
        list.appendChild(el);
      });
      card.appendChild(list);
      container.appendChild(card);
    }

    if (!sentences.length && !words.length) {
      container.innerHTML = '<div class="empty">이 회차에는 아직 등록된 문장/단어가 없어요.</div>';
      return;
    }

    const summaryCard = document.createElement('div');
    summaryCard.className = 'card';
    summaryCard.innerHTML = `
      <h2>📋 전체 요약 (복사용)</h2>
      <div class="card-desc">이 회차의 문장 교정 전/후·문법 해석과 단어를 한 번에 모아서 볼 수 있어요. 아래 내용을 복사해서 노트나 문서에 붙여넣을 수 있습니다.</div>
      <textarea readonly class="summary-area" style="min-height:240px; font-family:ui-monospace,Menlo,Consolas,monospace; font-size:0.82rem; white-space:pre-wrap; width:100%; resize:vertical; background:var(--input-bg); border:1px solid var(--border); border-radius:10px; color:var(--text); padding:10px 12px; box-sizing:border-box;"></textarea>
      <div class="row">
        <button class="btn-primary btn-small copy-summary-btn">📋 전체 복사하기</button>
      </div>
      <div class="copy-status" style="font-size:0.82rem; color:var(--muted); margin-top:8px;"></div>
    `;
    const summaryArea = summaryCard.querySelector('.summary-area');
    summaryArea.value = buildSummaryText(sentences, words);
    const copyStatus = summaryCard.querySelector('.copy-status');
    summaryCard.querySelector('.copy-summary-btn').addEventListener('click', async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(summaryArea.value);
        } else {
          summaryArea.select();
          document.execCommand('copy');
        }
        copyStatus.textContent = '✅ 복사했어요! 원하는 곳에 붙여넣기(Ctrl+V / Cmd+V) 하세요.';
      } catch (err) {
        summaryArea.select();
        copyStatus.textContent = '⚠️ 자동 복사에 실패했어요. 위 텍스트 상자가 선택되어 있으니 Ctrl+C / Cmd+C로 직접 복사해주세요.';
      }
    });
    container.appendChild(summaryCard);
  }

  global.ShadowingEngine = {
    escapeHTML,
    translateText,
    loadTranslationInto,
    hasTTS,
    hasSTT,
    isMobileDevice,
    isSecureContextForMic,
    compareWords,
    buildShadowingControls,
    explainDifference,
    generateSimilarExpressions,
    buildVariantBlock,
    parseFeedbackBlock,
    parseWordsBlock,
    stripLeadingLabel,
    buildSummaryText,
    renderPracticeSet,
  };
})(window);
