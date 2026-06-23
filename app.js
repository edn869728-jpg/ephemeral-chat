const SESSION_KEY = 'ephemeral_chat_v35_session';
const INSTALL_DISMISSED_KEY = 'ephemeral_chat_v35_install_dismissed';
const LOCAL_SETTINGS_KEY = 'ephemeral_chat_v35_settings';
const FRIENDS_KEY = 'ephemeral_chat_v35_friends';

const DEFAULT_SETTINGS = {
  displaySeconds: 3,
  messageTtlSeconds: 20,
  inviteTtlSeconds: 30 * 60
};

const LIMITS = {
  displaySeconds: { min: 1, max: 60 },
  messageTtlSeconds: { min: 5, max: 600 },
  inviteTtlSeconds: { min: 30, max: 86400 }
};

const POLL_INTERVAL_MS = 1400;

let session = null;
let pollTimer = null;
let deferredInstallPrompt = null;

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

  const invite = new URL(location.href).searchParams.get('invite');
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
  $('saveFriendBtn').addEventListener('click', saveCurrentAsFriend);
  $('resetBtn').addEventListener('click', resetSession);
  $('dismissInstallBtn').addEventListener('click', () => {
    localStorage.setItem(INSTALL_DISMISSED_KEY, '1');
    installBox.classList.add('hidden');
  });
  installBtn.addEventListener('click', installPwa);

  ['displaySeconds', 'messageTtlSeconds', 'inviteTtlSeconds'].forEach((id) => {
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
  renderFriendsList();
  setStatus('建立對話後，系統會自動產生一次性邀請連結。');
}

function showAcceptView() {
  setupView.classList.add('hidden');
  acceptView.classList.remove('hidden');
  chatView.classList.add('hidden');
  setStatus('偵測到邀請連結，等待你接受。');
}

async function createInvite() {
  const label = $('displayName').value.trim() || '我';
  const settings = getSettingsFromForm();
  saveLocalSettings(settings);
  setBusy($('createInviteBtn'), true, '建立中...');

  try {
    const data = await api('createInvite', { label, settings });
    session = normalizeSessionSettings(data.session);
    saveSession(session);

    const url = new URL(location.origin + location.pathname);
    url.searchParams.set('invite', data.inviteToken);
    inviteLink.value = url.toString();
    invitePanel.classList.remove('hidden');

    setStatus(`邀請已建立，${formatSeconds(data.inviteTtlSeconds || settings.inviteTtlSeconds)} 內有效。`);
  } catch (err) {
    setStatus(err.message || '建立邀請失敗');
  } finally {
    setBusy($('createInviteBtn'), false, '建立專屬對話');
  }
}

async function acceptInvite() {
  const inviteToken = new URL(location.href).searchParams.get('invite');
  const label = $('guestName').value.trim() || '我';

  if (!inviteToken) {
    setStatus('找不到邀請碼。');
    return;
  }

  setBusy($('acceptInviteBtn'), true, '加入中...');

  try {
    const data = await api('acceptInvite', { inviteToken, label });
    session = normalizeSessionSettings(data.session);
    saveSession(session);

    history.replaceState({}, '', location.origin + location.pathname);
    enterChat();
    addMessage('system', '系統', '你已加入這個專屬臨時對話。');
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
    setStatus(data.ok ? '後端正常。' : (data.error || '後端異常。'));
  } catch (err) {
    setStatus(err.message || '後端測試失敗');
  } finally {
    setBusy($('healthBtn'), false, '測試後端');
  }
}

function enterChat() {
  if (!session || !session.myChannel || !session.peerChannel) {
    showSetupView();
    return;
  }

  session = normalizeSessionSettings(session);
  saveSession(session);

  setupView.classList.add('hidden');
  acceptView.classList.add('hidden');
  chatView.classList.remove('hidden');

  const settings = getActiveSettings();
  $('chatTitle').textContent = session.role === 'creator' ? '對話已建立' : '已加入對話';
  const friendName = findFriendNameBySession(session);
  $('chatSub').textContent = `${friendName ? '常用：' + friendName + '｜' : ''}你的顯示名稱：${session.label || '我'}｜畫面 ${settings.displaySeconds} 秒消失｜未讀 ${settings.messageTtlSeconds} 秒過期`;

  setStatus('對話啟用中。');
  startPolling();
  maybeShowInstallBox();
  messageInput.focus();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollMessages, POLL_INTERVAL_MS);
  pollMessages();
}

async function pollMessages() {
  if (!session || !session.myChannel) return;

  try {
    const data = await api('pollMessages', { myChannel: session.myChannel });
    const messages = Array.isArray(data.messages) ? data.messages : [];

    messages.forEach((m) => {
      addMessage(m.system ? 'system' : 'other', m.sender || '對方', m.text || '');
    });
  } catch (err) {
    setStatus(err.message || '接收失敗');
  }
}

async function sendMessage() {
  if (!session || !session.peerChannel) {
    setStatus('尚未建立對話。');
    return;
  }

  const text = messageInput.value.trim();
  if (!text) return;

  const settings = getActiveSettings();

  messageInput.value = '';
  addMessage('mine', '我', text);

  try {
    await api('sendMessage', {
      peerChannel: session.peerChannel,
      sender: session.label || '我',
      text,
      messageTtlSeconds: settings.messageTtlSeconds
    });
    setStatus('已送出。');
  } catch (err) {
    setStatus(err.message || '發送失敗');
    addMessage('system', '系統', '剛剛那則可能沒有送出去。');
  }
}

function addMessage(type, sender, text) {
  const div = document.createElement('div');
  div.className = `msg ${type === 'mine' ? 'mine' : ''} ${type === 'system' ? 'system' : ''}`.trim();

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

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'msg-delete';
  deleteBtn.textContent = '立即刪';
  deleteBtn.title = '立即從畫面刪除';
  deleteBtn.setAttribute('aria-label', '立即從畫面刪除這則訊息');
  div.appendChild(deleteBtn);

  const settings = getActiveSettings();
  const lifetimeMs = settings.displaySeconds * 1000;
  div.style.setProperty('--vanish-ms', `${lifetimeMs}ms`);

  const timer = setTimeout(() => div.remove(), lifetimeMs);
  deleteBtn.addEventListener('click', () => {
    clearTimeout(timer);
    div.remove();
  });

  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function clearVisibleMessages() {
  chatBox.replaceChildren();
  setStatus('畫面已立即清空。已讀到的訊息後端快取也已在讀取時刪除。');
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
    setStatus('邀請連結已複製。');
  } catch (err) {
    inviteLink.focus();
    inviteLink.select();
    document.execCommand('copy');
    setStatus('邀請連結已選取，可手動複製。');
  }
}


function loadFriends() {
  try {
    const raw = localStorage.getItem(FRIENDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item) => item && item.session && item.session.myChannel && item.session.peerChannel)
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
  if (!session || !session.myChannel || !session.peerChannel) {
    setStatus('尚未建立可儲存的對話。');
    return;
  }

  const existingName = findFriendNameBySession(session) || session.peerLabel || '常用對話';
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

  if (existingIndex >= 0) {
    friends.splice(existingIndex, 1);
  }

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
  history.replaceState({}, '', location.origin + location.pathname);
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

function resetSession() {
  if (!confirm('確定要清除本機對話設定？清除後需要重新建立邀請。')) return;
  localStorage.removeItem(SESSION_KEY);
  session = null;
  if (pollTimer) clearInterval(pollTimer);
  history.replaceState({}, '', location.origin + location.pathname);
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
    if (!parsed || !parsed.myChannel || !parsed.peerChannel) return null;
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
  $('messageTtlSeconds').value = value.messageTtlSeconds;
  $('inviteTtlSeconds').value = value.inviteTtlSeconds;
}

function getSettingsFromForm() {
  return sanitizeSettings({
    displaySeconds: $('displaySeconds').value,
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
    settings: sanitizeSettings(value.settings || loadLocalSettings())
  };
}

function sanitizeSettings(value) {
  const source = value || {};
  return {
    displaySeconds: clampNumber(source.displaySeconds, DEFAULT_SETTINGS.displaySeconds, LIMITS.displaySeconds.min, LIMITS.displaySeconds.max),
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
