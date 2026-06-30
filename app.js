const SESSION_KEY = 'ephemeral_chat_v41_session';
const INSTALL_DISMISSED_KEY = 'ephemeral_chat_v41_install_dismissed';
const LOCAL_SETTINGS_KEY = 'ephemeral_chat_v41_settings';
const FRIENDS_KEY = 'ephemeral_chat_v41_friends';
const NOTIFY_PREF_KEY = 'ephemeral_chat_v41_notify_enabled';
const LAST_UNREAD_KEY = 'ephemeral_chat_v41_last_unread';
const PROFILE_KEY = 'ephemeral_chat_v41_profile';

const DEFAULT_SETTINGS = {
  displaySeconds: 5,
  sealedBubbleSeconds: 60,
  messageTtlSeconds: 3600
};

const LIMITS = {
  displaySeconds: { min: 1, max: 60 },
  sealedBubbleSeconds: { min: 3, max: 300 },
  messageTtlSeconds: { min: 5, max: 21600 }
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

window.addEventListener('load', init);
window.addEventListener('focus', () => {
  if (session) checkUnreadAndMaybeRead(true);
});

document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('privacy-hidden', document.hidden);
  hideAllPeekMessages();
  if (!document.hidden && session) checkUnreadAndMaybeRead(true);
});

window.addEventListener('blur', hideAllPeekMessages);

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  maybeShowInstallBox();
});

async function init() {
  registerServiceWorker();
  bindEvents();
  loadSettingsIntoForm();
  loadProfileIntoForm();
  renderFriendsList();

  const inviteKey = getInviteKeyFromHash();
  session = loadSession();

  if (inviteKey && (!session || session.sealedKey !== inviteKey)) {
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
  $('resetBtn').addEventListener('click', resetSession);

  const saveIdentityBtn = $('saveIdentityBtn');
  if (saveIdentityBtn) saveIdentityBtn.addEventListener('click', () => saveProfileFromInput('displayName'));

  const saveGuestIdentityBtn = $('saveGuestIdentityBtn');
  if (saveGuestIdentityBtn) saveGuestIdentityBtn.addEventListener('click', () => saveProfileFromInput('guestName'));

  const enableNotifyBtn = $('enableNotifyBtn');
  if (enableNotifyBtn) enableNotifyBtn.addEventListener('click', enableNotifications);

  const readUnreadBtn = $('readUnreadBtn');
  if (readUnreadBtn) readUnreadBtn.addEventListener('click', () => readAndDeleteNow(true));

  const saveFriendBtn = $('saveFriendBtn');
  if (saveFriendBtn) saveFriendBtn.addEventListener('click', saveCurrentAsFriend);

  $('dismissInstallBtn').addEventListener('click', () => {
    localStorage.setItem(INSTALL_DISMISSED_KEY, '1');
    installBox.classList.add('hidden');
  });
  installBtn.addEventListener('click', installPwa);

  ['displaySeconds', 'sealedBubbleSeconds', 'messageTtlSeconds'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', () => {
      const settings = getSettingsFromForm();
      saveLocalSettings(settings);
      loadSettingsIntoForm(settings);
      if (session) {
        session.settings = settings;
        saveSession(session);
        updateChatSub();
      }
    });
  });

  $('messageForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    await sendMessage();
  });
}

function getAppBaseUrl() {
  const url = new URL('./', location.href);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function goCleanBaseUrl() {
  history.replaceState({}, '', getAppBaseUrl());
}

function showSetupView() {
  setupView.classList.remove('hidden');
  acceptView.classList.add('hidden');
  chatView.classList.add('hidden');
  setStatus('固定身份與好友只存在這台裝置。後端只收發 ANG 密封包。');
}

function showAcceptView() {
  setupView.classList.add('hidden');
  acceptView.classList.remove('hidden');
  chatView.classList.add('hidden');
  const hasKey = Boolean(getInviteKeyFromHash());
  setStatus(hasKey ? '偵測到 #angkey，等待你解鎖加入。' : '連結缺少 #angkey，請對方重新複製完整連結。');
}

async function createInvite() {
  const label = getIdentityLabel('displayName');
  const friendName = $('creatorFriendName') && $('creatorFriendName').value.trim()
    ? $('creatorFriendName').value.trim().slice(0, 40)
    : '新好友';
  const settings = getSettingsFromForm();

  saveLocalSettings(settings);
  saveProfile({ label });
  updateIdentityStatus();
  setBusy($('createInviteBtn'), true, '產生密鑰中...');

  try {
    const masterKey = makeSealedKey();
    const creatorChannel = await deriveChannelId(masterKey, 'creator');
    const guestChannel = await deriveChannelId(masterKey, 'guest');

    session = normalizeSessionSettings({
      role: 'creator',
      myChannel: creatorChannel,
      peerChannel: guestChannel,
      sealedKey: masterKey,
      label,
      settings,
      createdAt: Date.now()
    });

    saveSession(session);
    saveFriendRecord(friendName, session, false);
    renderFriendsList();

    const url = new URL(getAppBaseUrl());
    url.hash = `angkey=${encodeURIComponent(masterKey)}`;
    inviteLink.value = url.toString();
    invitePanel.classList.remove('hidden');

    setStatus('邀請已建立。請確認複製到的連結包含 #angkey。');
  } catch (err) {
    setStatus('建立失敗：' + (err.message || String(err)));
  } finally {
    setBusy($('createInviteBtn'), false, '建立加好友連結');
  }
}

async function acceptInvite() {
  const inviteKey = getInviteKeyFromHash();
  const label = getIdentityLabel('guestName');
  const friendName = $('guestFriendName') && $('guestFriendName').value.trim()
    ? $('guestFriendName').value.trim().slice(0, 40)
    : '新好友';

  if (!inviteKey) {
    setStatus('無法加入。這條連結缺少 #angkey。');
    return;
  }

  setBusy($('acceptInviteBtn'), true, '解鎖中...');

  try {
    await importAesKey(inviteKey);
    const guestChannel = await deriveChannelId(inviteKey, 'guest');
    const creatorChannel = await deriveChannelId(inviteKey, 'creator');

    session = normalizeSessionSettings({
      role: 'guest',
      myChannel: guestChannel,
      peerChannel: creatorChannel,
      sealedKey: inviteKey,
      label,
      settings: loadLocalSettings(),
      createdAt: Date.now()
    });

    saveProfile({ label });
    saveSession(session);
    saveFriendRecord(friendName, session, false);
    renderFriendsList();

    goCleanBaseUrl();
    enterChat();
    addMessage('system', '系統', '你已加入這個永久密封頻道。');
  } catch (err) {
    setStatus('密鑰無效或格式錯誤。');
  } finally {
    setBusy($('acceptInviteBtn'), false, '解鎖並加入好友');
  }
}

async function healthCheck() {
  setBusy($('healthBtn'), true, '測試中...');
  try {
    const data = await api('health', {});
    setStatus(data.ok ? `後端正常：${data.version || 'OK'}` : (data.error || '後端異常'));
  } catch (err) {
    setStatus(err.message || '後端測試失敗');
  } finally {
    setBusy($('healthBtn'), false, '測試連線');
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

  $('chatTitle').textContent = session.role === 'creator' ? '密封對話｜我建立的' : '密封對話｜已加入';
  updateChatSub();
  updateNotifyButton();
  updateUnreadBadge(loadLastUnread());

  setStatus('端到端加密運作中。GAS 只看到亂碼頻道與 ANG1 密封包。');
  startPolling();
  maybeShowInstallBox();
  setTimeout(() => messageInput.focus(), 80);
}

function updateChatSub() {
  if (!session || !$('chatSub')) return;
  const friendName = findFriendNameBySession(session);
  const settings = getActiveSettings();
  $('chatSub').textContent = `${friendName ? '好友：' + friendName + '｜' : ''}離線保留 ${formatSeconds(settings.messageTtlSeconds)}｜按圓點查看 ${settings.displaySeconds} 秒`;
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
    const unread = Math.max(0, Number(data.unread || 0));

    updateUnreadBadge(unread);
    if (unread > lastUnreadCount) showUnreadNotification(unread);

    lastUnreadCount = unread;
    saveLastUnread(unread);

    const chatIsOpen = chatView && !chatView.classList.contains('hidden');
    const shouldRead = unread > 0 && chatIsOpen && !document.hidden && (forceReadWhenVisible || document.hasFocus());
    if (shouldRead) setTimeout(() => readAndDeleteNow(false), ACTIVE_READ_DELAY_MS);
  } catch (err) {
    // 背景輪詢失敗不打擾畫面。
  }
}

async function readAndDeleteNow(manual) {
  if (!session || !session.myChannel || readInFlight) return;
  readInFlight = true;

  const btn = $('readUnreadBtn');
  if (manual && btn) setBusy(btn, true, '收取中');

  try {
    const data = await api('readAndDeleteSealed', { myChannel: session.myChannel });
    const packets = Array.isArray(data.packets) ? data.packets : [];

    if (!packets.length) {
      updateUnreadBadge(0);
      lastUnreadCount = 0;
      saveLastUnread(0);
      if (manual) setStatus('目前沒有新密封包。');
      return;
    }

    for (const item of packets) {
      try {
        const message = await decryptAngPacket(item.packet, session.sealedKey);
        addMessage(message.system ? 'system' : 'other', message.sender || '對方', message.text || '');
      } catch (err) {
        addMessage('system', '系統', '收到一則無法解密的封包。');
      }
    }

    updateUnreadBadge(0);
    lastUnreadCount = 0;
    saveLastUnread(0);
    setStatus(`已收取並銷毀 ${packets.length} 則密封包。`);
  } catch (err) {
    if (manual) setStatus(err.message || '收取失敗');
  } finally {
    readInFlight = false;
    if (manual && btn) setBusy(btn, false, '收訊');
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
    const packet = await makeAngPacket({ sender, text, system: false, timestamp: Date.now() }, session.sealedKey);
    await api('sendSealedMessage', {
      peerChannel: session.peerChannel,
      packet,
      messageTtlSeconds: settings.messageTtlSeconds
    });
    setStatus('ANG1 密封包已送出。');
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
  let peekDot = null;

  if (isPeekMessage) {
    hintEl = document.createElement('span');
    hintEl.className = 'peek-hint';
    hintEl.textContent = `按住下方圓點查看｜未開封 ${settings.sealedBubbleSeconds} 秒後消失`;
    div.appendChild(hintEl);

    peekDot = document.createElement('button');
    peekDot.type = 'button';
    peekDot.className = 'peek-dot';
    peekDot.setAttribute('aria-label', '按住查看密封訊息');
    peekDot.title = '按住查看，放開模糊';
    div.appendChild(peekDot);
  }

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'msg-delete';
  deleteBtn.textContent = '立即刪';
  deleteBtn.title = '立即從畫面刪除';
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
    timer = setTimeout(removeMessage, unopenedLifetimeMs);

    const reveal = (event) => {
      if (event) event.preventDefault();
      if (!div.isConnected) return;
      div.classList.add('revealed');
      if (senderEl) senderEl.textContent = sender || '對方';
      if (hintEl) hintEl.textContent = `查看中｜${settings.displaySeconds} 秒後刪除`;

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
      if (hintEl) hintEl.textContent = opened ? '已開封倒數中｜按住圓點可再次查看' : `按住下方圓點查看｜未開封 ${settings.sealedBubbleSeconds} 秒後消失`;
    };

    peekDot.addEventListener('pointerdown', reveal);
    peekDot.addEventListener('pointerup', hide);
    peekDot.addEventListener('pointercancel', hide);
    peekDot.addEventListener('pointerleave', hide);
    peekDot.addEventListener('touchstart', reveal, { passive: false });
    peekDot.addEventListener('touchend', hide);
    window.addEventListener('blur', hide);
  } else if (type !== 'system') {
    div.style.setProperty('--vanish-ms', `${openedLifetimeMs}ms`);
    timer = setTimeout(removeMessage, openedLifetimeMs);
  } else {
    timer = setTimeout(removeMessage, Math.max(3000, openedLifetimeMs));
  }

  deleteBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    removeMessage();
  });

  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function hideAllPeekMessages() {
  document.querySelectorAll('.msg.peek.revealed').forEach((node) => node.classList.remove('revealed'));
}

function clearVisibleMessages() {
  chatBox.replaceChildren();
  updateUnreadBadge(0);
  saveLastUnread(0);
  lastUnreadCount = 0;
  setStatus('畫面已清空。');
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
    setStatus('邀請連結已複製。請確認包含 #angkey。');
  } catch (err) {
    inviteLink.focus();
    inviteLink.select();
    document.execCommand('copy');
    setStatus('邀請連結已選取，可手動複製。');
  }
}

function getInviteKeyFromHash() {
  const raw = String(location.hash || '').replace(/^#/, '');
  if (!raw) return '';
  const params = new URLSearchParams(raw);
  return params.get('angkey') || params.get('key') || '';
}

function updateUnreadBadge(count) {
  const unread = Math.max(0, Number(count || 0));
  if ($('unreadBadge')) {
    $('unreadBadge').textContent = unread > 0 ? `新訊息 ${unread}` : '新訊息 0';
    $('unreadBadge').classList.toggle('active', unread > 0);
  }
  if ($('readUnreadBtn')) $('readUnreadBtn').disabled = unread <= 0;
}

function saveLastUnread(count) {
  if (!session) return;
  try {
    const map = JSON.parse(localStorage.getItem(LAST_UNREAD_KEY) || '{}');
    map[session.myChannel || ''] = Math.max(0, Number(count || 0));
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

function loadProfile() {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}') || {};
  } catch (err) {
    return {};
  }
}

function saveProfile(profile) {
  const old = loadProfile();
  const next = { ...old, ...profile, updatedAt: Date.now() };
  localStorage.setItem(PROFILE_KEY, JSON.stringify(next));
  return next;
}

function loadProfileIntoForm() {
  const profile = loadProfile();
  if (profile.label) {
    if ($('displayName')) $('displayName').value = profile.label;
    if ($('guestName')) $('guestName').value = profile.label;
  }
  updateIdentityStatus();
}

function saveProfileFromInput(inputId) {
  const input = $(inputId);
  const label = input && input.value.trim() ? input.value.trim().slice(0, 30) : '我';
  saveProfile({ label });
  if ($('displayName')) $('displayName').value = label;
  if ($('guestName')) $('guestName').value = label;
  updateIdentityStatus();
  setStatus('固定身份已儲存。');
}

function getIdentityLabel(inputId) {
  const input = $(inputId);
  const profile = loadProfile();
  const label = input && input.value.trim() ? input.value.trim().slice(0, 30) : (profile.label || '我');
  if (input) input.value = label;
  return label;
}

function updateIdentityStatus() {
  const profile = loadProfile();
  if ($('identityStatus')) {
    $('identityStatus').textContent = profile.label ? `目前身份：${profile.label}` : '第一次使用先存身份；之後建立邀請與聊天都會自動使用這個名字。';
  }
}

function loadFriends() {
  try {
    const raw = localStorage.getItem(FRIENDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function saveFriends(friends) {
  localStorage.setItem(FRIENDS_KEY, JSON.stringify(friends.slice(0, 50)));
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

    const title = document.createElement('strong');
    title.textContent = friend.name || '未命名好友';

    const sub = document.createElement('span');
    sub.textContent = `上次使用：${formatDate(friend.updatedAt || Date.now())}`;

    main.appendChild(title);
    main.appendChild(sub);
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
  if (!session || !session.myChannel) return;
  const existingName = findFriendNameBySession(session) || '常用對話';
  const name = prompt('要把這個頻道存成什麼名稱？', existingName);
  if (!name) return;
  saveFriendRecord(name.trim().slice(0, 40), session, true);
  renderFriendsList();
  updateChatSub();
  setStatus('已加入常用。');
}

function saveFriendRecord(name, sessionValue, askOverwrite) {
  if (!sessionValue || !sessionValue.myChannel) return;
  const friends = loadFriends();
  const existingIndex = friends.findIndex((item) => item.session && item.session.myChannel === sessionValue.myChannel);
  const record = {
    id: existingIndex >= 0 ? friends[existingIndex].id : makeLocalId(),
    name: name || '常用對話',
    session: normalizeSessionSettings(sessionValue),
    updatedAt: Date.now()
  };

  if (existingIndex >= 0) {
    if (!askOverwrite || confirm('這個好友已存在，要更新名稱與設定嗎？')) {
      friends.splice(existingIndex, 1);
    } else {
      return;
    }
  }

  friends.unshift(record);
  saveFriends(friends);
}

function openFriend(id) {
  const friends = loadFriends();
  const index = friends.findIndex((item) => item.id === id);
  if (index < 0) return;

  friends[index].updatedAt = Date.now();
  session = normalizeSessionSettings(friends[index].session);
  saveSession(session);
  saveFriends(friends);
  goCleanBaseUrl();
  enterChat();
  renderFriendsList();
}

function renameFriend(id) {
  const friends = loadFriends();
  const index = friends.findIndex((item) => item.id === id);
  if (index < 0) return;
  const name = prompt('新的好友名稱', friends[index].name || '常用對話');
  if (!name) return;
  friends[index].name = name.trim().slice(0, 40);
  friends[index].updatedAt = Date.now();
  saveFriends(friends);
  renderFriendsList();
  updateChatSub();
}

function deleteFriend(id) {
  if (!confirm('刪除這個本機好友捷徑？不會影響對方。')) return;
  saveFriends(loadFriends().filter((item) => item.id !== id));
  renderFriendsList();
}

function findFriendNameBySession(value) {
  if (!value) return '';
  const found = loadFriends().find((item) => item.session && item.session.myChannel === value.myChannel);
  return found ? found.name : '';
}

function makeLocalId() {
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatDate(timestamp) {
  const d = new Date(Number(timestamp || Date.now()));
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function enableNotifications() {
  if (!('Notification' in window)) {
    setStatus('這個瀏覽器不支援通知。');
    return;
  }

  let permission = Notification.permission;
  if (permission !== 'granted') permission = await Notification.requestPermission();

  if (permission === 'granted') {
    localStorage.setItem(NOTIFY_PREF_KEY, '1');
    updateNotifyButton();
    new Notification('通知已開啟', { body: '通知不會顯示訊息內容。', icon: '/assets/icon-192.png' });
    setStatus('通知已開啟。');
  } else {
    setStatus('通知未開啟。');
  }
}

function updateNotifyButton() {
  const btn = $('enableNotifyBtn');
  if (!btn) return;

  if ('Notification' in window && Notification.permission === 'granted' && localStorage.getItem(NOTIFY_PREF_KEY) === '1') {
    btn.textContent = '通知開';
  } else {
    btn.textContent = '通知';
  }
}

function showUnreadNotification(unread) {
  if (!('Notification' in window)) return;
  if (localStorage.getItem(NOTIFY_PREF_KEY) !== '1' || Notification.permission !== 'granted') return;
  if (!document.hidden && chatView && !chatView.classList.contains('hidden')) return;

  new Notification('新的臨時訊息', {
    body: `新訊息 ${unread} 則`,
    icon: '/assets/icon-192.png',
    tag: 'ephemeral-unread'
  });
}

function resetSession() {
  if (!confirm('確定要離開目前對話？好友清單不會被刪除。')) return;
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
  if ($('displaySeconds')) $('displaySeconds').value = value.displaySeconds;
  if ($('sealedBubbleSeconds')) $('sealedBubbleSeconds').value = value.sealedBubbleSeconds;
  if ($('messageTtlSeconds')) $('messageTtlSeconds').value = value.messageTtlSeconds;
}

function getSettingsFromForm() {
  return sanitizeSettings({
    displaySeconds: $('displaySeconds') ? $('displaySeconds').value : DEFAULT_SETTINGS.displaySeconds,
    sealedBubbleSeconds: $('sealedBubbleSeconds') ? $('sealedBubbleSeconds').value : DEFAULT_SETTINGS.sealedBubbleSeconds,
    messageTtlSeconds: $('messageTtlSeconds') ? $('messageTtlSeconds').value : DEFAULT_SETTINGS.messageTtlSeconds
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
    settings: sanitizeSettings(value.settings || loadLocalSettings())
  };
}

function sanitizeSettings(value) {
  const source = value || {};
  return {
    displaySeconds: clampNumber(source.displaySeconds, DEFAULT_SETTINGS.displaySeconds, LIMITS.displaySeconds.min, LIMITS.displaySeconds.max),
    sealedBubbleSeconds: clampNumber(source.sealedBubbleSeconds, DEFAULT_SETTINGS.sealedBubbleSeconds, LIMITS.sealedBubbleSeconds.min, LIMITS.sealedBubbleSeconds.max),
    messageTtlSeconds: clampNumber(source.messageTtlSeconds, DEFAULT_SETTINGS.messageTtlSeconds, LIMITS.messageTtlSeconds.min, LIMITS.messageTtlSeconds.max)
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
    installText.textContent = 'iPhone 請使用 Safari 開啟，按分享按鈕，再選「加入主畫面」。';
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
  if (statusBar) statusBar.textContent = text;
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/service-worker.js').catch(() => {});
}

function makeSealedKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function deriveChannelId(masterKeyBase64, roleStr) {
  const rawKey = base64UrlToBytes(masterKeyBase64);
  const roleBytes = new TextEncoder().encode(`ANG_CHANNEL_V1:${roleStr}`);
  const data = new Uint8Array(rawKey.length + roleBytes.length);
  data.set(rawKey);
  data.set(roleBytes, rawKey.length);

  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return 'ch_' + hashArray.map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

async function importAesKey(base64UrlKey) {
  const raw = base64UrlToBytes(base64UrlKey);
  if (raw.length !== 32) throw new Error('Invalid key length');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function makeAngPacket(message, base64UrlKey) {
  const key = await importAesKey(base64UrlKey);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const plain = new TextEncoder().encode(JSON.stringify(message));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const wrapper = {
    v: 1,
    type: 'ANG',
    alg: 'AES-GCM',
    iv: bytesToBase64Url(iv),
    data: bytesToBase64Url(cipher)
  };
  return `ANG1.${stringToBase64Url(JSON.stringify(wrapper))}`;
}

async function decryptAngPacket(packet, base64UrlKey) {
  const text = String(packet || '');
  if (!text.startsWith('ANG1.')) throw new Error('Invalid packet');
  const wrapper = JSON.parse(base64UrlToString(text.slice(5)));
  const key = await importAesKey(base64UrlKey);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64UrlToBytes(wrapper.iv) }, key, base64UrlToBytes(wrapper.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(str) {
  const value = String(str || '');
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function stringToBase64Url(value) {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function base64UrlToString(value) {
  return new TextDecoder().decode(base64UrlToBytes(value));
}
