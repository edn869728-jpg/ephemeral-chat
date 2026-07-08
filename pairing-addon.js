/* 私・話 v4.5｜12 碼邀請碼＋QR Code 一次性配對 */
(() => {
  'use strict';

  const CODE_LENGTH = 12;
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const QR_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
  let activePairingId = '';
  let activePairCode = '';
  let statusTimer = null;

  const $p = (id) => document.getElementById(id);

  function status(text) {
    try { if (typeof setStatus === 'function') setStatus(text); }
    catch (_) { const bar = $p('statusBar'); if (bar) bar.textContent = text; }
  }

  function normalizeCode(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z2-9]/g, '').replace(/[IO01]/g, '').slice(0, CODE_LENGTH);
  }

  function formatCode(value) {
    const code = normalizeCode(value);
    return code.match(/.{1,4}/g)?.join('-') || code;
  }

  function generateCode() {
    const bytes = new Uint8Array(CODE_LENGTH);
    crypto.getRandomValues(bytes);
    let code = '';
    for (const byte of bytes) code += ALPHABET[byte & 31];
    return code;
  }

  async function digest(text) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  }

  function hex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function base64url(bytes) {
    if (typeof bytesToBase64Url === 'function') return bytesToBase64Url(bytes);
    let binary = '';
    bytes.forEach((b) => { binary += String.fromCharCode(b); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  async function materialFromCode(value) {
    const code = normalizeCode(value);
    if (code.length !== CODE_LENGTH) throw new Error('請輸入完整 12 碼邀請碼。');
    const pairHash = await digest(`private-chat-pair-id-v1:${code}`);
    const keyHash = await digest(`private-chat-pair-key-v1:${code}`);
    return {
      code,
      pairingId: `p_${hex(pairHash).slice(0, 40)}`,
      sealedKey: base64url(keyHash)
    };
  }

  function codeFromHash() {
    const raw = String(location.hash || '').replace(/^#/, '');
    if (!raw) return '';
    const params = new URLSearchParams(raw);
    return normalizeCode(params.get('pair') || params.get('code') || '');
  }

  function pairingUrl(code) {
    const url = new URL('./', location.href);
    url.search = '';
    url.hash = `pair=${encodeURIComponent(normalizeCode(code))}`;
    return url.toString();
  }

  function settingsFromForm() {
    try {
      const base = typeof getSettingsFromForm === 'function' ? getSettingsFromForm() : {};
      return {
        displaySeconds: Math.max(15, Math.min(60, Number(base.displaySeconds || 20))),
        sealedBubbleSeconds: 300,
        messageTtlSeconds: 21600,
        inviteTtlSeconds: Math.max(60, Math.min(21600, Number($p('inviteTtlSeconds')?.value || 1800)))
      };
    } catch (_) {
      return { displaySeconds: 20, sealedBubbleSeconds: 300, messageTtlSeconds: 21600, inviteTtlSeconds: 1800 };
    }
  }

  function installEntryUi() {
    const setup = $p('setupView');
    if (setup && !$p('pairEntryCard')) {
      const card = document.createElement('section');
      card.id = 'pairEntryCard';
      card.className = 'pair-entry-card';
      card.innerHTML = `
        <div class="pair-entry-title">已有邀請碼</div>
        <div class="pair-entry-row">
          <input id="pairCodeInput" class="pair-code-input" inputmode="text" autocomplete="one-time-code" maxlength="14" placeholder="XXXX-XXXX-XXXX">
          <button id="pairJoinBtn" class="pair-join-btn" type="button">配對進入</button>
        </div>
        <p class="pair-entry-note">也可以直接用手機相機掃描對方畫面上的 QR Code。</p>`;
      const actions = setup.querySelector('.main-actions, .button-row');
      if (actions) setup.insertBefore(card, actions);
      else setup.appendChild(card);
    }

    const accept = $p('acceptView');
    if (accept && !$p('acceptPairCodeInput')) {
      const card = document.createElement('section');
      card.className = 'pair-entry-card';
      card.innerHTML = `
        <div class="pair-entry-title">配對邀請碼</div>
        <input id="acceptPairCodeInput" class="pair-code-input" inputmode="text" autocomplete="one-time-code" maxlength="14" placeholder="XXXX-XXXX-XXXX">
        <p class="pair-entry-note">QR Code 開啟時會自動帶入；也可以手動輸入。</p>`;
      const label = accept.querySelector('label[for="guestName"]');
      if (label) accept.insertBefore(card, label);
      else accept.prepend(card);
    }

    ['pairCodeInput', 'acceptPairCodeInput'].forEach((id) => {
      const input = $p(id);
      if (!input || input.dataset.pairBound) return;
      input.dataset.pairBound = '1';
      input.addEventListener('input', () => { input.value = formatCode(input.value); });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          acceptPair(input.value);
        }
      });
    });

    const join = $p('pairJoinBtn');
    if (join && !join.dataset.pairBound) {
      join.dataset.pairBound = '1';
      join.addEventListener('click', () => acceptPair($p('pairCodeInput')?.value || ''));
    }
  }

  function installCreatedUi() {
    const panel = $p('invitePanel');
    if (!panel) return;
    if ($p('pairCodeCard')) return;
    const card = document.createElement('section');
    card.id = 'pairCodeCard';
    card.className = 'pair-code-card';
    card.innerHTML = `
      <div class="pair-code-title">邀請碼／QR Code 配對</div>
      <div class="pair-code-grid">
        <div>
          <div id="pairCodeValue" class="pair-code-value">----</div>
          <div class="pair-code-actions">
            <button id="copyPairCodeBtn" class="pair-copy-btn" type="button">複製邀請碼</button>
            <button id="copyPairLinkBtn" class="pair-link-btn" type="button">複製連結</button>
          </div>
          <div id="pairLiveState" class="pair-state waiting"><span class="pair-state-light"></span><span>等待對方配對</span></div>
          <p class="pair-code-note">對方可輸入 12 碼，或用相機掃描 QR Code。接受後邀請立即失效。</p>
        </div>
        <div id="pairQr" class="pair-qr"><div class="pair-qr-fallback">正在產生 QR Code…</div></div>
      </div>`;
    const textarea = $p('inviteLink');
    if (textarea) panel.insertBefore(card, textarea);
    else panel.appendChild(card);
    $p('copyPairCodeBtn')?.addEventListener('click', () => copyText(formatCode(activePairCode), '邀請碼已複製。'));
    $p('copyPairLinkBtn')?.addEventListener('click', () => copyText($p('inviteLink')?.value || '', '配對連結已複製。'));
  }

  async function loadQr() {
    if (window.QRCode) return true;
    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = QR_LIB;
      script.async = true;
      script.onload = () => resolve(Boolean(window.QRCode));
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
  }

  async function renderQr(text) {
    const box = $p('pairQr');
    if (!box) return;
    box.replaceChildren();
    if (!await loadQr()) {
      box.innerHTML = '<div class="pair-qr-fallback">QR Code 載入失敗，請改用邀請碼或複製連結。</div>';
      return;
    }
    new window.QRCode(box, {
      text,
      width: 172,
      height: 172,
      colorDark: '#07162f',
      colorLight: '#ffffff',
      correctLevel: window.QRCode.CorrectLevel.M
    });
  }

  async function createPairInvite() {
    const button = $p('createInviteBtn');
    const label = typeof getIdentityFromInputs === 'function' ? getIdentityFromInputs('displayName', '我') : '我';
    const settings = settingsFromForm();
    try {
      if (typeof setBusy === 'function') setBusy(button, true, '建立配對中…');
      if (typeof saveIdentity === 'function') saveIdentity(label);
      if (typeof saveLocalSettings === 'function') saveLocalSettings(settings);
      const material = await materialFromCode(generateCode());
      const data = await api('createPairing', { pairingId: material.pairingId, settings });
      const remote = data.session || {};
      const nextSession = {
        role: 'creator',
        myChannel: remote.myChannel,
        peerChannel: remote.peerChannel,
        sealedKey: material.sealedKey,
        label,
        settings: remote.settings || settings,
        pairingId: material.pairingId,
        createdAt: Date.now()
      };
      session = typeof normalizeSessionSettings === 'function' ? normalizeSessionSettings(nextSession) : nextSession;
      if (typeof saveSession === 'function') saveSession(session);

      activePairingId = material.pairingId;
      activePairCode = material.code;
      const link = pairingUrl(material.code);
      if ($p('inviteLink')) $p('inviteLink').value = link;
      $p('invitePanel')?.classList.remove('hidden');
      installCreatedUi();
      if ($p('pairCodeValue')) $p('pairCodeValue').textContent = formatCode(material.code);
      renderQr(link);
      startStatusPolling();
      status('邀請碼與 QR Code 已建立，等待對方配對。');
    } catch (err) {
      status(err?.message || '建立配對失敗。請確認 GAS 已換成 v4.5。');
    } finally {
      if (typeof setBusy === 'function') setBusy(button, false, '建立專屬對話');
    }
  }

  async function acceptPair(value) {
    const source = value || codeFromHash() || $p('acceptPairCodeInput')?.value || $p('pairCodeInput')?.value || '';
    const acceptVisible = $p('acceptView') && !$p('acceptView').classList.contains('hidden');
    const button = acceptVisible ? $p('acceptInviteBtn') : $p('pairJoinBtn');
    const label = typeof getIdentityFromInputs === 'function'
      ? getIdentityFromInputs(acceptVisible ? 'guestName' : 'displayName', '我')
      : '我';
    try {
      if (typeof setBusy === 'function') setBusy(button, true, '配對中…');
      const material = await materialFromCode(source);
      const data = await api('acceptPairing', { pairingId: material.pairingId });
      const remote = data.session || {};
      const nextSession = {
        role: 'guest',
        myChannel: remote.myChannel,
        peerChannel: remote.peerChannel,
        sealedKey: material.sealedKey,
        label,
        settings: remote.settings || settingsFromForm(),
        pairingId: material.pairingId,
        createdAt: Date.now()
      };
      session = typeof normalizeSessionSettings === 'function' ? normalizeSessionSettings(nextSession) : nextSession;
      if (typeof saveIdentity === 'function') saveIdentity(label);
      if (typeof saveSession === 'function') saveSession(session);
      history.replaceState({}, '', new URL('./', location.href).toString());
      if (typeof enterChat === 'function') enterChat();
      status('配對成功，雙方已進入同一組加密頻道。');
    } catch (err) {
      status(err?.message || '邀請碼錯誤、已使用或已過期。');
    } finally {
      if (typeof setBusy === 'function') setBusy(button, false, button?.id === 'pairJoinBtn' ? '配對進入' : '接受配對並加入');
    }
  }

  async function pollStatus() {
    if (!activePairingId) return;
    try {
      const data = await api('pairingStatus', { pairingId: activePairingId });
      const state = String(data.state || 'expired');
      const box = $p('pairLiveState');
      if (!box) return;
      const label = box.querySelector('span:last-child');
      if (state === 'accepted') {
        box.className = 'pair-state accepted';
        label.textContent = '對方已配對，可以進入對話';
        clearInterval(statusTimer);
        statusTimer = null;
        status('對方已完成配對。');
      } else if (state === 'waiting') {
        const left = Math.max(0, Math.ceil((Number(data.expiresAt || 0) - Date.now()) / 1000));
        box.className = 'pair-state waiting';
        label.textContent = `等待對方配對${left ? `｜剩 ${Math.ceil(left / 60)} 分` : ''}`;
      } else {
        box.className = 'pair-state error';
        label.textContent = state === 'canceled' ? '邀請已取消' : '邀請已失效';
        clearInterval(statusTimer);
        statusTimer = null;
      }
    } catch (_) {
      const box = $p('pairLiveState');
      if (box) {
        box.className = 'pair-state error';
        box.querySelector('span:last-child').textContent = '讀不到配對狀態';
      }
    }
  }

  function startStatusPolling() {
    clearInterval(statusTimer);
    pollStatus();
    statusTimer = setInterval(pollStatus, 1600);
  }

  async function copyText(text, done) {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); }
    catch (_) {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    status(done);
  }

  function showAcceptFromQr() {
    const code = codeFromHash();
    if (!code) return;
    installEntryUi();
    if ($p('acceptPairCodeInput')) $p('acceptPairCodeInput').value = formatCode(code);
    if ($p('pairCodeInput')) $p('pairCodeInput').value = formatCode(code);
    if (typeof showAcceptView === 'function') showAcceptView();
    const title = $p('acceptView')?.querySelector('h1');
    if (title) title.textContent = '掃描成功，加入私・話';
    const button = $p('acceptInviteBtn');
    if (button) button.textContent = '接受配對並加入';
  }

  try { createInvite = createPairInvite; window.createInvite = createPairInvite; } catch (_) { window.createInvite = createPairInvite; }
  try { acceptInvite = () => acceptPair(); window.acceptInvite = () => acceptPair(); } catch (_) { window.acceptInvite = () => acceptPair(); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installEntryUi, { once: true });
  else installEntryUi();
  window.addEventListener('load', showAcceptFromQr);
  window.addEventListener('beforeunload', () => clearInterval(statusTimer));
})();
