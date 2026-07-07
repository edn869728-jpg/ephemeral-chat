/*
 * 私・話｜語音通話試用模組 v1
 * 載入順序：app.js 後面再載入本檔。
 * 只新增 WebRTC 語音與短暫 signaling，不改原本訊息流程。
 */
(() => {
  'use strict';

  const VERSION = 'voice-call-test-v1';
  const SIGNAL_POLL_MS = 1100;
  const RING_TIMEOUT_MS = 30000;
  const OFFER_WAIT_MS = 10000;
  const DISCONNECT_GRACE_MS = 7000;

  const RTC_CONFIG = {
    iceServers: [
      { urls: ['stun:stun.cloudflare.com:3478'] }
    ],
    iceCandidatePoolSize: 4
  };

  let pc = null;
  let localStream = null;
  let remoteStream = null;
  let callId = '';
  let direction = '';
  let callState = 'idle';
  let incomingOffer = null;
  let pendingIce = [];
  let pollTimer = null;
  let polling = false;
  let ringTimer = null;
  let disconnectTimer = null;
  let callStartedAt = 0;
  let durationTimer = null;
  let micMuted = false;
  let remoteMuted = false;
  let endingLocally = false;

  const ui = {};

  function currentSession() {
    try {
      return typeof session !== 'undefined' ? session : null;
    } catch (_) {
      return null;
    }
  }

  function isChatVisible() {
    const chat = document.getElementById('chatView');
    return Boolean(chat && !chat.classList.contains('hidden'));
  }

  async function postApi(action, payload) {
    if (typeof api !== 'function') {
      throw new Error('找不到原本的 API 函式，請確認 call-addon.js 放在 app.js 後面。');
    }
    return api(action, payload);
  }

  function status(text) {
    try {
      if (typeof setStatus === 'function') setStatus(text);
    } catch (_) {}
    if (ui.status) ui.status.textContent = text || '';
  }

  function peerDisplayName() {
    const s = currentSession();
    if (!s) return '對方';
    try {
      if (typeof findFriendNameBySession === 'function') {
        const name = findFriendNameBySession(s);
        if (name) return name;
      }
    } catch (_) {}
    return '對方';
  }

  function myDisplayName() {
    const s = currentSession();
    return (s && String(s.label || '').trim()) || '對話中的人';
  }

  function makeId() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  function installStyles() {
    if (document.getElementById('voiceCallAddonStyles')) return;
    const style = document.createElement('style');
    style.id = 'voiceCallAddonStyles';
    style.textContent = `
      .voice-call-btn { background:#e8f7ee !important; color:#147a3d !important; }
      .voice-call-btn.busy { background:#fff3e8 !important; color:#b84a00 !important; }
      .call-overlay { position:fixed; inset:0; z-index:99999; display:flex; align-items:center; justify-content:center; padding:max(18px, env(safe-area-inset-top)) 18px max(18px, env(safe-area-inset-bottom)); background:rgba(2,10,25,.78); backdrop-filter:blur(18px); }
      .call-overlay.hidden { display:none !important; }
      .call-panel { width:min(100%,390px); border-radius:30px; padding:24px 20px 20px; color:#fff; background:linear-gradient(160deg,#061633 0%,#0b2a5b 58%,#1a2038 100%); border:1px solid rgba(255,255,255,.18); box-shadow:0 28px 90px rgba(0,0,0,.52); text-align:center; }
      .call-avatar { width:88px; height:88px; margin:0 auto 14px; border-radius:50%; display:grid; place-items:center; font-size:38px; background:radial-gradient(circle at 35% 25%,#ffb56f,#d95f00 54%,#7b2d00 100%); box-shadow:0 14px 34px rgba(217,95,0,.36); }
      .call-kicker { margin:0 0 5px; color:rgba(255,255,255,.62); font-size:12px; font-weight:900; letter-spacing:.08em; }
      .call-name { margin:0; font-size:28px; line-height:1.12; }
      .call-status { min-height:24px; margin:9px 0 0; color:rgba(255,255,255,.82); font-size:14px; }
      .call-duration { min-height:24px; margin:3px 0 16px; font-variant-numeric:tabular-nums; font-weight:900; color:#ffca99; }
      .call-controls { display:flex; justify-content:center; gap:12px; flex-wrap:wrap; margin-top:10px; }
      .call-round { width:68px; height:68px; border:0; border-radius:50%; display:grid; place-items:center; font-size:13px; font-weight:950; cursor:pointer; color:#fff; background:rgba(255,255,255,.14); border:1px solid rgba(255,255,255,.16); }
      .call-round strong { display:block; font-size:23px; line-height:1; margin-bottom:3px; }
      .call-round.accept { background:#16a34a; }
      .call-round.reject, .call-round.hangup { background:#dc2626; }
      .call-round.active { background:#fff; color:#0b2a5b; }
      .call-note { margin:16px 6px 0; color:rgba(255,255,255,.56); font-size:11px; line-height:1.5; }
      .call-incoming-actions.hidden, .call-active-actions.hidden { display:none !important; }
      @media (max-width:420px) {
        .call-panel { border-radius:26px; }
        .call-round { width:64px; height:64px; }
      }
    `;
    document.head.appendChild(style);
  }

  function installUi() {
    installStyles();

    const headerActions = document.querySelector('#chatView .header-actions');
    if (headerActions && !document.getElementById('voiceCallBtn')) {
      const button = document.createElement('button');
      button.id = 'voiceCallBtn';
      button.type = 'button';
      button.className = 'icon-btn voice-call-btn';
      button.title = '語音通話';
      button.textContent = '☎ 語音';
      button.addEventListener('click', startOutgoingCall);
      headerActions.prepend(button);
      ui.callButton = button;
    } else {
      ui.callButton = document.getElementById('voiceCallBtn');
    }

    if (!document.getElementById('voiceCallOverlay')) {
      const overlay = document.createElement('div');
      overlay.id = 'voiceCallOverlay';
      overlay.className = 'call-overlay hidden';
      overlay.innerHTML = `
        <section class="call-panel" role="dialog" aria-modal="true" aria-labelledby="voiceCallName">
          <audio id="voiceCallRemoteAudio" autoplay playsinline></audio>
          <div class="call-avatar" aria-hidden="true">☎</div>
          <p class="call-kicker">私・話語音</p>
          <h2 id="voiceCallName" class="call-name">對方</h2>
          <p id="voiceCallStatus" class="call-status">準備中</p>
          <div id="voiceCallDuration" class="call-duration"></div>

          <div id="voiceIncomingActions" class="call-controls call-incoming-actions hidden">
            <button id="voiceRejectBtn" class="call-round reject" type="button"><span><strong>✕</strong>拒絕</span></button>
            <button id="voiceAcceptBtn" class="call-round accept" type="button"><span><strong>✓</strong>接聽</span></button>
          </div>

          <div id="voiceActiveActions" class="call-controls call-active-actions hidden">
            <button id="voiceMuteBtn" class="call-round" type="button"><span><strong>🎙</strong>靜音</span></button>
            <button id="voiceSoundBtn" class="call-round" type="button"><span><strong>🔊</strong>聲音</span></button>
            <button id="voiceHangupBtn" class="call-round hangup" type="button"><span><strong>✕</strong>掛斷</span></button>
          </div>

          <p class="call-note">試用版只在雙方 App 開啟時穩定響鈴；第一次使用會詢問麥克風權限。</p>
        </section>
      `;
      document.body.appendChild(overlay);
    }

    ui.overlay = document.getElementById('voiceCallOverlay');
    ui.name = document.getElementById('voiceCallName');
    ui.status = document.getElementById('voiceCallStatus');
    ui.duration = document.getElementById('voiceCallDuration');
    ui.remoteAudio = document.getElementById('voiceCallRemoteAudio');
    ui.incomingActions = document.getElementById('voiceIncomingActions');
    ui.activeActions = document.getElementById('voiceActiveActions');
    ui.acceptBtn = document.getElementById('voiceAcceptBtn');
    ui.rejectBtn = document.getElementById('voiceRejectBtn');
    ui.muteBtn = document.getElementById('voiceMuteBtn');
    ui.soundBtn = document.getElementById('voiceSoundBtn');
    ui.hangupBtn = document.getElementById('voiceHangupBtn');

    if (ui.acceptBtn && !ui.acceptBtn.dataset.bound) {
      ui.acceptBtn.dataset.bound = '1';
      ui.acceptBtn.addEventListener('click', acceptIncomingCall);
      ui.rejectBtn.addEventListener('click', rejectIncomingCall);
      ui.muteBtn.addEventListener('click', toggleMic);
      ui.soundBtn.addEventListener('click', toggleRemoteSound);
      ui.hangupBtn.addEventListener('click', () => endCall('你已掛斷', true));
    }
  }

  function showOverlay(mode, message) {
    installUi();
    ui.overlay.classList.remove('hidden');
    ui.name.textContent = peerDisplayName();
    ui.duration.textContent = '';
    ui.status.textContent = message || '';
    ui.incomingActions.classList.toggle('hidden', mode !== 'incoming');
    ui.activeActions.classList.toggle('hidden', mode === 'incoming');
    if (ui.callButton) ui.callButton.classList.add('busy');
  }

  function hideOverlay() {
    if (ui.overlay) ui.overlay.classList.add('hidden');
    if (ui.callButton) ui.callButton.classList.remove('busy');
  }

  function updateDuration() {
    if (!ui.duration || !callStartedAt) return;
    const total = Math.max(0, Math.floor((Date.now() - callStartedAt) / 1000));
    const min = String(Math.floor(total / 60)).padStart(2, '0');
    const sec = String(total % 60).padStart(2, '0');
    ui.duration.textContent = `${min}:${sec}`;
  }

  function startDuration() {
    callStartedAt = Date.now();
    updateDuration();
    clearInterval(durationTimer);
    durationTimer = setInterval(updateDuration, 1000);
  }

  async function getMicrophone() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('這個瀏覽器不支援麥克風通話。');
    }
    if (localStream) return localStream;
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });
    return localStream;
  }

  async function buildPeerConnection() {
    if (pc) return pc;
    pc = new RTCPeerConnection(RTC_CONFIG);
    remoteStream = new MediaStream();
    if (ui.remoteAudio) ui.remoteAudio.srcObject = remoteStream;

    pc.onicecandidate = (event) => {
      if (!event.candidate || !callId) return;
      sendSignal('ice', { candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate }).catch(() => {});
    };

    pc.ontrack = (event) => {
      const streams = event.streams || [];
      if (streams[0]) {
        ui.remoteAudio.srcObject = streams[0];
      } else if (event.track) {
        remoteStream.addTrack(event.track);
        ui.remoteAudio.srcObject = remoteStream;
      }
      ui.remoteAudio.muted = remoteMuted;
      const play = ui.remoteAudio.play();
      if (play && typeof play.catch === 'function') play.catch(() => {});
    };

    pc.onconnectionstatechange = () => {
      if (!pc) return;
      const state = pc.connectionState;
      if (state === 'connected') {
        clearTimeout(disconnectTimer);
        callState = 'connected';
        showOverlay('active', '通話中');
        if (!callStartedAt) startDuration();
        status('語音通話已連線。');
      } else if (state === 'failed' || state === 'closed') {
        endCall('通話連線已結束', false);
      } else if (state === 'disconnected') {
        clearTimeout(disconnectTimer);
        disconnectTimer = setTimeout(() => {
          if (pc && pc.connectionState === 'disconnected') endCall('網路中斷，通話已結束', false);
        }, DISCONNECT_GRACE_MS);
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (!pc) return;
      if (pc.iceConnectionState === 'checking') ui.status.textContent = '正在建立安全連線…';
    };

    const stream = await getMicrophone();
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    return pc;
  }

  async function sendSignal(type, payload = {}) {
    const s = currentSession();
    if (!s || !s.peerChannel || !s.myChannel) throw new Error('尚未建立可通話的對話。');
    if (!callId) throw new Error('通話識別碼不存在。');

    return postApi('callPush', {
      myChannel: s.myChannel,
      peerChannel: s.peerChannel,
      event: {
        type,
        callId,
        fromLabel: myDisplayName(),
        payload,
        at: Date.now(),
        version: VERSION
      }
    });
  }

  async function startOutgoingCall() {
    if (callState !== 'idle') return;
    const s = currentSession();
    if (!s || !s.myChannel || !s.peerChannel) {
      status('尚未建立可通話的對話。');
      return;
    }
    if (!isChatVisible()) {
      status('請先進入聊天室再撥打。');
      return;
    }

    callId = makeId();
    direction = 'outgoing';
    callState = 'starting';
    endingLocally = false;
    showOverlay('active', `正在撥給 ${peerDisplayName()}…`);

    try {
      await buildPeerConnection();
      await sendSignal('ring', {});

      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      await sendSignal('offer', { description: pc.localDescription });

      callState = 'ringing';
      ui.status.textContent = '等待對方接聽…';
      status('語音來電已送出。');

      clearTimeout(ringTimer);
      ringTimer = setTimeout(async () => {
        if (callState === 'ringing' || callState === 'starting') {
          try { await sendSignal('cancel', {}); } catch (_) {}
          endCall('對方未接聽', false);
        }
      }, RING_TIMEOUT_MS);
    } catch (err) {
      endCall(err && err.message ? err.message : '無法開始語音通話', false);
    }
  }

  async function acceptIncomingCall() {
    if (callState !== 'incoming') return;
    callState = 'accepting';
    showOverlay('active', '正在接通…');

    try {
      await buildPeerConnection();
      const offer = await waitForIncomingOffer();
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      await flushPendingIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendSignal('answer', { description: pc.localDescription });
      ui.status.textContent = '正在建立安全連線…';
      status('已接聽，正在連線。');
    } catch (err) {
      try { await sendSignal('reject', { reason: 'connect_failed' }); } catch (_) {}
      endCall(err && err.message ? err.message : '接聽失敗', false);
    }
  }

  async function rejectIncomingCall() {
    if (callState !== 'incoming') return;
    try { await sendSignal('reject', {}); } catch (_) {}
    endCall('你已拒絕來電', false);
  }

  function waitForIncomingOffer() {
    if (incomingOffer) return Promise.resolve(incomingOffer);
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (incomingOffer) {
          clearInterval(timer);
          resolve(incomingOffer);
          return;
        }
        if (Date.now() - started >= OFFER_WAIT_MS || callState === 'idle') {
          clearInterval(timer);
          reject(new Error('沒有收到通話連線資料，請重新撥打。'));
        }
      }, 150);
    });
  }

  async function flushPendingIce() {
    if (!pc || !pc.remoteDescription) return;
    const list = pendingIce.splice(0);
    for (const candidate of list) {
      try { await pc.addIceCandidate(candidate); } catch (_) {}
    }
  }

  async function processSignalEnvelope(envelope) {
    const s = currentSession();
    if (!s || !envelope || envelope.fromChannel !== s.peerChannel) return;
    const event = envelope.event || {};
    const type = String(event.type || '');
    const incomingCallId = String(event.callId || '');
    if (!incomingCallId) return;

    if (type === 'ring') {
      if (callState !== 'idle') {
        const oldCallId = callId;
        callId = incomingCallId;
        try { await sendSignal('busy', {}); } catch (_) {}
        callId = oldCallId;
        return;
      }
      callId = incomingCallId;
      direction = 'incoming';
      callState = 'incoming';
      incomingOffer = null;
      pendingIce = [];
      endingLocally = false;
      showOverlay('incoming', '語音來電');
      vibrateIncoming();
      notifyIncomingCall();
      clearTimeout(ringTimer);
      ringTimer = setTimeout(() => {
        if (callState === 'incoming') endCall('未接來電', false);
      }, RING_TIMEOUT_MS + 5000);
      return;
    }

    if (incomingCallId !== callId) return;

    if (type === 'offer') {
      incomingOffer = event.payload && event.payload.description;
      return;
    }

    if (type === 'answer' && direction === 'outgoing' && pc) {
      clearTimeout(ringTimer);
      const answer = event.payload && event.payload.description;
      if (!answer) return;
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      await flushPendingIce();
      ui.status.textContent = '正在建立安全連線…';
      return;
    }

    if (type === 'ice') {
      const raw = event.payload && event.payload.candidate;
      if (!raw) return;
      const candidate = new RTCIceCandidate(raw);
      if (pc && pc.remoteDescription) {
        try { await pc.addIceCandidate(candidate); } catch (_) {}
      } else {
        pendingIce.push(candidate);
      }
      return;
    }

    if (type === 'reject') {
      endCall('對方拒絕了通話', false);
      return;
    }

    if (type === 'busy') {
      endCall('對方目前正在通話中', false);
      return;
    }

    if (type === 'cancel') {
      endCall('對方已取消來電', false);
      return;
    }

    if (type === 'end') {
      endCall('對方已掛斷', false);
    }
  }

  async function pollSignals() {
    if (polling) return;
    const s = currentSession();
    if (!s || !s.myChannel) return;
    polling = true;
    try {
      const data = await postApi('callPull', { myChannel: s.myChannel });
      const events = Array.isArray(data.events) ? data.events : [];
      for (const envelope of events) {
        try { await processSignalEnvelope(envelope); } catch (_) {}
      }
    } catch (_) {
      // 通話模組不能阻斷原本聊天室；輪詢失敗時靜默等待下一次。
    } finally {
      polling = false;
    }
  }

  function toggleMic() {
    micMuted = !micMuted;
    if (localStream) localStream.getAudioTracks().forEach((track) => { track.enabled = !micMuted; });
    if (ui.muteBtn) {
      ui.muteBtn.classList.toggle('active', micMuted);
      ui.muteBtn.innerHTML = micMuted
        ? '<span><strong>🔇</strong>已靜音</span>'
        : '<span><strong>🎙</strong>靜音</span>';
    }
  }

  function toggleRemoteSound() {
    remoteMuted = !remoteMuted;
    if (ui.remoteAudio) ui.remoteAudio.muted = remoteMuted;
    if (ui.soundBtn) {
      ui.soundBtn.classList.toggle('active', remoteMuted);
      ui.soundBtn.innerHTML = remoteMuted
        ? '<span><strong>🔈</strong>聲音關</span>'
        : '<span><strong>🔊</strong>聲音</span>';
    }
  }

  async function endCall(message, sendEnd) {
    if (callState === 'idle' && !pc && !localStream) return;
    const activeCallId = callId;
    const shouldSignal = Boolean(sendEnd && activeCallId && !endingLocally);
    endingLocally = true;

    if (shouldSignal) {
      try { await sendSignal('end', {}); } catch (_) {}
    }

    clearTimeout(ringTimer);
    clearTimeout(disconnectTimer);
    clearInterval(durationTimer);
    ringTimer = null;
    disconnectTimer = null;
    durationTimer = null;

    if (pc) {
      try { pc.onicecandidate = null; pc.ontrack = null; pc.close(); } catch (_) {}
    }
    pc = null;

    if (localStream) {
      try { localStream.getTracks().forEach((track) => track.stop()); } catch (_) {}
    }
    localStream = null;
    remoteStream = null;
    if (ui.remoteAudio) {
      try { ui.remoteAudio.pause(); } catch (_) {}
      ui.remoteAudio.srcObject = null;
      ui.remoteAudio.muted = false;
    }

    callId = '';
    direction = '';
    callState = 'idle';
    incomingOffer = null;
    pendingIce = [];
    callStartedAt = 0;
    micMuted = false;
    remoteMuted = false;

    if (ui.muteBtn) {
      ui.muteBtn.classList.remove('active');
      ui.muteBtn.innerHTML = '<span><strong>🎙</strong>靜音</span>';
    }
    if (ui.soundBtn) {
      ui.soundBtn.classList.remove('active');
      ui.soundBtn.innerHTML = '<span><strong>🔊</strong>聲音</span>';
    }

    if (message) status(message);
    setTimeout(hideOverlay, 650);
    setTimeout(() => { endingLocally = false; }, 800);
  }

  function vibrateIncoming() {
    try {
      if (navigator.vibrate) navigator.vibrate([220, 100, 220, 100, 360]);
    } catch (_) {}
  }

  async function notifyIncomingCall() {
    if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
    const payload = {
      body: '打開私・話以接聽。',
      icon: '/assets/icon-192.png',
      badge: '/assets/icon-192.png',
      tag: 'ephemeral-voice-call',
      renotify: true,
      data: { url: location.origin + location.pathname }
    };
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration && registration.showNotification) {
        await registration.showNotification('有人打語音給你', payload);
        return;
      }
    } catch (_) {}
    try { new Notification('有人打語音給你', payload); } catch (_) {}
  }

  function sendEndOnPageExit() {
    if (callState === 'idle' || !callId) return;
    const s = currentSession();
    if (!s || !s.myChannel || !s.peerChannel) return;
    try {
      fetch('/api/callPush', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          myChannel: s.myChannel,
          peerChannel: s.peerChannel,
          event: { type: 'end', callId, fromLabel: myDisplayName(), payload: {}, at: Date.now(), version: VERSION }
        }),
        cache: 'no-store',
        keepalive: true
      });
    } catch (_) {}
  }

  function boot() {
    installUi();
    clearInterval(pollTimer);
    pollTimer = setInterval(pollSignals, SIGNAL_POLL_MS);
    pollSignals();

    const observer = new MutationObserver(() => {
      installUi();
      if (ui.callButton) ui.callButton.disabled = !currentSession() || !isChatVisible();
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });

    window.addEventListener('pagehide', sendEndOnPageExit);
    window.addEventListener('beforeunload', sendEndOnPageExit);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
