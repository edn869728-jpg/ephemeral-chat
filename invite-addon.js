/*
 * 私・話 v4.4｜一次性邀請狀態與 API 防卡住模組
 * 載入順序：app.js → invite-addon.js → room-addon.js → call-addon.js
 */
(() => {
  'use strict';

  const API_TIMEOUT_MS = 18000;
  const STATUS_POLL_MS = 1800;
  let statusTimer = null;
  let activeInviteToken = '';
  let lastState = '';

  // 把舊版前端限制同步成目前規則。
  try {
    if (typeof DEFAULT_SETTINGS === 'object') {
      DEFAULT_SETTINGS.displaySeconds = 20;
      DEFAULT_SETTINGS.sealedBubbleSeconds = 300;
      DEFAULT_SETTINGS.messageTtlSeconds = 21600;
      DEFAULT_SETTINGS.inviteTtlSeconds = 1800;
    }
    if (typeof LIMITS === 'object') {
      LIMITS.displaySeconds = { min: 15, max: 60 };
      LIMITS.sealedBubbleSeconds = { min: 300, max: 300 };
      LIMITS.messageTtlSeconds = { min: 60, max: 21600 };
      LIMITS.inviteTtlSeconds = { min: 30, max: 21600 };
    }
  } catch (_) {}

  async function timedApi(action, payload) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const response = await fetch(`/api/${encodeURIComponent(action)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload || {}),
        cache: 'no-store',
        signal: controller.signal
      });

      let data;
      try {
        data = await response.json();
      } catch (_) {
        throw new Error('API 回傳格式錯誤');
      }

      if (!response.ok || !data.ok) {
        throw new Error(data.error || `API 錯誤：${response.status}`);
      }
      return data;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error('連線逾時，請先按「測試後端」，確認 GAS 已重新部署。');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  try {
    if (typeof api === 'function') api = timedApi;
    else window.api = timedApi;
  } catch (_) {
    window.api = timedApi;
  }

  function setStatusText(text) {
    try {
      if (typeof setStatus === 'function') setStatus(text);
    } catch (_) {}
  }

  function installInviteUi() {
    const panel = document.getElementById('invitePanel');
    if (!panel || document.getElementById('inviteLiveStatus')) return;

    const status = document.createElement('div');
    status.id = 'inviteLiveStatus';
    status.className = 'invite-live-status waiting';
    status.innerHTML = `
      <span class="invite-status-light"></span>
      <div>
        <strong id="inviteStatusText">等待建立邀請</strong>
        <small id="inviteStatusSub">邀請建立後會顯示對方是否已加入。</small>
      </div>
    `;

    const title = panel.querySelector('.panel-title');
    if (title && title.nextSibling) panel.insertBefore(status, title.nextSibling);
    else panel.prepend(status);

    const row = panel.querySelector('.button-row');
    if (row && !document.getElementById('cancelInviteBtn')) {
      const cancel = document.createElement('button');
      cancel.id = 'cancelInviteBtn';
      cancel.type = 'button';
      cancel.className = 'ghost-btn invite-cancel-btn';
      cancel.textContent = '取消邀請';
      cancel.hidden = true;
      cancel.addEventListener('click', cancelInvite);
      row.appendChild(cancel);
    }
  }

  function inviteTokenFromLink() {
    const link = document.getElementById('inviteLink');
    const text = link ? String(link.value || '').trim() : '';
    if (!text) return '';
    try {
      return new URL(text).searchParams.get('invite') || '';
    } catch (_) {
      return '';
    }
  }

  function renderState(state, message, sub) {
    installInviteUi();
    const box = document.getElementById('inviteLiveStatus');
    const text = document.getElementById('inviteStatusText');
    const detail = document.getElementById('inviteStatusSub');
    const cancel = document.getElementById('cancelInviteBtn');
    if (!box || !text || !detail) return;

    box.className = `invite-live-status ${state || 'waiting'}`;
    text.textContent = message || '等待對方加入';
    detail.textContent = sub || '邀請是一次性的，接受後立即失效。';
    if (cancel) cancel.hidden = state !== 'waiting';
  }

  function startStatusPolling(token) {
    if (!token) return;
    activeInviteToken = token;
    if (statusTimer) clearInterval(statusTimer);
    renderState('waiting', '等待對方加入', '邀請仍有效；對方接受後會立即顯示。');
    checkInviteStatus();
    statusTimer = setInterval(checkInviteStatus, STATUS_POLL_MS);
  }

  async function checkInviteStatus() {
    if (!activeInviteToken) return;
    try {
      const data = await timedApi('inviteStatus', { inviteToken: activeInviteToken });
      const state = String(data.state || 'expired');
      if (state === lastState && state !== 'waiting') return;
      lastState = state;

      if (state === 'waiting') {
        const remain = Math.max(0, Math.ceil((Number(data.expiresAt || 0) - Date.now()) / 1000));
        renderState('waiting', '等待對方加入', remain ? `邀請約剩 ${formatTime(remain)}；接受後立即失效。` : '邀請仍有效。');
        return;
      }

      if (state === 'accepted') {
        stopStatusPolling();
        renderState('accepted', '對方已加入', '現在可以按「進入對話」，紅綠燈會顯示對方是否正在聊天室。');
        setStatusText('對方已接受邀請，可以進入對話。');
        pulseOpenButton();
        return;
      }

      if (state === 'canceled') {
        stopStatusPolling();
        renderState('canceled', '邀請已取消', '這條連結不能再使用，請重新建立。');
        return;
      }

      stopStatusPolling();
      renderState('expired', '邀請已失效', '請重新建立一條新的專屬邀請。');
    } catch (err) {
      renderState('error', '邀請狀態暫時讀不到', err.message || '請先測試後端。');
    }
  }

  function stopStatusPolling() {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
  }

  async function cancelInvite() {
    if (!activeInviteToken) return;
    const button = document.getElementById('cancelInviteBtn');
    if (button) {
      button.disabled = true;
      button.textContent = '取消中…';
    }
    try {
      await timedApi('cancelInvite', { inviteToken: activeInviteToken });
      stopStatusPolling();
      renderState('canceled', '邀請已取消', '這條連結已不能使用。');
      setStatusText('邀請已取消。');
    } catch (err) {
      setStatusText(err.message || '取消邀請失敗。');
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = '取消邀請';
      }
    }
  }

  function pulseOpenButton() {
    const button = document.getElementById('openChatBtn');
    if (!button) return;
    button.classList.remove('invite-ready-pulse');
    void button.offsetWidth;
    button.classList.add('invite-ready-pulse');
  }

  function formatTime(seconds) {
    const s = Math.max(0, Number(seconds || 0));
    if (s >= 3600) {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      return m ? `${h} 小時 ${m} 分` : `${h} 小時`;
    }
    if (s >= 60) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
    return `${s} 秒`;
  }

  function watchInvitePanel() {
    installInviteUi();
    const panel = document.getElementById('invitePanel');
    const link = document.getElementById('inviteLink');
    if (!panel || !link) return;

    const inspect = () => {
      if (panel.classList.contains('hidden')) return;
      const token = inviteTokenFromLink();
      if (token && token !== activeInviteToken) {
        lastState = '';
        startStatusPolling(token);
      }
    };

    const observer = new MutationObserver(inspect);
    observer.observe(panel, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
    link.addEventListener('input', inspect);
    setInterval(inspect, 900);
    inspect();
  }

  window.addEventListener('beforeunload', stopStatusPolling);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watchInvitePanel, { once: true });
  } else {
    watchInvitePanel();
  }
})();
