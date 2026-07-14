/*
 * 私・話 v4.5｜12 碼邀請碼＋QR Code 一次性配對
 * - 代碼只存在兩台裝置；GAS 只看到 SHA-256 配對識別碼
 * - 雙方由同一邀請碼本機推導 AES 密鑰
 * - GAS 只發放一對隨機頻道，避免舊版頻道不同步造成收不到訊息
 */
(() => {
  'use strict';

  const PAIR_CODE_LENGTH = 12;
  const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 字元，避開 I/O/0/1
  const PAIR_STATUS_MS = 1600;
  const QR_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
  let activePairingId = '';
  let activePairCode = '';
  let pairStatusTimer = null;

  const el = (id) => document.getElementById(id);

  function setStatusSafe(text) {
    try { if (typeof setStatus === 'function') setStatus(text); }
    catch (_) { const bar = el('statusBar'); if (bar) bar.textContent = text; }
  }

  function normalizeCode(value) {
    return String(value || '')
      .toUpperCase()
      .replace(/[^A-Z2-9]/g, '')
      .replace(/[IO01]/g, '')
      .slice(0, PAIR_CODE_LENGTH);
  }

  function formatCode(value) {
    const code = normalizeCode(value);
    return code.match(/.{1,4}/g)?.join('-') || code;
  }

  function generateCode() {
    const bytes = new Uint8Array(PAIR_CODE_LENGTH);
    crypto.getRandomValues(bytes);
    let out = '';
    for (const byte of bytes) out += PAIR_ALPHABET[byte & 31];
    return out;
  }

  async function digestBytes(text) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  }

  function toHex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function toBase64Url(bytes) {
    if (typeof bytesToBase64Url === 'function') return bytesToBase64Url(bytes);
    let binary = '';
    bytes.forEach((b) => { binary += String.fromCharCode(b); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  async function pairingMaterial(code) {
    const clean = normalizeCode(code);
    if (clean.length !== PAIR_CODE_LENGTH) throw new Error('請輸入完整 12 碼邀請碼。');
    const pairingHash = await digestBytes(`private-chat-pair-id-v1:${clean}`);
    const keyHash = await digestBytes(`private-chat-pair-key-v1:${clean}`);
    return {
      code: clean,
      pairingId: `p_${toHex(pairingHash).slice(0, 40)}`,
      sealedKey: toBase64Url(keyHash)
    };
  }

  function pairCodeFromLocation() {
    const raw = String(location.hash || '').replace(/^#/, '');
    if (!raw) return '';
    const params = new URLSearchParams(raw);
    return normalizeCode(params.get('pair') || params.get('code') || '');
  }

  function appPairUrl(code) {
    const url = new URL('./', location.href);
    url.search = '';
    url.hash = `pair=${encodeURIComponent(normalizeCode(code))}`;
    return url.toString();
  }

  function installEntryUi() {
    const setup = el('setupView');
    if (setup && !el('pairEntryCard')) {
      const card = document.createElement('section');
      card.id = 'pairEntryCard';
      card.className = 'pair-entry-card';
      card.innerHTML = `
        <div class="pair-entry-title">已有邀請碼</div>
        <div class="pair-entry-row">
          <input id="pairCodeInput" class="pair-code-input" inputmode="text" autocomplete="one-time-code" maxlength="14" placeholder="XXXX-XXXX-XXXX" aria-label="12 碼邀請碼">
          <button id="pairJoinBtn" class="pair-join-btn" type="button">配對進入</button>
        </div>
        <p class="pair-entry-note">也可以直接用手機相機掃描對方畫面上的 QR Code。</p>
      `;
      const actions = setup.querySelector('.main-actions');
      if (actions) setup.insertBefore(card, actions);
      else setup.appendChild(card);
    }

    const accept = el('acceptView');
    if (accept && !el('acceptPairCodeInput')) {
      const card = document.createElement('section');
      card.className = 'pair-entry-card';
      card.innerHTML = `
        <div class="pair-entry-title">配對邀請碼</div>
        <input id="acceptPairCodeInput" class="pair-code-input" inputmode="text" autocomplete="one-time-code" maxlength="14" placeholder="XXXX-XXXX-XXXX" aria-label="配對邀請碼">
        <p class="pair-entry-note">QR Code 開啟時會自動帶入；也可以手動輸入。</p>
      `;
      const guestLabel = accept.querySelector('label[for="guestName"]');
      if (guestLabel) accept.insertBefore(card, guestLabel);
      else accept.prepend(card);
    }

    ['pairCodeInput', 'acceptPairCodeInput'].forEach((id) => {
      const input = el(id);
      if (!input || input.dataset.pairBound) return;
      input.dataset.pairBound = '1';
      input.addEventListener('input', () => {
        const code = normalizeCode(input.value);
        input.value = formatCode(code);
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          acceptPairCode(input.value);
        }
      });
    });

    const join = el('pairJoinBtn');
    if (join && !join.dataset.pairBound) {
      join.dataset.pairBound = '1';
      join.addEventListener('click', () => acceptPairCode(el('pairCodeInput')?.value || ''));
    }
  }

  function installCreatedPairUi() {
    const panel = el('invitePanel');
    if (!panel) return null;
    let card = el('pairCodeCard');
    if (!card) {
      card = document.createElement('section');
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
            <p class="pair-code-note">對方可輸入 12 碼，或用相機掃描右側 QR Code。接受後邀請立即失效。</p>
          </div>
          <div id="pairQr" class="pair-qr"><div class="pair-qr-fallback">正在產生 QR Code…</div></div>
        </div>
      `;
      const textarea = el('inviteLink');
      if (textarea) panel.insertBefore(card, textarea);
      else panel.appendChild(card);

      el('copyPairCodeBtn')?.addEventListener('click', copyPairCode);
      el('copyPairLinkBtn')?.addEventListener('click', copyPairLink);
    }
    return card;
  }

  async function loadQrLibrary() {
    if (window.QRCode) return true;
    return new Promise((resolve) => {
      const existing = document.querySelector(`script[src="${QR_LIB}"]`);
      if (existing) {
        existing.addEventListener('load', () => resolve(Boolean(window.QRCode)), { once: true });
        existing.addEventListener('error', () => resolve(false), { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = QR_LIB;
      script.async = true;
      script.onload = () => resolve(Boolean(window.QRCode));
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
  }

  async function renderQr(text) {
    const box = el('pairQr');
    if (!box) return;
    box.replaceChildren();
    const ready = await loadQrLibrary();
    if (!ready || !window.QRCode) {
      const fallback = document.createElement('div');
      fallback.className = 'pair-qr-fallback';
      fallback.textContent = 'QR Code 載入失敗，請改用邀請碼或複製連結。';
      box.appendChild(fallback);
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

  function pairingSettings() {
    try {
      const base = typeof getSettingsFromForm === 'function' ? getSettingsFromForm() : {};
      return {
        displaySeconds: Math.max(15, Math.min(60, Number(base.displaySeconds || 20))),
        sealedBubbleSeconds: 300,
        messageTtlSeconds: 21600,
        inviteTtlSeconds: Math.max(60, Math.min(21600, Number(el('inviteTtlSeconds')?.value || 1800)))
      };
    } catch (_) {
      return { displaySeconds: 20, sealedBubbleSeconds: 300, messageTtlSeconds: 21600, inviteTtlSeconds: 1800 };
    }
  }

  async function createPairInvite() {
    const button = el('createInviteBtn');
    const label = typeof getIdentityFromInputs === 'function' ? getIdentityFromInputs('displayName', '我') : '我';
    const settings = pairingSettings();
    try {
      if (typeof saveIdentity === 'function') saveIdentity(label);
      if (typeof saveLocalSettings === 'function') saveLocalSettings(settings);
      if (typeof setBusy === 'function') setBusy(button, true, '建立配對中…');

      const code = generateCode();
      const material = await pairingMaterial(code);
      const data = await api('createPairing', { pairingId: material.pairingId, settings });
      const remote = data.session || {};

      session = typeof normalizeSessionSettings === 'function'
        ? normalizeSessionSettings({
            role: 'creator',
            myChannel: remote.myChannel,
            peerChannel: remote.peerChannel,
            sealedKey: material.sealedKey,
            label,
            settings: remote.settings || settings,
            pairingId: material.pairingId,
            createdAt: Date.now()
          })
        : {
            role: 'creator', myChannel: remote.myChannel, peerChannel: remote.peerChannel,
            sealedKey: material.sealedKey, label, settings: remote.settings || settings,
            pairingId: material.pairingId, createdAt: Date.now()
          };
      if (typeof saveSession === 'function') saveSession(session);

      activePairingId = material.pairingId;
      activePairCode = material.code;
      const link = appPairUrl(material.code);
      if (el('inviteLink')) el('inviteLink').value = link;
      el('invitePanel')?.classList.remove('hidden');
      installCreatedPairUi();
      if (el('pairCodeValue')) el('pairCodeValue').textContent = formatCode(material.code);
      renderQr(link);
      startPairStatusPolling();
      setStatusSafe('邀請碼與 QR Code 已建立，等待對方配對。');
    } catch (err) {
      setStatusSafe(err?.message || '建立配對失敗。請確認 GAS 已重新部署。');
    } finally {
      if (typeof setBusy === 'function') setBusy(button, false, '建立專屬對話');
    }
  }

  async function acceptPairCode(value) {
    const source = value || pairCodeFromLocation() || el('acceptPairCodeInput')?.value || el('pairCodeInput')?.value || '';
    const button = el('acceptInviteBtn') || el('pairJoinBtn');
    const label = typeof getIdentityFromInputs === 'function'
      ? getIdentityFromInputs(el('acceptView') && !el('acceptView').classList.contains('hidden') ? 'guestName' : 'displayName', '我')
      : '我';
    try {
      const material = await pairingMaterial(source);
      if (typeof setBusy === 'function') setBusy(button, true, '配對中…');
      const data = await api('acceptPairing', { pairingId: material.pairingId });
      const remote = data.session || {};
      session = typeof normalizeSessionSettings === 'function'
        ? normalizeSessionSettings({
            role: 'guest',
            myChannel: remote.myChannel,
            peerChannel: remote.peerChannel,
            sealedKey: material.sealedKey,
            label,
            settings: remote.settings || pairingSettings(),
            pairingId: material.pairingId,
            createdAt: Date.now()
          })
        : {
            role: 'guest', myChannel: remote.myChannel, peerChannel: remote.peerChannel,
            sealedKey: material.sealedKey, label, settings: remote.settings || pairingSettings(),
            pairingId: material.pairingId, createdAt: Date.now()
          };
      if (typeof saveIdentity === 'function') saveIdentity(label);
      if (typeof saveSession === 'function') saveSession(session);
      history.replaceState({}, '', new URL('./', location.href).toString());
      if (typeof enterChat === 'function') enterChat();
      setStatusSafe('配對成功，已進入同一個私・話頻道。');
    } catch (err) {
      setStatusSafe(err?.message || '邀請碼錯誤、已使用或已過期。');
    } finally {
      if (typeof setBusy === 'function') {
        const text = button?.id === 'pairJoinBtn' ? '配對進入' : '接受配對並加入';
        setBusy(button, false, text);
      }
    }
  }

  async function pollPairStatus() {
    if (!activePairingId) return;
    try {
      const data = await api('pairingStatus', { pairingId: activePairingId });
      const state = String(data.state || 'expired');
      const box = el('pairLiveState');
      if (!box) return;
      if (state === 'accepted') {
        box.className = 'pair-state accepted';
        box.querySelector('span:last-child').textContent = '對方已配對，可以進入對話';
        clearInterval(pairStatusTimer);
        pairStatusTimer = null;
        setStatusSafe('對方已完成配對。');
      } else if (state === 'waiting') {
        const left = Math.max(0, Math.ceil((Number(data.expiresAt || 0) - Date.now()) / 1000));
        box.className = 'pair-state waiting';
        box.querySelector('span:last-child').textContent = `等待對方配對${left ? `｜剩 ${Math.ceil(left / 60)} 分` : ''}`;
      } else {
        box.className = 'pair-state error';
        box.querySelector('span:last-child').textContent = state === 'canceled' ? '邀請已取消' : '邀請已失效';
        clearInterval(pairStatusTimer);
        pairStatusTimer = null;
      }
    } catch (err) {
      const box = el('pairLiveState');
      if (box) {
        box.className = 'pair-state error';
        box.querySelector('span:last-child').textContent = '讀不到配對狀態';
      }
    }
  }

  function startPairStatusPolling() {
    clearInterval(pairStatusTimer);
    pollPairStatus();
    pairStatusTimer = setInterval(pollPairStatus, PAIR_STATUS_MS);
  }

  async function copyText(text, done) {
    try {
      await navigator.clipboard.writeText(text);
      setStatusSafe(done);
    } catch (_) {
      const temp = document.createElement('textarea');
      temp.value = text;
      document.body.appendChild(temp);
      temp.select();
      document.execCommand('copy');
      temp.remove();
      setStatusSafe(done);
    }
  }

  function copyPairCode() { if (activePairCode) copyText(formatCode(activePairCode), '邀請碼已複製。'); }
  function copyPairLink() { const link = el('inviteLink')?.value || ''; if (link) copyText(link, '配對連結已複製。'); }

  function showPairAcceptIfNeeded() {
    const code = pairCodeFromLocation();
    if (!code) return;
    installEntryUi();
    if (el('acceptPairCodeInput')) el('acceptPairCodeInput').value = formatCode(code);
    if (el('pairCodeInput')) el('pairCodeInput').value = formatCode(code);
    try {
      if (typeof showAcceptView === 'function') showAcceptView();
      const title = el('acceptView')?.querySelector('h1');
      if (title) title.textContent = '掃描成功，加入私・話';
      const btn = el('acceptInviteBtn');
      if (btn) btn.textContent = '接受配對並加入';
    } catch (_) {}
  }

  // 在 app.js 的 load/init 綁定事件前替換原函式。
  try { createInvite = createPairInvite; window.createInvite = createPairInvite; } catch (_) { window.createInvite = createPairInvite; }
  try { acceptInvite = () => acceptPairCode(); window.acceptInvite = () => acceptPairCode(); } catch (_) { window.acceptInvite = () => acceptPairCode(); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installEntryUi, { once: true });
  } else {
    installEntryUi();
  }
  window.addEventListener('load', showPairAcceptIfNeeded);
  window.addEventListener('beforeunload', () => clearInterval(pairStatusTimer));
})();
