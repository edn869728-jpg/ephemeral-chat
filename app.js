const SESSION_KEY = 'ephemeral_chat_v38_peek_session';
const INSTALL_DISMISSED_KEY = 'ephemeral_chat_v38_install_dismissed';
const LOCAL_SETTINGS_KEY = 'ephemeral_chat_v38_settings';
const FRIENDS_KEY = 'ephemeral_chat_v38_friends';
const NOTIFY_PREF_KEY = 'ephemeral_chat_v38_notify_enabled';
const LAST_UNREAD_KEY = 'ephemeral_chat_v38_last_unread';

const DEFAULT_SETTINGS = {
  // 第一次按住查看後，從這裡開始倒數刪除
  displaySeconds: 5,
  // 進聊天室後，如果還沒按住查看，密封泡泡最多留多久
  sealedBubbleSeconds: 60,
  // 對方還沒開 App 前，後端密封包最多保留多久
  messageTtlSeconds: 20,
  inviteTtlSeconds: 30 * 60
};

const LIMITS = {
  displaySeconds: { min: 1, max: 60 },
  sealedBubbleSeconds: { min: 3, max: 300 },
  messageTtlSeconds: { min: 5, max: 3600 },
  inviteTtlSeconds: { min: 30, max: 86400 }
};

const POLL_INTERVAL_MS = 5000;
const ACTIVE_READ_DELAY_MS = 350;

let session = null;
let pollTimer = null;
let deferredInstallPrompt = null;
let lastUnreadCount = 0;
let readInFlight = false;

const $ = (id) => document.getElementById(id);

const setupView = $('setupView');
const acceptView = $('acceptView');
const chatView = $('chatView');
const statusBar = $('statusBar');
const invitePanel = $('invitePanel');
const inviteLink = $('inviteLink');
const chatBox = $('chatBox');
const messageInput = $('messageInput');
const installBox = $('installBox');
const installBtn = $('installBtn');
const installText = $('installText');
const friendsPanel = $('friendsPanel');
const friendsList = $('friendsList');

function getAppBaseUrl() {
  const url = new URL('./', location.href);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function goCleanBaseUrl() {
  history.replaceState({}, '', getAppBaseUrl());
}

window.addEventListener('load', init);
window.addEventListener('focus', () => {
  if (session) checkUnreadAndMaybeRead(true);
});
document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('privacy-hidden', document.hidden);
  if (!document.hidden && session) checkUnreadAndMaybeRead(true);
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  maybeShowInstallBox();
});

async function init() {
  registerServiceWorker();
  bindEvents();
  loadSettingsIntoForm();
  renderFriendsList();

  const invite = getInviteTokenFromUrl();
  session = loadSession();

  if (invite) {
    showAcceptView();
    return;
  }

  if (session) {
    enterChat();
    return;
  }

  showSetupView();
}

function bindEvents() {
  $('createInviteBtn').addEventListener('click', createInvite);
  $('copyInviteBtn').addEventListener('click', copyInvite);
  $('openChatBtn').addEventListener('click', enterChat);
  $('acceptInviteBtn').addEventListener('click', acceptInvite);
  $('healthBtn').addEventListener('click', healthCheck);
  $('clearNowBtn').addEventListener('click', clearVisibleMessages);
  const enableNotifyBtn = $('enableNotifyBtn');
  if (enableNotifyBtn) enableNotifyBtn.addEventListener('click', enableNotifications);
  const readUnreadBtn = $('readUnreadBtn');
  if (readUnreadBtn) readUnreadBtn.addEventListener('click', () => readAndDeleteNow(true));
  const saveFriendBtn = $('saveFriendBtn');
  if (saveFriendBtn) saveFriendBtn.addEventListener('click', saveCurrentAsFriend);
  $('resetBtn').addEventListener('click', resetSession);
  $('dismissInstallBtn').addEventListener('click', () => {
    localStorage.setItem(INSTALL_DISMISSED_KEY, '1');
    installBox.classList.add('hidden');
  });
  installBtn.addEventListener('click', installPwa);

  ['displaySeconds', 'sealedBubbleSeconds', 'messageTtlSeconds', 'inviteTtlSeconds'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', () => {
      const settings = getSettingsFromForm();
      saveLocalSettings(settings);
      loadSettingsIntoForm(settings);
    });
  });

  $('messageForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    await sendMessage();
  });
}

function showSetupView() {
  setupView.classList.remove('hidden');
  acceptView.classList.add('hidden');
  chatView.classList.add('hidden');
  setStatus('建立對話後，系統會自動產生一次性邀請連結與本機解密鑰匙。');
}

function showAcceptView() {
  setupView.classList.add('hidden');
  acceptView.classList.remove('hidden');
  chatView.classList.add('hidden');
  const hasKey = Boolean(getInviteKeyFromHash());
  setStatus(hasKey ? '偵測到密封邀請連結，等待你接受。' : '邀請連結缺少解密鑰匙，請對方重新複製完整連結。');
}

async function createInvite() {
  const label = $('displayName').value.trim() || '我';
  const settings = getSettingsFromForm();
  saveLocalSettings(settings);
  setBusy($('createInviteBtn'), true, '建立中...');

  try {
    const keyBase64 = makeSealedKey();
    const data = await api('createInvite', { settings });
    session = normalizeSessionSettings({
      ...data.session,
      label,
      sealedKey: keyBase64
    });
    saveSession(session);

    const url = new URL(getAppBaseUrl());
    url.searchParams.set('invite', data.inviteToken);
    url.hash = `angkey=${encodeURIComponent(keyBase64)}`;
    inviteLink.value = url.toString();
    invitePanel.classList.remove('hidden');

    setStatus(`邀請已建立，${formatSeconds(data.inviteTtlSeconds || settings.inviteTtlSeconds)} 內有效。密鑰只在連結 # 後面，後端看不到。`);
  } catch (err) {
    setStatus(err.message || '建立邀請失敗');
  } finally {
    setBusy($('createInviteBtn'), false, '建立專屬對話');
  }
}

async function acceptInvite() {
  const inviteToken = getInviteTokenFromUrl();
  const inviteKey = getInviteKeyFromHash();
  const label = $('guestName').value.trim() || '我';

  if (!inviteToken) {
    setStatus('找不到邀請碼。');
    return;
  }

  if (!inviteKey) {
    setStatus('這條邀請連結缺少 #angkey，無法解密。請對方重新複製完整連結。');
    return;
  }

  setBusy($('acceptInviteBtn'), true, '加入中...');

  try {
    // 先測試密鑰格式，避免收下不能解的邀請。
    await importAesKey(inviteKey);
    const data = await api('acceptInvite', { inviteToken });
    session = normalizeSessionSettings({
      ...data.session,
      label,
      sealedKey: inviteKey
    });
    saveSession(session);

    goCleanBaseUrl();
    enterChat();
    addMessage('system', '系統', '你已加入這個密封臨時對話。');
  } catch (err) {
    setStatus(err.message || '接受邀請失敗');
  } finally {
    setBusy($('acceptInviteBtn'), false, '接受邀請並加入');
  }
}

async function healthCheck() {
  setBusy($('healthBtn'), true, '測試中...');
  try {
    const data = await api('health', {});
    setStatus(data.ok ? `後端正常：${data.version || 'OK'}` : (data.error || '後端異常。'));
  } catch (err) {
    setStatus(err.message || '後端測試失敗');
  } finally {
    setBusy($('healthBtn'), false, '測試後端');
  }
}

function enterChat() {
  if (!session || !session.myChannel || !session.peerChannel || !session.sealedKey) {
    showSetupView();
    return;
  }

  session = normalizeSessionSettings(session);
  saveSession(session);

  setupView.classList.add('hidden');
  acceptView.classList.add('hidden');
  chatView.classList.remove('hidden');

  const settings = getActiveSettings();
  $('chatTitle').textContent = session.role === 'creator' ? '密封對話已建立' : '已加入密封對話';
  const friendName = findFriendNameBySession(session);
  $('chatSub').textContent = `${friendName ? '常用：' + friendName + '｜' : ''}按住查看後 ${settings.displaySeconds} 秒刪除｜未開封泡泡 ${settings.sealedBubbleSeconds} 秒消失｜未讀 ${settings.messageTtlSeconds} 秒過期`;
  updateNotifyButton();
  updateUnreadBadge(loadLastUnread());

  setStatus('密封對話啟用中。後端只暫存 ANG 亂碼包，打開讀取時同步刪除。');
  startPolling();
  maybeShowInstallBox();
  messageInput.focus();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => checkUnreadAndMaybeRead(false), POLL_INTERVAL_MS);
  checkUnreadAndMaybeRead(true);
}

async function checkUnreadAndMaybeRead(forceReadWhenVisible) {
  if (!session || !session.myChannel) return;

  try {
    const data = await api('unreadCount', { myChannel: session.myChannel });
    const unread = Number(data.unread || 0);
    updateUnreadBadge(unread);

    if (unread > lastUnreadCount) {
      showUnreadNotification(unread);
    }

    lastUnreadCount = unread;
    saveLastUnread(unread);

    const chatIsOpen = chatView && !chatView.classList.contains('hidden');
    const shouldAutoRead = unread > 0 && chatIsOpen && !document.hidden && (forceReadWhenVisible || document.hasFocus());

    if (shouldAutoRead) {
      setTimeout(() => readAndDeleteNow(false), ACTIVE_READ_DELAY_MS);
    }
  } catch (err) {
    setStatus(err.message || '未讀檢查失敗');
  }
}

async function readAndDeleteNow(manual) {
  if (!session || !session.myChannel || readInFlight) return;
  readInFlight = true;

  const btn = $('readUnreadBtn');
  if (manual && btn) setBusy(btn, true, '讀取中');

  try {
    const data = await api('readAndDeleteSealed', { myChannel: session.myChannel });
    const packets = Array.isArray(data.packets) ? data.packets : [];

    if (!packets.length) {
      updateUnreadBadge(0);
      lastUnreadCount = 0;
      saveLastUnread(0);
      if (manual) setStatus('目前沒有未讀訊息。');
      return;
    }

    for (const item of packets) {
      try {
        const message = await decryptAngPacket(item.packet, session.sealedKey);
        addMessage(message.system ? 'system' : 'other', message.sender || '對方', message.text || '');
      } catch (err) {
        addMessage('system', '系統', '收到一則密封訊息，但這台裝置無法解密。');
      }
    }

    updateUnreadBadge(0);
    lastUnreadCount = 0;
    saveLastUnread(0);
    setStatus(`已讀取 ${packets.length} 則；後端快取已同步刪除。`);
  } catch (err) {
    setStatus(err.message || '讀取失敗');
  } finally {
    readInFlight = false;
    if (manual && btn) setBusy(btn, false, '讀取');
  }
}

async function sendMessage() {
  if (!session || !session.peerChannel || !session.sealedKey) {
    setStatus('尚未建立密封對話。');
    return;
  }

  const text = messageInput.value.trim();
  if (!text) return;

  const settings = getActiveSettings();
  const sender = session.label || '我';

  messageInput.value = '';
  addMessage('mine', '我', text);

  try {
    const packet = await makeAngPacket({
      sender,
      text,
      system: false,
      timestamp: Date.now()
    }, session.sealedKey);

    await api('sendSealedMessage', {
      peerChannel: session.peerChannel,
      packet,
      messageTtlSeconds: settings.messageTtlSeconds
    });
    setStatus('已送出 ANG 密封包。');
  } catch (err) {
    setStatus(err.message || '發送失敗');
    addMessage('system', '系統', '剛剛那則可能沒有送出去。');
  }
}

function addMessage(type, sender, text) {
  const settings = getActiveSettings();
  const isPeekMessage = type === 'other';

  const div = document.createElement('div');
  div.className = `msg ${type === 'mine' ? 'mine' : ''} ${type === 'system' ? 'system' : ''} ${isPeekMessage ? 'peek' : ''}`.trim();

  let senderEl = null;
  if (type !== 'system') {
    senderEl = document.createElement('span');
    senderEl.className = 'msg-sender';
    senderEl.textContent = isPeekMessage ? '密封訊息' : sender;
    div.appendChild(senderEl);
  }

  const textEl = document.createElement('span');
  textEl.className = 'msg-text';
  textEl.textContent = text;
  div.appendChild(textEl);

  let hintEl = null;
  if (isPeekMessage) {
    hintEl = document.createElement('span');
    hintEl.className = 'peek-hint';
    hintEl.textContent = `按住查看｜未開封 ${settings.sealedBubbleSeconds} 秒後消失`;
    div.appendChild(hintEl);
  }

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'msg-delete';
  deleteBtn.textContent = '立即刪';
  deleteBtn.title = '立即從畫面刪除';
  deleteBtn.setAttribute('aria-label', '立即從畫面刪除這則訊息');
  div.appendChild(deleteBtn);

  let timer = null;
  let opened = false;
  const openedLifetimeMs = settings.displaySeconds * 1000;
  const unopenedLifetimeMs = settings.sealedBubbleSeconds * 1000;

  function removeMessage() {
    if (timer) clearTimeout(timer);
    div.remove();
  }

  if (isPeekMessage) {
    // 還沒按住查看前，只是一顆密封泡泡；超時就消失。
    timer = setTimeout(removeMessage, unopenedLifetimeMs);

    const reveal = (event) => {
      if (event) event.preventDefault();
      if (!div.isConnected) return;
      div.classList.add('revealed');
      if (senderEl) senderEl.textContent = sender || '對方';
      if (hintEl) hintEl.textContent = `查看中｜${settings.displaySeconds} 秒後刪除`;

      // 第一次按住查看，才開始「看訊息後幾秒消失」倒數。
      if (!opened) {
        opened = true;
        if (timer) clearTimeout(timer);
        timer = setTimeout(removeMessage, openedLifetimeMs);
      }
    };

    const hide = () => {
      if (!div.isConnected) return;
      div.classList.remove('revealed');
      if (senderEl) senderEl.textContent = '密封訊息';
      if (hintEl) hintEl.textContent = opened ? '已開封倒數中｜按住可再次查看' : `按住查看｜未開封 ${settings.sealedBubbleSeconds} 秒後消失`;
    };

    div.addEventListener('pointerdown', reveal);
    div.addEventListener('pointerup', hide);
    div.addEventListener('pointercancel', hide);
    div.addEventListener('pointerleave', hide);
    window.addEventListener('blur', hide);
  } else {
    div.style.setProperty('--vanish-ms', `${openedLifetimeMs}ms`);
    timer = setTimeout(removeMessage, openedLifetimeMs);
  }

  deleteBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    removeMessage();
  });

  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}
function clearVisibleMessages() {
  chatBox.replaceChildren();
  updateUnreadBadge(0);
  saveLastUnread(0);
  lastUnreadCount = 0;
  setStatus('畫面已立即清空。未讀數也已在本機清除；後端已讀到的密封包在讀取時已刪除。');
}

async function api(action, payload) {
  const response = await fetch(`/api/${encodeURIComponent(action)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload || {}),
    cache: 'no-store'
  });

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new Error('API 回傳格式錯誤');
  }

  if (!response.ok || !data.ok) {
    throw new Error(data.error || `API 錯誤：${response.status}`);
  }

  return data;
}

async function copyInvite() {
  const text = inviteLink.value.trim();
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    setStatus('邀請連結已複製。請確認對方收到完整連結，包含 #angkey。');
  } catch (err) {
    inviteLink.focus();
    inviteLink.select();
    document.execCommand('copy');
    setStatus('邀請連結已選取，可手動複製。記得包含 #angkey。');
  }
}

function getInviteTokenFromUrl() {
  return new URL(location.href).searchParams.get('invite') || '';
}

function getInviteKeyFromHash() {
  const raw = String(location.hash || '').replace(/^#/, '');
  if (!raw) return '';
  const params = new URLSearchParams(raw);
  return params.get('angkey') || params.get('key') || '';
}

function updateUnreadBadge(count) {
  const unread = Math.max(0, Number(count || 0));
  const badge = $('unreadBadge');
  const btn = $('readUnreadBtn');

  if (badge) {
    badge.textContent = unread > 0 ? `未讀 ${unread}` : '無未讀';
    badge.classList.toggle('active', unread > 0);
  }

  if (btn) {
    btn.disabled = unread <= 0;
  }
}

function saveLastUnread(count) {
  if (!session) return;
  const key = `${session.myChannel || ''}`;
  try {
    const map = JSON.parse(localStorage.getItem(LAST_UNREAD_KEY) || '{}');
    map[key] = Math.max(0, Number(count || 0));
    localStorage.setItem(LAST_UNREAD_KEY, JSON.stringify(map));
  } catch (err) {}
}

function loadLastUnread() {
  if (!session) return 0;
  try {
    const map = JSON.parse(localStorage.getItem(LAST_UNREAD_KEY) || '{}');
    return Math.max(0, Number(map[session.myChannel] || 0));
  } catch (err) {
    return 0;
  }
}

function loadFriends() {
  try {
    const raw = localStorage.getItem(FRIENDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item) => item && item.session && item.session.myChannel && item.session.peerChannel && item.session.sealedKey)
      .map((item) => ({
        id: String(item.id || makeLocalId()),
        name: String(item.name || '未命名常用').slice(0, 40),
        session: normalizeSessionSettings(item.session),
        updatedAt: Number(item.updatedAt || Date.now())
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 20);
  } catch (err) {
    return [];
  }
}

function saveFriends(friends) {
  localStorage.setItem(FRIENDS_KEY, JSON.stringify(friends.slice(0, 20)));
}

function renderFriendsList() {
  if (!friendsPanel || !friendsList) return;

  const friends = loadFriends();
  friendsList.replaceChildren();

  if (!friends.length) {
    friendsPanel.classList.add('hidden');
    return;
  }

  friendsPanel.classList.remove('hidden');

  friends.forEach((friend) => {
    const item = document.createElement('div');
    item.className = 'friend-item';

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'friend-main';
    main.innerHTML = `<strong></strong><span></span>`;
    main.querySelector('strong').textContent = friend.name;
    main.querySelector('span').textContent = `上次使用：${formatDate(friend.updatedAt)}`;
    main.addEventListener('click', () => openFriend(friend.id));

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'friend-action';
    rename.textContent = '改名';
    rename.addEventListener('click', () => renameFriend(friend.id));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'friend-action danger-soft';
    remove.textContent = '刪除';
    remove.addEventListener('click', () => deleteFriend(friend.id));

    item.appendChild(main);
    item.appendChild(rename);
    item.appendChild(remove);
    friendsList.appendChild(item);
  });
}

function saveCurrentAsFriend() {
  if (!session || !session.myChannel || !session.peerChannel || !session.sealedKey) {
    setStatus('尚未建立可儲存的密封對話。');
    return;
  }

  const existingName = findFriendNameBySession(session) || '常用對話';
  const name = prompt('要把這個對話存成什麼名稱？例如：Lisa、小藍', existingName);
  if (name === null) return;

  const safeName = String(name || '').trim().slice(0, 40);
  if (!safeName) {
    setStatus('名稱不可為空。');
    return;
  }

  const friends = loadFriends();
  const key = friendSessionKey(session);
  const existingIndex = friends.findIndex((item) => friendSessionKey(item.session) === key);
  const record = {
    id: existingIndex >= 0 ? friends[existingIndex].id : makeLocalId(),
    name: safeName,
    session: normalizeSessionSettings(session),
    updatedAt: Date.now()
  };

  if (existingIndex >= 0) friends.splice(existingIndex, 1);
  friends.unshift(record);
  saveFriends(friends);
  renderFriendsList();
  enterChat();
  setStatus(`已加入常用：${safeName}`);
}

function openFriend(id) {
  const friends = loadFriends();
  const index = friends.findIndex((item) => item.id === id);
  if (index < 0) {
    setStatus('找不到這個常用對話。');
    renderFriendsList();
    return;
  }

  const item = friends[index];
  item.updatedAt = Date.now();
  friends.splice(index, 1);
  friends.unshift(item);
  saveFriends(friends);

  session = normalizeSessionSettings(item.session);
  saveSession(session);
  goCleanBaseUrl();
  enterChat();
  addMessage('system', '系統', `已開啟常用對話：${item.name}`);
}

function renameFriend(id) {
  const friends = loadFriends();
  const item = friends.find((friend) => friend.id === id);
  if (!item) return;

  const name = prompt('新的常用名稱', item.name);
  if (name === null) return;

  const safeName = String(name || '').trim().slice(0, 40);
  if (!safeName) return;

  item.name = safeName;
  item.updatedAt = Date.now();
  saveFriends(friends);
  renderFriendsList();
  setStatus(`已改名：${safeName}`);
}

function deleteFriend(id) {
  const friends = loadFriends();
  const item = friends.find((friend) => friend.id === id);
  if (!item) return;
  if (!confirm(`確定從常用刪除「${item.name}」？這只會刪除本機常用，不會影響對方。`)) return;

  saveFriends(friends.filter((friend) => friend.id !== id));
  renderFriendsList();
  setStatus('已從常用刪除。');
}

function findFriendNameBySession(value) {
  if (!value) return '';
  const key = friendSessionKey(value);
  const found = loadFriends().find((item) => friendSessionKey(item.session) === key);
  return found ? found.name : '';
}

function friendSessionKey(value) {
  if (!value) return '';
  return `${value.myChannel || ''}->${value.peerChannel || ''}`;
}

function makeLocalId() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return `local_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function formatDate(timestamp) {
  const date = new Date(Number(timestamp || Date.now()));
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hour}:${minute}`;
}

async function enableNotifications() {
  if (!('Notification' in window)) {
    setStatus('這個瀏覽器不支援網頁通知。');
    updateNotifyButton();
    return;
  }

  if (Notification.permission === 'denied') {
    setStatus('通知已被瀏覽器封鎖，請到網站設定重新允許。');
    updateNotifyButton();
    return;
  }

  let permission = Notification.permission;
  if (permission !== 'granted') {
    permission = await Notification.requestPermission();
  }

  if (permission === 'granted') {
    localStorage.setItem(NOTIFY_PREF_KEY, '1');
    setStatus('通知已開啟。通知不顯示人名或內容，只提示有新的臨時訊息。');
    updateNotifyButton();
    await showTestNotification();
    return;
  }

  localStorage.setItem(NOTIFY_PREF_KEY, '0');
  setStatus('尚未允許通知。');
  updateNotifyButton();
}

function notificationsEnabled() {
  return localStorage.getItem(NOTIFY_PREF_KEY) === '1' && 'Notification' in window && Notification.permission === 'granted';
}

function updateNotifyButton() {
  const btn = $('enableNotifyBtn');
  if (!btn) return;

  if (!('Notification' in window)) {
    btn.textContent = '不支援';
    btn.disabled = true;
    return;
  }

  if (Notification.permission === 'granted' && localStorage.getItem(NOTIFY_PREF_KEY) === '1') {
    btn.textContent = '通知開';
    btn.disabled = false;
    return;
  }

  if (Notification.permission === 'denied') {
    btn.textContent = '通知封鎖';
    btn.disabled = false;
    return;
  }

  btn.textContent = '通知';
  btn.disabled = false;
}

async function showTestNotification() {
  await showNotification('臨時對話通知已開啟', {
    body: '收到新訊息時只會提醒，不顯示內容。',
    tag: 'ephemeral-chat-test',
    renotify: false
  });
}

async function showUnreadNotification(unread) {
  if (!notificationsEnabled()) return;
  if (!document.hidden && chatView && !chatView.classList.contains('hidden')) return;

  const count = Math.max(1, Number(unread || 1));
  await showNotification('你有新的臨時訊息', {
    body: `未讀 ${count} 則。打開後才讀取並同步刪除。`,
    tag: 'ephemeral-chat-unread',
    renotify: true
  });
}

async function showNotification(title, options) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const payload = {
    body: options && options.body ? options.body : '',
    icon: '/assets/icon-192.png',
    badge: '/assets/icon-192.png',
    tag: options && options.tag ? options.tag : 'ephemeral-chat',
    renotify: Boolean(options && options.renotify),
    data: { url: getAppBaseUrl() }
  };

  try {
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration && registration.showNotification) {
        await registration.showNotification(title, payload);
        return;
      }
    }
  } catch (err) {}

  try {
    new Notification(title, payload);
  } catch (err) {}
}

function resetSession() {
  if (!confirm('確定要清除本機對話設定？清除後需要重新建立邀請。')) return;
  localStorage.removeItem(SESSION_KEY);
  session = null;
  if (pollTimer) clearInterval(pollTimer);
  goCleanBaseUrl();
  location.reload();
}

function saveSession(value) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(value));
}

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.myChannel || !parsed.peerChannel || !parsed.sealedKey) return null;
    return normalizeSessionSettings(parsed);
  } catch (err) {
    return null;
  }
}

function loadLocalSettings() {
  try {
    const raw = localStorage.getItem(LOCAL_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return sanitizeSettings(JSON.parse(raw));
  } catch (err) {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveLocalSettings(settings) {
  localStorage.setItem(LOCAL_SETTINGS_KEY, JSON.stringify(sanitizeSettings(settings)));
}

function loadSettingsIntoForm(settings) {
  const value = sanitizeSettings(settings || loadLocalSettings());
  $('displaySeconds').value = value.displaySeconds;
  $('sealedBubbleSeconds').value = value.sealedBubbleSeconds;
  $('messageTtlSeconds').value = value.messageTtlSeconds;
  $('inviteTtlSeconds').value = value.inviteTtlSeconds;
}

function getSettingsFromForm() {
  return sanitizeSettings({
    displaySeconds: $('displaySeconds').value,
    sealedBubbleSeconds: $('sealedBubbleSeconds').value,
    messageTtlSeconds: $('messageTtlSeconds').value,
    inviteTtlSeconds: $('inviteTtlSeconds').value
  });
}

function getActiveSettings() {
  if (session && session.settings) return sanitizeSettings(session.settings);
  return sanitizeSettings(loadLocalSettings());
}

function normalizeSessionSettings(value) {
  if (!value) return value;
  return {
    ...value,
    sealedKey: String(value.sealedKey || ''),
    settings: sanitizeSettings(value.settings || loadLocalSettings())
  };
}

function sanitizeSettings(value) {
  const source = value || {};
  return {
    displaySeconds: clampNumber(source.displaySeconds, DEFAULT_SETTINGS.displaySeconds, LIMITS.displaySeconds.min, LIMITS.displaySeconds.max),
    sealedBubbleSeconds: clampNumber(source.sealedBubbleSeconds, DEFAULT_SETTINGS.sealedBubbleSeconds, LIMITS.sealedBubbleSeconds.min, LIMITS.sealedBubbleSeconds.max),
    messageTtlSeconds: clampNumber(source.messageTtlSeconds, DEFAULT_SETTINGS.messageTtlSeconds, LIMITS.messageTtlSeconds.min, LIMITS.messageTtlSeconds.max),
    inviteTtlSeconds: clampNumber(source.inviteTtlSeconds, DEFAULT_SETTINGS.inviteTtlSeconds, LIMITS.inviteTtlSeconds.min, LIMITS.inviteTtlSeconds.max)
  };
}

function clampNumber(value, fallback, min, max) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function formatSeconds(seconds) {
  const s = Number(seconds) || 0;
  if (s >= 3600) {
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    return minutes ? `${hours} 小時 ${minutes} 分鐘` : `${hours} 小時`;
  }
  if (s >= 60) {
    const minutes = Math.floor(s / 60);
    const remain = s % 60;
    return remain ? `${minutes} 分 ${remain} 秒` : `${minutes} 分鐘`;
  }
  return `${s} 秒`;
}

function maybeShowInstallBox() {
  if (!session) return;
  if (localStorage.getItem(INSTALL_DISMISSED_KEY) === '1') return;
  if (isStandalone()) return;

  const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  if (deferredInstallPrompt) {
    installText.textContent = '這個裝置支援直接安裝。安裝後可以從主畫面開啟。';
    installBtn.textContent = '安裝';
    installBtn.disabled = false;
    installBox.classList.remove('hidden');
    return;
  }

  if (isiOS) {
    installText.textContent = 'iPhone 請使用 Safari 開啟，按分享按鈕，再選「加入主畫面」。通知需在加入主畫面後再允許會比較穩。';
    installBtn.textContent = '知道了';
    installBtn.disabled = false;
    installBox.classList.remove('hidden');
  }
}

async function installPwa() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installBox.classList.add('hidden');
    return;
  }

  localStorage.setItem(INSTALL_DISMISSED_KEY, '1');
  installBox.classList.add('hidden');
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function setBusy(button, busy, text) {
  if (!button) return;
  button.disabled = busy;
  button.textContent = text;
}

function setStatus(text) {
  statusBar.textContent = text;
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}

function makeSealedKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function importAesKey(base64UrlKey) {
  const raw = base64UrlToBytes(base64UrlKey);
  if (raw.byteLength !== 32) throw new Error('密鑰格式錯誤');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function makeAngPacket(message, base64UrlKey) {
  const key = await importAesKey(base64UrlKey);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);

  const plain = new TextEncoder().encode(JSON.stringify({
    v: 1,
    sender: String(message.sender || '對方').slice(0, 40),
    text: String(message.text || '').slice(0, 1000),
    system: Boolean(message.system),
    timestamp: Number(message.timestamp || Date.now())
  }));

  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const wrapper = {
    v: 1,
    type: 'ANG_SEALED_MESSAGE',
    alg: 'AES-GCM-256',
    iv: bytesToBase64Url(iv),
    data: bytesToBase64Url(cipher)
  };

  return `ANG1.${stringToBase64Url(JSON.stringify(wrapper))}`;
}

async function decryptAngPacket(packet, base64UrlKey) {
  const text = String(packet || '');
  if (!text.startsWith('ANG1.')) throw new Error('不是 ANG 密封包');

  const wrapperText = base64UrlToString(text.slice(5));
  const wrapper = JSON.parse(wrapperText);
  if (!wrapper || wrapper.v !== 1 || !wrapper.iv || !wrapper.data) throw new Error('密封包格式錯誤');

  const key = await importAesKey(base64UrlKey);
  const iv = base64UrlToBytes(wrapper.iv);
  const data = base64UrlToBytes(wrapper.data);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  const message = JSON.parse(new TextDecoder().decode(plain));

  return {
    sender: String(message.sender || '對方').slice(0, 40),
    text: String(message.text || '').slice(0, 1000),
    system: Boolean(message.system),
    timestamp: Number(message.timestamp || Date.now())
  };
}

function bytesToBase64Url(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(base64Url) {
  const base64 = String(base64Url || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function stringToBase64Url(value) {
  return bytesToBase64Url(new TextEncoder().encode(String(value || '')));
}

function base64UrlToString(base64Url) {
  return new TextDecoder().decode(base64UrlToBytes(base64Url));
}
