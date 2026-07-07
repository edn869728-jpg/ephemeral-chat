/*
 * 私・話 v4.3｜聊天室排版與時效模組
 * 載入順序：app.js → room-addon.js → call-addon.js
 *
 * 功能：
 * - 鍵盤展開後維持滿版，只有訊息區捲動
 * - 對方是否在聊天室的紅／綠燈
 * - 未讀改成可逐則點開的水滴
 * - 進入聊天室後，該批未開訊息最多 5 分鐘
 * - 點開後依雙方同步設定 15／20／30／60 秒消失
 * - 敲一下、同步閱後秒數、任一方結束整段對話
 */
(() => {
  'use strict';

  const VERSION = 'room-layout-v4.3';
  const ROOM_SYNC_MS = 2400;
  const MESSAGE_SYNC_MS = 1500;
  const UNREAD_TTL_SECONDS = 21600;
  const KNOCK_COOLDOWN_MS = 10000;
  const LAST_ROOM_NOTICE_KEY = 'ephemeral_chat_v43_room_notice';

  let roomSyncTimer = null;
  let messageSyncTimer = null;
  let clockTimer = null;
  let roomEnded = false;
  let syncingRoom = false;
  let syncingMessages = false;
  let drops = [];
  let roomWindowExpiresAt = 0;
  let lastPeerState = '';
  let lastKnockAt = 0;
  let oneMinuteNoticeFor = 0;
  let booted = false;

  const ui = {};

  function currentSession() {
    try {
      return typeof session !== 'undefined' ? session : null;
    } catch (_) {
      return null;
    }
  }

  function chatElement() {
    return document.getElementById('chatView');
  }

  function isChatViewShown() {
    const chat = chatElement();
    return Boolean(chat && !chat.classList.contains('hidden'));
  }

  function isActuallyInRoom() {
    return Boolean(isChatViewShown() && !document.hidden && !roomEnded);
  }

  async function postApi(action, payload) {
    if (typeof api !== 'function') throw new Error('找不到聊天室 API。');
    return api(action, payload || {});
  }

  function status(text) {
    try {
      if (typeof setStatus === 'function') setStatus(text);
    } catch (_) {}
  }

  function safeDisplaySeconds(value) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) return 20;
    return Math.max(15, Math.min(60, number));
  }

  function activeDisplaySeconds() {
    const s = currentSession();
    return safeDisplaySeconds(s && s.settings && s.settings.displaySeconds);
  }

  function saveDisplaySeconds(seconds) {
    const s = currentSession();
    if (!s) return;
    s.settings = { ...(s.settings || {}), displaySeconds: safeDisplaySeconds(seconds) };
    try {
      if (typeof saveSession === 'function') saveSession(s);
    } catch (_) {}
    if (ui.displaySelect) ui.displaySelect.value = String(s.settings.displaySeconds);
    updateRoomSubtitle();
  }

  function overrideOldAutoRead() {
    // 必須在 window.load 之前替換，避免舊版一進聊天室就整批取走。
    const replacement = async function () {
      await refreshDrops();
    };
    try { window.checkUnreadAndMaybeRead = replacement; } catch (_) {}
    try { checkUnreadAndMaybeRead = replacement; } catch (_) {}

    const manualReplacement = async function () {
      if (drops[0]) await openDrop(drops[0].id);
      else status('目前沒有未讀水滴。');
    };
    try { window.readAndDeleteNow = manualReplacement; } catch (_) {}
    try { readAndDeleteNow = manualReplacement; } catch (_) {}
  }

  overrideOldAutoRead();

  function installUi() {
    if (!isChatViewShown() && !chatElement()) return;
    const chat = chatElement();
    if (!chat) return;

    document.body.classList.toggle('chat-active', isChatViewShown());

    const header = chat.querySelector('.chat-header');
    const headerMain = header && header.firstElementChild;
    const actions = header && header.querySelector('.header-actions');

    if (headerMain && !document.getElementById('roomPresenceRow')) {
      const row = document.createElement('div');
      row.id = 'roomPresenceRow';
      row.className = 'room-presence-row';
      row.innerHTML = `
        <div class="presence-state" aria-live="polite">
          <span id="peerPresenceLight" class="presence-light offline"></span>
          <span id="peerPresenceText">對方未在聊天室</span>
        </div>
        <div id="roomRoundTimer" class="room-round-timer hidden">本輪 05:00</div>
      `;
      headerMain.appendChild(row);
    }

    if (headerMain && !document.getElementById('roomTimingTools')) {
      const tools = document.createElement('div');
      tools.id = 'roomTimingTools';
      tools.className = 'room-timing-tools';
      tools.innerHTML = `
        <label for="roomDisplaySeconds">閱後</label>
        <select id="roomDisplaySeconds" aria-label="雙方同步的閱後消失時間">
          <option value="15">15 秒</option>
          <option value="20">20 秒</option>
          <option value="30">30 秒</option>
          <option value="60">1 分鐘</option>
        </select>
        <span>進房後未開最多 5 分鐘</span>
      `;
      headerMain.appendChild(tools);
    }

    if (actions && !document.getElementById('endConversationBtn')) {
      const end = document.createElement('button');
      end.id = 'endConversationBtn';
      end.type = 'button';
      end.className = 'icon-btn end-conversation-btn';
      end.title = '結束這整段對話';
      end.textContent = '離開';
      actions.appendChild(end);
    }

    const chatBox = document.getElementById('chatBox');
    if (chatBox && !document.getElementById('unreadDropDock')) {
      const dock = document.createElement('aside');
      dock.id = 'unreadDropDock';
      dock.className = 'unread-drop-dock hidden';
      dock.setAttribute('aria-label', '未開訊息');
      dock.innerHTML = '<div class="drop-dock-title">未開</div><div id="unreadDrops" class="unread-drops"></div>';
      chatBox.parentNode.insertBefore(dock, chatBox);
    }

    const form = document.getElementById('messageForm');
    if (form && !document.getElementById('knockBtn')) {
      const knock = document.createElement('button');
      knock.id = 'knockBtn';
      knock.type = 'button';
      knock.className = 'knock-btn';
      knock.title = '敲一下，不建立訊息';
      knock.setAttribute('aria-label', '敲一下提醒對方');
      knock.textContent = '叮';
      form.insertBefore(knock, form.firstChild);
    }

    if (!document.getElementById('roomToast')) {
      const toast = document.createElement('div');
      toast.id = 'roomToast';
      toast.className = 'room-toast hidden';
      toast.setAttribute('role', 'status');
      document.body.appendChild(toast);
    }

    if (chat && !document.getElementById('conversationEndedPanel')) {
      const ended = document.createElement('section');
      ended.id = 'conversationEndedPanel';
      ended.className = 'conversation-ended-panel hidden';
      ended.innerHTML = `
        <div class="ended-mark">×</div>
        <h2>這段對話已結束</h2>
        <p>其中一方已離開，未開密封訊息與本次對話狀態已清除。</p>
        <button id="endedHomeBtn" type="button" class="primary-btn">回到私・話首頁</button>
      `;
      chat.appendChild(ended);
    }

    ui.presenceLight = document.getElementById('peerPresenceLight');
    ui.presenceText = document.getElementById('peerPresenceText');
    ui.roundTimer = document.getElementById('roomRoundTimer');
    ui.displaySelect = document.getElementById('roomDisplaySeconds');
    ui.dropDock = document.getElementById('unreadDropDock');
    ui.dropList = document.getElementById('unreadDrops');
    ui.knockBtn = document.getElementById('knockBtn');
    ui.endBtn = document.getElementById('endConversationBtn');
    ui.toast = document.getElementById('roomToast');
    ui.endedPanel = document.getElementById('conversationEndedPanel');
    ui.endedHomeBtn = document.getElementById('endedHomeBtn');

    if (ui.displaySelect && !ui.displaySelect.dataset.bound) {
      ui.displaySelect.dataset.bound = '1';
      ui.displaySelect.value = String(activeDisplaySeconds());
      ui.displaySelect.addEventListener('change', changeDisplaySeconds);
    }

    if (ui.knockBtn && !ui.knockBtn.dataset.bound) {
      ui.knockBtn.dataset.bound = '1';
      ui.knockBtn.addEventListener('click', knockPeer);
    }

    if (ui.endBtn && !ui.endBtn.dataset.bound) {
      ui.endBtn.dataset.bound = '1';
      ui.endBtn.addEventListener('click', endConversation);
    }

    if (ui.endedHomeBtn && !ui.endedHomeBtn.dataset.bound) {
      ui.endedHomeBtn.dataset.bound = '1';
      ui.endedHomeBtn.addEventListener('click', resetAfterEnded);
    }

    const oldBadge = document.getElementById('unreadBadge');
    if (oldBadge) oldBadge.classList.add('legacy-unread-hidden');
    const oldRead = document.getElementById('readUnreadBtn');
    if (oldRead) oldRead.classList.add('legacy-read-hidden');

    updateRoomSubtitle();
    updateViewportHeight();
  }

  function updateRoomSubtitle() {
    const sub = document.getElementById('chatSub');
    if (!sub || !isChatViewShown()) return;
    const friendName = (() => {
      try {
        return typeof findFriendNameBySession === 'function' ? findFriendNameBySession(currentSession()) : '';
      } catch (_) {
        return '';
      }
    })();
    sub.textContent = `${friendName ? friendName + '｜' : ''}未進房加密等待最長 6 小時｜進房後未開 5 分鐘｜點開 ${activeDisplaySeconds()} 秒消失`;
  }

  function updateViewportHeight() {
    const viewport = window.visualViewport;
    const height = viewport ? viewport.height : window.innerHeight;
    const top = viewport ? viewport.offsetTop : 0;
    document.documentElement.style.setProperty('--private-app-height', `${Math.round(height)}px`);
    document.documentElement.style.setProperty('--private-app-top', `${Math.round(top)}px`);
    document.body.classList.toggle('keyboard-open', Boolean(viewport && window.innerHeight - viewport.height > 120));
  }

  async function syncRoom() {
    if (syncingRoom || roomEnded) return;
    const s = currentSession();
    if (!s || !s.myChannel || !s.peerChannel) return;
    syncingRoom = true;
    const inRoom = isActuallyInRoom();

    try {
      const data = await postApi('roomSync', {
        myChannel: s.myChannel,
        peerChannel: s.peerChannel,
        inRoom
      });

      if (data.ended && data.ended.ended) {
        showEndedScreen('這段對話已結束');
        return;
      }

      updatePresence(data.peer || {});
      if (inRoom && Number(data.ownRoomWindowExpiresAt || 0)) {
        roomWindowExpiresAt = Number(data.ownRoomWindowExpiresAt);
      }

      const events = Array.isArray(data.events) ? data.events : [];
      for (const envelope of events) processRoomEvent(envelope);
    } catch (_) {
      updatePresence({ inRoom: false, recentlySeen: false });
    } finally {
      syncingRoom = false;
    }
  }

  function updatePresence(peer) {
    installUi();
    if (!ui.presenceLight || !ui.presenceText) return;

    let state = 'offline';
    let text = '對方未在聊天室';
    if (peer && peer.inRoom) {
      state = 'online';
      text = '對方正在聊天室';
    } else if (peer && peer.recentlySeen) {
      state = 'away';
      text = '對方暫時離開';
    }

    ui.presenceLight.className = `presence-light ${state}`;
    ui.presenceText.textContent = text;

    if (lastPeerState && lastPeerState !== state && state === 'online') {
      showToast('對方回到聊天室了');
    }
    lastPeerState = state;
  }

  async function refreshDrops() {
    if (syncingMessages || roomEnded) return;
    const s = currentSession();
    if (!s || !s.myChannel) return;
    syncingMessages = true;

    try {
      const inRoom = isActuallyInRoom();
      const data = await postApi('listSealedMessages', {
        myChannel: s.myChannel,
        inRoom
      });

      const oldCount = drops.length;
      drops = Array.isArray(data.messages) ? data.messages : [];
      if (inRoom && Number(data.roomWindowExpiresAt || 0)) {
        roomWindowExpiresAt = Number(data.roomWindowExpiresAt);
      }
      renderDrops();

      if (drops.length > oldCount) {
        notifyUnread(drops.length);
      }
    } catch (err) {
      if (String(err && err.message || '').indexOf('Unknown action') >= 0) {
        status('GAS 尚未換成 v4.3，未讀水滴暫時不能使用。');
      }
    } finally {
      syncingMessages = false;
    }
  }

  function renderDrops() {
    installUi();
    if (!ui.dropDock || !ui.dropList) return;
    ui.dropList.replaceChildren();

    if (!drops.length || !isActuallyInRoom()) {
      ui.dropDock.classList.add('hidden');
    } else {
      ui.dropDock.classList.remove('hidden');
      drops.forEach((item, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'unread-drop';
        button.dataset.id = item.id;
        button.title = `開啟第 ${index + 1} 則密封訊息`;
        button.setAttribute('aria-label', button.title);
        button.innerHTML = `<span>${index + 1}</span>`;
        button.addEventListener('click', () => openDrop(item.id, button));
        ui.dropList.appendChild(button);
      });
    }

    try {
      if (typeof updateUnreadBadge === 'function') {
        const badge = document.getElementById('unreadBadge');
        if (badge) badge.textContent = drops.length ? `未開 ${drops.length}` : '無未讀';
      }
    } catch (_) {}
    updateRoundTimer();
  }

  async function openDrop(id, button) {
    if (roomEnded) return;
    const s = currentSession();
    if (!s || !s.myChannel || !s.sealedKey) return;
    if (button) button.disabled = true;

    try {
      const data = await postApi('openSealedMessage', {
        myChannel: s.myChannel,
        id,
        displaySeconds: activeDisplaySeconds()
      });
      const message = await decryptAngPacket(data.packet, s.sealedKey);
      drops = drops.filter((item) => item.id !== id);
      renderDrops();

      const remainingMs = Math.max(1000, Number(data.deleteAt || 0) - Date.now());
      showOpenedMessage(
        message.system ? 'system' : 'other',
        message.sender || '對方',
        message.text || '',
        remainingMs
      );
      status(`已開啟一則密封訊息，${Math.ceil(remainingMs / 1000)} 秒後消失。`);
      try { if (navigator.vibrate) navigator.vibrate(25); } catch (_) {}
    } catch (err) {
      status(err && err.message ? err.message : '訊息已消失。');
      drops = drops.filter((item) => item.id !== id);
      renderDrops();
    } finally {
      if (button && button.isConnected) button.disabled = false;
    }
  }

  function showOpenedMessage(type, sender, text, lifetimeMs) {
    const box = document.getElementById('chatBox');
    if (!box) return;

    const div = document.createElement('div');
    div.className = `msg ${type === 'system' ? 'system' : 'peek opened-message'}`;

    if (type !== 'system') {
      const senderEl = document.createElement('span');
      senderEl.className = 'msg-sender';
      senderEl.textContent = sender;
      div.appendChild(senderEl);
    }

    const textEl = document.createElement('span');
    textEl.className = 'msg-text';
    textEl.textContent = text;
    div.appendChild(textEl);

    const timerEl = document.createElement('span');
    timerEl.className = 'opened-countdown';
    div.appendChild(timerEl);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'msg-delete';
    deleteBtn.textContent = '立即刪';
    div.appendChild(deleteBtn);

    const deleteAt = Date.now() + lifetimeMs;
    const tick = () => {
      const left = Math.max(0, Math.ceil((deleteAt - Date.now()) / 1000));
      timerEl.textContent = `${left} 秒`;
      if (left <= 0) remove();
    };
    const interval = setInterval(tick, 250);
    const timeout = setTimeout(remove, lifetimeMs + 100);

    function remove() {
      clearInterval(interval);
      clearTimeout(timeout);
      div.classList.add('vanishing');
      setTimeout(() => div.remove(), 180);
    }

    deleteBtn.addEventListener('click', remove);
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    tick();
  }

  async function sendSecureMessage() {
    if (roomEnded) return;
    const s = currentSession();
    const input = document.getElementById('messageInput');
    if (!s || !s.peerChannel || !s.sealedKey || !input) return;
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    showMineMessage(text, activeDisplaySeconds() * 1000);

    try {
      const packet = await makeAngPacket({
        sender: s.label || '我',
        text,
        system: false,
        timestamp: Date.now()
      }, s.sealedKey);

      await postApi('sendSealedMessage', {
        peerChannel: s.peerChannel,
        packet,
        messageTtlSeconds: UNREAD_TTL_SECONDS
      });
      status('已送出密封訊息。');
    } catch (err) {
      status(err && err.message ? err.message : '發送失敗。');
      showToast('剛剛那則可能沒有送出去');
    }
  }

  function showMineMessage(text, lifetimeMs) {
    const box = document.getElementById('chatBox');
    if (!box) return;
    const div = document.createElement('div');
    div.className = 'msg mine opened-message';
    div.innerHTML = '<span class="msg-sender">我</span><span class="msg-text"></span><span class="opened-countdown"></span>';
    div.querySelector('.msg-text').textContent = text;
    const countdown = div.querySelector('.opened-countdown');
    const deleteAt = Date.now() + lifetimeMs;
    const tick = () => {
      const left = Math.max(0, Math.ceil((deleteAt - Date.now()) / 1000));
      countdown.textContent = `${left} 秒`;
      if (left <= 0) remove();
    };
    const interval = setInterval(tick, 250);
    const timeout = setTimeout(remove, lifetimeMs + 100);
    function remove() {
      clearInterval(interval);
      clearTimeout(timeout);
      div.classList.add('vanishing');
      setTimeout(() => div.remove(), 180);
    }
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    tick();
  }

  async function changeDisplaySeconds() {
    const seconds = safeDisplaySeconds(ui.displaySelect && ui.displaySelect.value);
    saveDisplaySeconds(seconds);
    const s = currentSession();
    if (!s) return;
    try {
      await postApi('roomPush', {
        myChannel: s.myChannel,
        peerChannel: s.peerChannel,
        event: { type: 'settings', payload: { displaySeconds: seconds }, at: Date.now() }
      });
      showToast(`雙方閱後時間已改為 ${seconds} 秒`);
    } catch (err) {
      status(err && err.message ? err.message : '同步秒數失敗。');
    }
  }

  function processRoomEvent(envelope) {
    const event = envelope && envelope.event || {};
    if (event.type === 'knock') {
      if (Date.now() - Number(event.at || envelope.createdAt || 0) > 60000) return;
      ringKnock();
      return;
    }
    if (event.type === 'settings') {
      const seconds = safeDisplaySeconds(event.payload && event.payload.displaySeconds);
      saveDisplaySeconds(seconds);
      showToast(`對方把閱後時間改為 ${seconds} 秒`);
      return;
    }
    if (event.type === 'end') showEndedScreen('對方已離開，這段對話已結束');
  }

  async function knockPeer() {
    const now = Date.now();
    if (now - lastKnockAt < KNOCK_COOLDOWN_MS) {
      showToast('稍等一下再敲');
      return;
    }
    const s = currentSession();
    if (!s) return;
    lastKnockAt = now;
    ui.knockBtn.disabled = true;
    try {
      await postApi('roomPush', {
        myChannel: s.myChannel,
        peerChannel: s.peerChannel,
        event: { type: 'knock', payload: {}, at: now }
      });
      showToast('叮咚，已敲對方一下');
      try { if (navigator.vibrate) navigator.vibrate(35); } catch (_) {}
    } catch (err) {
      status(err && err.message ? err.message : '敲一下失敗。');
    } finally {
      setTimeout(() => {
        if (ui.knockBtn) ui.knockBtn.disabled = false;
      }, KNOCK_COOLDOWN_MS);
    }
  }

  function ringKnock() {
    showToast('叮咚，有人敲你一下');
    try { if (navigator.vibrate) navigator.vibrate([90, 70, 180]); } catch (_) {}
    playKnockTone();
    showPrivateNotification('有人敲你一下', '打開私・話看看。', 'private-chat-knock');
  }

  function playKnockTone() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      const ctx = new AudioContextClass();
      const gain = ctx.createGain();
      const osc = ctx.createOscillator();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.13, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.24);
    } catch (_) {}
  }

  async function endConversation() {
    if (roomEnded) return;
    if (!confirm('確定要結束這整段對話？對方也會立即退出，未開訊息會全部清除。')) return;
    const s = currentSession();
    if (!s) return;
    try {
      await postApi('endConversation', {
        myChannel: s.myChannel,
        peerChannel: s.peerChannel
      });
      showEndedScreen('你已結束這段對話');
    } catch (err) {
      status(err && err.message ? err.message : '無法結束對話。');
    }
  }

  function showEndedScreen(message) {
    if (roomEnded) return;
    roomEnded = true;
    clearInterval(roomSyncTimer);
    clearInterval(messageSyncTimer);
    clearInterval(clockTimer);
    drops = [];
    renderDrops();

    const box = document.getElementById('chatBox');
    const form = document.getElementById('messageForm');
    if (box) box.replaceChildren();
    if (form) form.classList.add('conversation-disabled');
    if (ui.endedPanel) ui.endedPanel.classList.remove('hidden');
    if (ui.presenceLight) ui.presenceLight.className = 'presence-light ended';
    if (ui.presenceText) ui.presenceText.textContent = '對話已結束';
    status(message || '這段對話已結束。');
    window.dispatchEvent(new CustomEvent('ephemeral-room-ended'));
  }

  function resetAfterEnded() {
    try {
      if (typeof SESSION_KEY !== 'undefined') localStorage.removeItem(SESSION_KEY);
      else localStorage.removeItem('ephemeral_chat_v38_peek_session');
    } catch (_) {
      localStorage.removeItem('ephemeral_chat_v38_peek_session');
    }
    location.reload();
  }

  async function leaveRoomPresence() {
    const s = currentSession();
    if (!s || !s.myChannel) return;
    try {
      await postApi('roomLeave', { myChannel: s.myChannel });
    } catch (_) {}
  }

  function leaveRoomKeepalive() {
    const s = currentSession();
    if (!s || !s.myChannel) return;
    try {
      fetch('/api/roomLeave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ myChannel: s.myChannel }),
        cache: 'no-store',
        keepalive: true
      });
    } catch (_) {}
  }

  function updateRoundTimer() {
    installUi();
    if (!ui.roundTimer) return;
    const activeExpiries = drops
      .map((item) => Number(item.roomExpiresAt || 0))
      .filter((value) => value > Date.now());
    const expiresAt = activeExpiries.length ? Math.min(...activeExpiries) : Number(roomWindowExpiresAt || 0);

    if (!isActuallyInRoom() || !drops.length || !expiresAt) {
      ui.roundTimer.classList.add('hidden');
      oneMinuteNoticeFor = 0;
      return;
    }

    const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    const min = String(Math.floor(left / 60)).padStart(2, '0');
    const sec = String(left % 60).padStart(2, '0');
    ui.roundTimer.textContent = `本輪 ${min}:${sec}`;
    ui.roundTimer.classList.remove('hidden');
    ui.roundTimer.classList.toggle('urgent', left <= 60);

    if (left <= 60 && left > 0 && oneMinuteNoticeFor !== expiresAt) {
      oneMinuteNoticeFor = expiresAt;
      showToast('未開訊息將在 1 分鐘內消失');
      showPrivateNotification('私・話訊息即將消失', '還有未開訊息，閱讀時間剩不到 1 分鐘。', 'private-chat-expiring');
    }

    if (left <= 0) refreshDrops();
  }

  function notifyUnread(count) {
    if (!count) return;
    showPrivateNotification('有新的私・話訊息', `${count} 則密封訊息等待開啟。`, 'private-chat-unread');
  }

  async function showPrivateNotification(title, body, tag) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!document.hidden && isChatViewShown() && tag !== 'private-chat-knock') return;
    const options = {
      body,
      icon: '/assets/icon-192.png',
      badge: '/assets/icon-192.png',
      tag,
      renotify: true,
      data: { url: location.origin + location.pathname }
    };
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration && registration.showNotification) {
        await registration.showNotification(title, options);
        return;
      }
    } catch (_) {}
    try { new Notification(title, options); } catch (_) {}
  }

  function showToast(text) {
    installUi();
    if (!ui.toast) return;
    ui.toast.textContent = text;
    ui.toast.classList.remove('hidden');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => ui.toast && ui.toast.classList.add('hidden'), 2400);
  }

  function bindMessageFormCapture() {
    const form = document.getElementById('messageForm');
    if (!form || form.dataset.v43Capture) return;
    form.dataset.v43Capture = '1';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      sendSecureMessage();
    }, true);
  }

  function startTimers() {
    clearInterval(roomSyncTimer);
    clearInterval(messageSyncTimer);
    clearInterval(clockTimer);
    roomSyncTimer = setInterval(syncRoom, ROOM_SYNC_MS);
    messageSyncTimer = setInterval(refreshDrops, MESSAGE_SYNC_MS);
    clockTimer = setInterval(updateRoundTimer, 250);
    syncRoom();
    refreshDrops();
  }

  function watchView() {
    const observer = new MutationObserver(() => {
      const active = isChatViewShown();
      document.body.classList.toggle('chat-active', active);
      installUi();
      bindMessageFormCapture();
      if (active && !roomEnded) {
        syncRoom();
        refreshDrops();
      } else {
        leaveRoomPresence();
      }
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  function boot() {
    if (booted) return;
    booted = true;
    installUi();
    bindMessageFormCapture();
    watchView();
    startTimers();

    window.addEventListener('resize', updateViewportHeight);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateViewportHeight);
      window.visualViewport.addEventListener('scroll', updateViewportHeight);
    }

    document.addEventListener('visibilitychange', () => {
      updateViewportHeight();
      if (document.hidden) leaveRoomPresence();
      else {
        syncRoom();
        refreshDrops();
      }
    });

    window.addEventListener('pagehide', leaveRoomKeepalive);
    window.addEventListener('beforeunload', leaveRoomKeepalive);

    function applySetupDefaults() {
      const ttlInput = document.getElementById('messageTtlSeconds');
      const bubbleInput = document.getElementById('sealedBubbleSeconds');
      const displayInput = document.getElementById('displaySeconds');
      if (ttlInput) ttlInput.max = String(UNREAD_TTL_SECONDS);
      // 只在尚未建立／加入對話時套用新預設，不覆蓋既有房間同步設定。
      if (!currentSession()) {
        if (ttlInput) ttlInput.value = String(UNREAD_TTL_SECONDS);
        if (bubbleInput) bubbleInput.value = '300';
        if (displayInput) displayInput.value = '20';
      }
    }
    applySetupDefaults();
    window.addEventListener('load', applySetupDefaults, { once: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
