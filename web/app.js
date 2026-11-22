(() => {
  'use strict';

  const STRINGS = {
    en: {
      title: 'YouTube Transcript',
      tagline: 'Paste a YouTube link. Get the full timed transcript.',
      submit: 'Transcribe',
      settings: 'Settings',
      close: 'Close',
      keyLabel: 'Gemini API key',
      keyHint:
        'Your key is kept only in this browser (localStorage). Saving checks it once against Gemini directly; the service sees it only when you submit a URL.',
      keySaved: 'Key stored in this browser.',
      keyAbsent: 'No key stored.',
      keyChecking: 'Checking the key with Gemini…',
      keyValid: 'Key verified — it can use the model this service runs.',
      keyCheckFailed: 'The key is stored, but the check could not reach Gemini. Check your connection.',
      save: 'Save',
      remove: 'Remove',
      urlPlaceholder: 'https://youtu.be/…',
      needKey: 'Add your Gemini API key in Settings first.',
      queued: 'Job queued…',
      running: 'Transcribing… a long video can take a few minutes.',
      copied: 'Copied to clipboard.',
      copyFailed: 'Copy failed. Select the text and copy it manually.',
      copy: 'Copy',
      downloadTxt: 'Download .txt',
      downloadSrt: 'Download .srt',
      errInvalidUrl: 'That is not a valid YouTube link.',
      errVideoUnavailable:
        'This video cannot be read. It may be private, members-only, age-restricted or removed.',
      errKeyRejected: 'Gemini rejected that API key. Check it in Settings.',
      errQuota:
        'The Gemini quota for this key is used up. Try again later or use another key.',
      errTimeout: 'The request timed out. Please try again.',
      errBadOutput:
        'The model returned a result the service could not read. Please try again.',
      errInvalidConfig: 'The service is misconfigured.',
      errInternal: 'Something went wrong on the service. Please try again.',
      errNotFound:
        'That job is gone (the service may have restarted). Please submit it again.',
      errUnauthorized: 'This service requires an access token.',
      errInvalidRequest:
        'The request was not valid. Please reload the page and try again.',
      errNetwork: 'Cannot reach the service. Check your connection.',
      signIn: 'Sign in',
      signOut: 'Sign out',
      savedTo: 'Saved to Drive: ',
      errSaveFailed: 'The transcript could not be saved to the configured destination.',
      errSaveUnauthorized: 'This caller is not allowed to save to that destination.',
      errNoTenant: 'Your sign-in is not linked to a tenant, so nothing was saved.',
      errRateLimited: 'Too many jobs in the last hour. Try again later.',
      errVideoTooLong: 'This video is longer than the limit for your account.',
    },
    zh: {
      title: 'YouTube 逐字稿',
      tagline: '貼上 YouTube 連結，取得完整的時間戳逐字稿。',
      submit: '產生逐字稿',
      settings: '設定',
      close: '關閉',
      keyLabel: 'Gemini API 金鑰',
      keyHint:
        '金鑰只會保存在這個瀏覽器中（localStorage）。儲存時會直接向 Gemini 驗證一次；只有在您送出網址時才會傳給服務。',
      keySaved: '金鑰已儲存在此瀏覽器。',
      keyAbsent: '尚未儲存金鑰。',
      keyChecking: '正在向 Gemini 驗證金鑰……',
      keyValid: '金鑰驗證成功——可使用本服務的模型。',
      keyCheckFailed: '金鑰已儲存，但無法連線到 Gemini 驗證，請檢查網路連線。',
      save: '儲存',
      remove: '移除',
      urlPlaceholder: 'https://youtu.be/…',
      needKey: '請先在設定中輸入您的 Gemini API 金鑰。',
      queued: '工作已排入佇列……',
      running: '產生中……影片較長時可能需要幾分鐘。',
      copied: '已複製到剪貼簿。',
      copyFailed: '複製失敗，請選取文字後手動複製。',
      copy: '複製',
      downloadTxt: '下載 .txt',
      downloadSrt: '下載 .srt',
      errInvalidUrl: '這不是有效的 YouTube 連結。',
      errVideoUnavailable:
        '無法讀取這部影片，可能是私人影片、會員限定、有年齡限制或已移除。',
      errKeyRejected: 'Gemini 拒絕了這組 API 金鑰，請到設定中確認。',
      errQuota: '這組金鑰的 Gemini 配額已用盡，請稍後再試或改用其他金鑰。',
      errTimeout: '請求逾時，請再試一次。',
      errBadOutput: '模型回傳了服務無法解讀的結果，請再試一次。',
      errInvalidConfig: '服務設定有誤。',
      errInternal: '服務發生錯誤，請再試一次。',
      errNotFound: '該工作已不存在（服務可能重新啟動），請重新送出。',
      errUnauthorized: '此服務需要存取權杖。',
      errInvalidRequest: '請求格式有誤，請重新整理頁面後再試。',
      errNetwork: '無法連線到服務，請檢查網路連線。',
      signIn: '登入',
      signOut: '登出',
      savedTo: '已儲存到雲端硬碟：',
      errSaveFailed: '逐字稿無法儲存到設定的目的地。',
      errSaveUnauthorized: '此呼叫者沒有儲存到該目的地的權限。',
      errNoTenant: '您的登入未連結到任何租戶，因此沒有儲存。',
      errRateLimited: '這一小時內的工作數已達上限，請稍後再試。',
      errVideoTooLong: '這部影片超過您帳號的長度上限。',
    },
  };

  const ERROR_KEYS = {
    invalid_url: 'errInvalidUrl',
    video_unavailable: 'errVideoUnavailable',
    missing_key: 'needKey',
    key_rejected: 'errKeyRejected',
    quota_exceeded: 'errQuota',
    upstream_timeout: 'errTimeout',
    bad_model_output: 'errBadOutput',
    invalid_config: 'errInvalidConfig',
    internal_error: 'errInternal',
    not_found: 'errNotFound',
    unauthorized: 'errUnauthorized',
    invalid_request: 'errInvalidRequest',
    save_failed: 'errSaveFailed',
    save_unauthorized: 'errSaveUnauthorized',
    no_tenant: 'errNoTenant',
    rate_limited: 'errRateLimited',
    video_too_long: 'errVideoTooLong',
  };

  const lang = /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
  document.documentElement.lang = lang === 'zh' ? 'zh-Hant' : 'en';
  const t = (key) => STRINGS[lang][key] ?? STRINGS.en[key] ?? key;

  const $ = (id) => document.getElementById(id);
  const form = $('job-form');
  const urlInput = $('url-input');
  const submitBtn = $('submit-btn');
  const statusBox = $('status');
  const statusText = $('status-text');
  const spinner = $('spinner');
  const resultBox = $('result');
  const blocksList = $('blocks');
  const settingsBtn = $('settings-btn');
  const drawer = $('settings-drawer');
  const backdrop = $('drawer-backdrop');
  const keyInput = $('key-input');
  const keyState = $('key-state');
  const saveKeyBtn = $('save-key');
  const removeKeyBtn = $('remove-key');
  const closeDrawerBtn = $('close-drawer');
  const copyBtn = $('copy-btn');
  const txtBtn = $('download-txt');
  const srtBtn = $('download-srt');
  const authBox = $('auth-box');
  const signinLink = $('signin-link');
  const signedIn = $('signed-in');
  const userLabel = $('user-label');
  const savedLine = $('saved-line');
  const savedLink = $('saved-link');
  const saveNote = $('save-note');
  const versionFooter = $('version-footer');

  const LS_KEY = 'geminiApiKey';
  const POLL_MS = 1500;
  const getKey = () => localStorage.getItem(LS_KEY) || '';

  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  urlInput.placeholder = t('urlPlaceholder');

  // Sign-in exists only when the service is configured for it: /auth/me
  // answers 404 on a self-hosted instance without OIDC and the box stays
  // hidden, keeping the page anonymous.
  (async () => {
    try {
      const res = await fetch('/auth/me');
      if (!res.ok) return;
      const me = await res.json().catch(() => ({}));
      if (!me?.enabled) return;
      authBox.hidden = false;
      if (me.signed_in) {
        signedIn.hidden = false;
        signinLink.hidden = true;
        userLabel.textContent = me.tenant ? `${me.email} · ${me.tenant}` : (me.email ?? '');
      } else {
        signinLink.hidden = false;
        signedIn.hidden = true;
      }
    } catch {
      // The page works without sign-in state.
    }
  })();

  let transcript = null;
  let busy = false;

  function showStatus(text, { working = false, error = false } = {}) {
    statusBox.hidden = false;
    statusBox.classList.toggle('error', error);
    spinner.hidden = !working;
    statusText.textContent = text;
  }

  function hideStatus() {
    statusBox.hidden = true;
    statusBox.classList.remove('error');
    spinner.hidden = true;
    statusText.textContent = '';
  }

  function codeMessage(code) {
    return t(ERROR_KEYS[code] ?? 'errInternal');
  }

  function refreshKeyState() {
    keyState.textContent = getKey() ? t('keySaved') : t('keyAbsent');
    keyState.dataset.state = getKey() ? 'saved' : 'absent';
  }

  function openDrawer() {
    drawer.hidden = false;
    backdrop.hidden = false;
    refreshKeyState();
    keyInput.focus();
  }

  function closeDrawer() {
    drawer.hidden = true;
    backdrop.hidden = true;
    keyInput.value = '';
  }

  settingsBtn.addEventListener('click', openDrawer);
  closeDrawerBtn.addEventListener('click', closeDrawer);
  backdrop.addEventListener('click', closeDrawer);

  saveKeyBtn.addEventListener('click', () => {
    const value = keyInput.value.trim();
    if (value) {
      localStorage.setItem(LS_KEY, value);
      keyInput.value = '';
      void verifyKey(value);
      return;
    }
    refreshKeyState();
  });

  // The service's non-secret config, fetched once — the key check probes
  // the model it names, and the footer shows the build identity. A failed
  // fetch is not cached so the next Save retries.
  let configPromise = null;
  function serviceConfig() {
    configPromise ??= fetch('/v1/config')
      .then(async (res) => {
        if (!res.ok) throw new Error('config unavailable');
        return res.json();
      })
      .catch((err) => {
        configPromise = null;
        throw err;
      });
    return configPromise;
  }

  async function configuredModel() {
    const body = await serviceConfig();
    if (typeof body?.model !== 'string' || body.model === '') {
      throw new Error('config has no model');
    }
    return body.model;
  }

  // The build this service runs, bottom of the page, so a bug report can
  // name it. Stays hidden when the config cannot be read.
  (async () => {
    try {
      const body = await serviceConfig();
      if (typeof body?.version !== 'string' || body.version === '') return;
      const commit =
        typeof body?.commit === 'string' && body.commit !== '' && body.commit !== 'unknown'
          ? ` · ${body.commit.slice(0, 7)}`
          : '';
      versionFooter.textContent = `fisheraiagent ${body.version}${commit}`;
      versionFooter.hidden = false;
    } catch {
      // The page works without the footer.
    }
  })();

  // Save-time key check (the browser-side design): one models.get call
  // straight to Gemini with the key in the x-goog-api-key header, so the
  // key never reaches this service for the check. The result lands in the
  // key-state line: valid, invalid, out of quota, or check failed.
  let checkSeq = 0;
  async function verifyKey(key) {
    const seq = ++checkSeq;
    const show = (state, textKey) => {
      // A newer Save (or Remove, which drops the stored key) wins.
      if (seq !== checkSeq || getKey() !== key) return;
      keyState.dataset.state = state;
      keyState.textContent = t(textKey);
    };
    show('checking', 'keyChecking');
    try {
      const model = await configuredModel();
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`,
        { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(10_000) },
      );
      if (res.status === 200) show('valid', 'keyValid');
      else if (res.status === 429) show('quota', 'errQuota');
      else if (res.status === 400 || res.status === 401 || res.status === 403) {
        show('invalid', 'errKeyRejected');
      } else show('unavailable', 'keyCheckFailed');
    } catch {
      show('unavailable', 'keyCheckFailed');
    }
  }

  removeKeyBtn.addEventListener('click', () => {
    localStorage.removeItem(LS_KEY);
    refreshKeyState();
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function pollJob(jobId) {
    for (;;) {
      await sleep(POLL_MS);
      const res = await fetch(`/v1/jobs/${encodeURIComponent(jobId)}`);
      const body = await res.json().catch(() => ({}));
      if (res.status !== 200) return { status: 'failed', error: body?.error ?? { code: 'internal_error' } };
      if (body.status === 'done' || body.status === 'failed') return body;
      showStatus(t(body.status === 'queued' ? 'queued' : 'running'), { working: true });
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    resultBox.hidden = true;
    savedLine.hidden = true;
    savedLink.textContent = '';
    savedLink.removeAttribute('href');
    saveNote.textContent = '';
    transcript = null;

    const key = getKey();
    if (!key) {
      showStatus(t('needKey'), { error: true });
      openDrawer();
      return;
    }

    busy = true;
    submitBtn.disabled = true;
    showStatus(t('queued'), { working: true });
    try {
      const res = await fetch('/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-gemini-key': key },
        body: JSON.stringify({ url: urlInput.value.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status !== 202) {
        showStatus(codeMessage(body?.error?.code), { error: true });
        return;
      }
      const job = await pollJob(body.job_id);
      if (job.status === 'done' && job.result) {
        renderResult(job.result);
        renderSave(job);
        hideStatus();
      } else {
        showStatus(codeMessage(job?.error?.code), { error: true });
      }
    } catch {
      showStatus(t('errNetwork'), { error: true });
    } finally {
      busy = false;
      submitBtn.disabled = false;
    }
  });

  function fmtClock(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }

  function srtTime(seconds) {
    const ms = Math.max(0, Math.round(seconds * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const rem = ms % 1000;
    const pad = (n, w) => String(n).padStart(w, '0');
    return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(rem, 3)}`;
  }

  const toTxt = (t_) =>
    t_.blocks.map((b) => `[${fmtClock(b.start)}] ${b.text}`).join('\n') + '\n';

  const toSrt = (t_) =>
    t_.blocks
      .map((b, i) => `${i + 1}\n${srtTime(b.start)} --> ${srtTime(b.end)}\n${b.text}`)
      .join('\n\n') + '\n';

  function renderResult(result) {
    transcript = result;
    blocksList.replaceChildren();
    for (const block of result.blocks) {
      const li = document.createElement('li');
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = `[${fmtClock(block.start)}]`;
      const text = document.createElement('span');
      text.textContent = block.text;
      li.append(ts, text);
      blocksList.append(li);
    }
    resultBox.hidden = false;
  }

  // After a signed-in tenant's job, the saved-file link or the fixed
  // save/skip message rides on the job payload.
  function renderSave(job) {
    if (job?.saved?.url) {
      savedLink.href = job.saved.url;
      savedLink.textContent = `${t('savedTo')}${job.saved.name || job.saved.url}`;
      saveNote.textContent = '';
      savedLine.hidden = false;
      return;
    }
    if (job?.save_error?.code) {
      savedLink.removeAttribute('href');
      savedLink.textContent = '';
      saveNote.textContent = codeMessage(job.save_error.code);
      savedLine.hidden = false;
    }
  }

  copyBtn.addEventListener('click', async () => {
    if (!transcript) return;
    const text = toTxt(transcript);
    try {
      await navigator.clipboard.writeText(text);
      showStatus(t('copied'));
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.append(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      showStatus(t(ok ? 'copied' : 'copyFailed'), { error: !ok });
    }
  });

  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  txtBtn.addEventListener('click', () => {
    if (transcript) download(`transcript-${transcript.video_id}.txt`, toTxt(transcript), 'text/plain');
  });
  srtBtn.addEventListener('click', () => {
    if (transcript) download(`transcript-${transcript.video_id}.srt`, toSrt(transcript), 'application/x-subrip');
  });
})();
