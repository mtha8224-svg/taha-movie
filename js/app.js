/**
 * app.js — wires up the UI, drives the wizard, and syncs playback over the
 * PeerJS data channel created in peer.js.
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion

  const state = {
    isHost: false,
    displayName: '',
    roomCode: null,
    joinCodeDraft: null,
    videoUrl: '',
    subtitleMode: 'none',
    subtitleSourceUrl: '',
    pauseOnBuffer: true,
    bothControl: true,
    micEnabled: false,
    localReady: false,
    remoteReady: false,
    remoteName: 'همراه',
    peerConnected: false,
    applyingRemote: false,
    remoteBuffering: false,
    hls: null,
    localStream: null,
  };

  const roomPeer = new RoomPeer();

  // ---------------------------------------------------------------- utils
  function showView(id) {
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    $(id).classList.add('active');
    window.scrollTo(0, 0);
  }

  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function genRoomCode(len = 8) {
    let out = '';
    for (let i = 0; i < len; i++) out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return out;
  }

  function currentJoinLink(code) {
    const url = new URL(location.href);
    url.hash = '';
    url.search = '';
    url.searchParams.set('room', code);
    return url.toString();
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    }
  }

  // ------------------------------------------------------------ landing
  $('brandUrl').textContent = location.host || 'اجرای محلی';

  $('btn-open-join').addEventListener('click', () => showView('view-join'));
  $('btn-open-create').addEventListener('click', () => {
    state.isHost = true;
    $('nameStepLabel').textContent = 'مرحله ۱ از ۲';
    showView('view-name');
  });

  // ------------------------------------------------------------ join code
  $('joinBackBtn').addEventListener('click', () => showView('view-landing'));
  $('joinContinueBtn').addEventListener('click', () => {
    const code = $('joinCodeInput').value.trim().toUpperCase();
    if (!code) {
      $('joinCodeError').textContent = 'کد اتاق را وارد کن.';
      return;
    }
    $('joinCodeError').textContent = '';
    state.isHost = false;
    state.joinCodeDraft = code;
    $('nameStepLabel').textContent = 'نامت را وارد کن';
    showView('view-name');
  });

  // ------------------------------------------------------------ name step
  (function prefillName() {
    const saved = localStorage.getItem('fm_display_name');
    if (saved) {
      $('displayNameInput').value = saved;
      $('saveNameCheckbox').checked = true;
    }
  })();

  $('nameBackBtn').addEventListener('click', () => {
    showView(state.isHost ? 'view-landing' : 'view-join');
  });

  $('nameContinueBtn').addEventListener('click', () => {
    const name = $('displayNameInput').value.trim() || 'مهمان';
    state.displayName = name;
    if ($('saveNameCheckbox').checked) localStorage.setItem('fm_display_name', name);
    else localStorage.removeItem('fm_display_name');

    if (state.isHost) {
      showView('view-setup');
    } else {
      connectAsGuest(state.joinCodeDraft);
    }
  });

  // ------------------------------------------------------------ setup step (host)
  document.querySelectorAll('#subtitleModeGroup input[name=subtitleMode]').forEach((r) => {
    r.addEventListener('change', () => {
      state.subtitleMode = r.value;
      $('subtitleUploadRow').classList.toggle('hidden', r.value !== 'upload');
      $('subtitleLinkRow').classList.toggle('hidden', r.value !== 'link');
    });
  });

  $('setupBackBtn').addEventListener('click', () => showView('view-name'));

  $('createRoomSubmitBtn').addEventListener('click', async () => {
    const url = $('videoUrlInput').value.trim();
    if (!url) {
      toast('یک لینک مستقیم ویدیو وارد کن.');
      return;
    }
    state.videoUrl = url;
    state.pauseOnBuffer = $('pauseOnBufferCheckbox').checked;
    state.bothControl = $('bothControlCheckbox').checked;

    if (state.subtitleMode === 'link') {
      state.subtitleSourceUrl = $('subtitleLinkInput').value.trim();
    } else if (state.subtitleMode === 'upload') {
      const file = $('subtitleFileInput').files[0];
      if (file) {
        const text = await file.text();
        state.subtitleBlobUrl = subtitleTextToBlobUrl(text);
      }
    }

    $('createRoomSubmitBtn').disabled = true;
    $('createRoomSubmitBtn').textContent = 'در حال ساخت...';
    createRoom();
  });

  async function createRoom(attempt = 0) {
    const code = genRoomCode();
    try {
      await roomPeer.hostRoom(code);
      state.roomCode = code;
      bindPeerEvents();
      enterLobby();
    } catch (err) {
      if (attempt < 3) {
        createRoom(attempt + 1); // code collision - retry with a new one
      } else {
        toast('ساخت اتاق ناموفق بود. اتصال اینترنت را بررسی کن.');
        $('createRoomSubmitBtn').disabled = false;
        $('createRoomSubmitBtn').textContent = 'ساخت اتاق';
      }
    }
  }

  async function connectAsGuest(code) {
    showView('view-lobby');
    $('lobbyWaitTitle').textContent = 'در حال اتصال به اتاق...';
    $('hostSettingsCard').classList.add('hidden');
    try {
      await roomPeer.joinRoom(code);
      state.roomCode = code;
      bindPeerEvents();
      renderLobby();
    } catch (err) {
      toast('اتصال به این کد ممکن نشد. کد را بررسی کن.');
      showView('view-join');
    }
  }

  // ------------------------------------------------------------ peer / sync events
  function bindPeerEvents() {
    roomPeer.onPeerConnected = () => {
      state.peerConnected = true;
      if (state.isHost) {
        roomPeer.send('meta', {
          videoUrl: state.videoUrl,
          subtitleMode: state.subtitleMode,
          subtitleSourceUrl: state.subtitleSourceUrl || '',
        });
      }
      roomPeer.send('name', { name: state.displayName });
      renderLobby();
      updateRoomPeerLabels();
    };

    roomPeer.onPeerDisconnected = () => {
      state.peerConnected = false;
      state.remoteReady = false;
      toast('ارتباط با همراه قطع شد.');
      renderLobby();
      updateRoomPeerLabels();
      $('syncBadge').textContent = 'قطع شده';
      $('syncBadge').classList.add('offline');
    };

    roomPeer.onRemoteStream = (stream) => {
      $('remoteAudio').srcObject = stream;
    };

    roomPeer.onMessage = (type, payload) => handleMessage(type, payload);
  }

  function handleMessage(type, payload) {
    switch (type) {
      case 'meta':
        state.videoUrl = payload.videoUrl;
        state.subtitleMode = payload.subtitleMode;
        state.subtitleSourceUrl = payload.subtitleSourceUrl;
        renderLobby();
        break;
      case 'name':
        state.remoteName = payload.name || 'همراه';
        updateRoomPeerLabels();
        break;
      case 'ready':
        state.remoteReady = !!payload.ready;
        renderLobby();
        maybeEnterRoom();
        break;
      case 'play':
        applyRemote(() => {
          const v = $('player');
          v.currentTime = payload.time;
          v.play().catch(() => {});
        });
        break;
      case 'pause':
        applyRemote(() => {
          const v = $('player');
          v.currentTime = payload.time;
          v.pause();
        });
        break;
      case 'seek':
        applyRemote(() => { $('player').currentTime = payload.time; });
        break;
      case 'buffering':
        state.remoteBuffering = payload.buffering;
        if (payload.buffering) {
          applyRemote(() => $('player').pause());
        } else {
          applyRemote(() => $('player').play().catch(() => {}));
        }
        break;
      case 'chat':
        appendChatMessage(payload.name, payload.text, false);
        break;
      case 'settings-update':
        if (payload.videoUrl) loadVideoSource(payload.videoUrl);
        if (payload.subtitleSourceUrl) applySubtitleFromUrl(payload.subtitleSourceUrl);
        toast('میزبان تنظیمات را تغییر داد.');
        break;
      case 'end-room':
        toast('میزبان اتاق را پایان داد.');
        leaveToLanding();
        break;
    }
  }

  function applyRemote(fn) {
    state.applyingRemote = true;
    fn();
    setTimeout(() => { state.applyingRemote = false; }, 350);
  }

  // ------------------------------------------------------------ lobby
  function renderLobby() {
    $('lobbyWaitTitle').textContent = state.peerConnected
      ? 'همراه متصل شد — وقتی آماده بودی دکمه پایین را بزن'
      : 'منتظر ورود همراه هستیم...';

    $('roomCodeDisplay').textContent = state.roomCode || '--------';
    $('roomLinkDisplay').value = state.roomCode ? currentJoinLink(state.roomCode) : '';

    $('statConn').textContent = state.peerConnected ? 'اتصال برقرار است' : 'در انتظار اتصال';
    $('statSub').textContent = state.subtitleMode === 'none' ? 'بدون زیرنویس' : 'زیرنویس فعال';
    $('statMovie').textContent = state.videoUrl ? 'فیلم انتخاب شده' : 'انتخاب نشده';
    $('statPeer').textContent = state.peerConnected
      ? (state.remoteReady ? `${state.remoteName} · آماده` : `${state.remoteName} · آنلاین`)
      : 'آفلاین · در انتظار ورود';
    $('peerRoleLabel').textContent = state.isHost ? 'مهمان' : 'میزبان';

    $('hostSettingsCard').classList.toggle('hidden', !state.isHost);
    if (state.isHost) $('lobbyVideoUrlInput').value = state.videoUrl;

    // QR + link only make sense once we actually have a room code
    if (state.roomCode) {
      $('qrcodeBox').innerHTML = '';
      // eslint-disable-next-line no-undef
      new QRCode($('qrcodeBox'), {
        text: currentJoinLink(state.roomCode),
        width: 140,
        height: 140,
        colorDark: '#0a0e17',
        colorLight: '#ffffff',
      });
    }

    showView('view-lobby');
  }

  $('copyCodeBtn').addEventListener('click', async () => {
    await copyToClipboard(state.roomCode || '');
    toast('کد کپی شد.');
  });
  $('copyLinkBtn').addEventListener('click', async () => {
    await copyToClipboard($('roomLinkDisplay').value);
    toast('لینک کپی شد.');
  });
  $('shareBtn').addEventListener('click', async () => {
    const link = $('roomLinkDisplay').value;
    if (navigator.share) {
      try { await navigator.share({ title: 'تماشای دونفره', url: link }); } catch {}
    } else {
      await copyToClipboard(link);
      toast('لینک کپی شد (اشتراک‌گذاری مستقیم پشتیبانی نمی‌شود).');
    }
  });

  $('readyBtn').addEventListener('click', () => {
    state.localReady = true;
    $('readyBtn').textContent = 'آماده‌ای';
    $('readyBtn').disabled = true;
    roomPeer.send('ready', { ready: true });
    maybeEnterRoom();
  });

  function maybeEnterRoom() {
    if (state.localReady && state.remoteReady) {
      enterRoom();
    }
  }

  function enterLobby() {
    renderLobby();
  }

  // host: change video / subtitle from lobby
  $('changeVideoBtn').addEventListener('click', () => {
    const url = prompt('لینک جدید ویدیو را وارد کن:', state.videoUrl);
    if (url) {
      state.videoUrl = url;
      $('lobbyVideoUrlInput').value = url;
      roomPeer.send('settings-update', { videoUrl: url });
      toast('لینک ویدیو به‌روزرسانی شد.');
    }
  });
  $('changeSubtitleBtn').addEventListener('click', () => {
    const url = $('lobbySubtitleUrlInput').value.trim();
    if (url) {
      state.subtitleMode = 'link';
      state.subtitleSourceUrl = url;
      roomPeer.send('settings-update', { subtitleSourceUrl: url });
      toast('لینک زیرنویس به‌روزرسانی شد.');
    }
  });
  $('endRoomBtn').addEventListener('click', () => {
    roomPeer.send('end-room', {});
    leaveToLanding();
  });

  // mic toggle (lobby)
  $('micToggleBtn').addEventListener('click', () => toggleMic('micToggleBtn', 'micStatusLabel'));

  async function toggleMic(btnId, labelId) {
    if (!state.micEnabled) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        state.localStream = stream;
        state.micEnabled = true;
        roomPeer.startMic(stream);
        $(btnId).textContent = 'خاموش‌کردن میکروفون';
        if ($(labelId)) $(labelId).textContent = 'میکروفون شما روشن است';
        syncMicButtons(true);
      } catch {
        toast('اجازه دسترسی به میکروفون داده نشد.');
      }
    } else {
      if (state.localStream) state.localStream.getTracks().forEach((t) => t.stop());
      roomPeer.stopMic();
      state.micEnabled = false;
      $(btnId).textContent = 'فعال‌کردن میکروفون';
      if ($(labelId)) $(labelId).textContent = 'میکروفون خاموش';
      syncMicButtons(false);
    }
  }

  function syncMicButtons(on) {
    $('micToggleBtn').textContent = on ? 'خاموش‌کردن میکروفون' : 'فعال‌کردن میکروفون';
    $('micStatusLabel').textContent = on ? 'میکروفون شما روشن است' : 'میکروفون خاموش';
    $('micRoomToggleBtn').classList.toggle('active', on);
  }

  function leaveToLanding() {
    roomPeer.destroy();
    location.reload();
  }

  // ------------------------------------------------------------ room / player
  function loadVideoSource(url) {
    const video = $('player');
    if (state.hls) { state.hls.destroy(); state.hls = null; }

    if (url.includes('.m3u8')) {
      if (window.Hls && Hls.isSupported()) {
        state.hls = new Hls();
        state.hls.loadSource(url);
        state.hls.attachMedia(video);
      } else {
        video.src = url; // native HLS (Safari)
      }
    } else {
      video.src = url;
    }
    $('settingsVideoUrl').textContent = url;
  }

  function applySubtitleFromUrl(url) {
    subtitleUrlToBlobUrl(url).then(attachSubtitleBlob).catch(() => toast('دریافت زیرنویس ناموفق بود.'));
  }

  function attachSubtitleBlob(blobUrl) {
    const video = $('player');
    Array.from(video.querySelectorAll('track')).forEach((t) => t.remove());
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = 'زیرنویس';
    track.srclang = 'fa';
    track.src = blobUrl;
    track.default = true;
    video.appendChild(track);
    setTimeout(() => {
      if (video.textTracks[0]) video.textTracks[0].mode = 'showing';
    }, 200);
  }

  function enterRoom() {
    showView('view-room');
    loadVideoSource(state.videoUrl);

    if (state.subtitleMode === 'link' && state.subtitleSourceUrl) {
      applySubtitleFromUrl(state.subtitleSourceUrl);
    } else if (state.subtitleMode === 'upload' && state.subtitleBlobUrl) {
      attachSubtitleBlob(state.subtitleBlobUrl);
    }

    $('settingsVideoUrl').textContent = state.videoUrl;
    $('hostVideoUpdateRow').classList.toggle('hidden', !state.isHost);
    updateRoomPeerLabels();
  }

  function updateRoomPeerLabels() {
    $('roomPeerState').textContent = state.peerConnected
      ? `${state.remoteName} متصل است`
      : 'در انتظار اتصال';
    $('syncBadge').textContent = state.peerConnected ? 'همگام' : 'قطع شده';
    $('syncBadge').classList.toggle('offline', !state.peerConnected);
  }

  const player = $('player');

  function canControl() {
    return state.isHost || state.bothControl;
  }

  player.addEventListener('play', () => {
    $('playPauseBtn').innerHTML = '<i class="ti ti-player-pause"></i>';
    $('roomPlayState').textContent = 'در حال پخش';
    if (!state.applyingRemote && canControl()) roomPeer.send('play', { time: player.currentTime });
  });
  player.addEventListener('pause', () => {
    $('playPauseBtn').innerHTML = '<i class="ti ti-player-play"></i>';
    $('roomPlayState').textContent = 'متوقف شده';
    if (!state.applyingRemote && canControl()) roomPeer.send('pause', { time: player.currentTime });
  });
  player.addEventListener('seeked', () => {
    if (!state.applyingRemote && canControl()) roomPeer.send('seek', { time: player.currentTime });
  });
  player.addEventListener('waiting', () => {
    if (state.pauseOnBuffer) roomPeer.send('buffering', { buffering: true });
  });
  player.addEventListener('playing', () => {
    if (state.pauseOnBuffer) roomPeer.send('buffering', { buffering: false });
  });

  $('playPauseBtn').addEventListener('click', () => {
    if (player.paused) player.play().catch(() => {});
    else player.pause();
  });
  $('skipBackBtn').addEventListener('click', () => { player.currentTime = Math.max(0, player.currentTime - 10); });
  $('skipFwdBtn').addEventListener('click', () => { player.currentTime += 10; });
  $('videoVolume').addEventListener('input', (e) => { player.volume = Number(e.target.value); });
  $('speedSelect').addEventListener('change', (e) => { player.playbackRate = Number(e.target.value); });
  $('subtitleToggleBtn').addEventListener('click', () => {
    const t = player.textTracks[0];
    if (!t) { toast('زیرنویسی اضافه نشده.'); return; }
    t.mode = t.mode === 'showing' ? 'hidden' : 'showing';
    $('subtitleToggleBtn').classList.toggle('active', t.mode === 'showing');
  });

  $('pipBtn').addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await player.requestPictureInPicture();
    } catch { toast('حالت تصویر‌در‌تصویر پشتیبانی نمی‌شود.'); }
  });
  $('fullscreenBtn').addEventListener('click', () => {
    const wrap = document.querySelector('.video-wrap');
    if (document.fullscreenElement) document.exitFullscreen();
    else wrap.requestFullscreen();
  });
  $('remoteVolume').addEventListener('input', (e) => { $('remoteAudio').volume = Number(e.target.value); });
  $('micRoomToggleBtn').addEventListener('click', () => toggleMic('micRoomToggleBtn', null));

  // tabs
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      $(btn.dataset.tab).classList.add('active');
    });
  });

  // chat — renders into both the "گفتگو" tab AND the overlay that floats on top
  // of the video, so messages are visible (and answerable) even in fullscreen,
  // portrait or landscape.
  function appendChatMessage(name, text, isMe) {
    [{ log: $('chatLog'), cls: 'chat-msg' }, { log: $('overlayChatLog'), cls: 'overlay-chat-msg' }]
      .forEach(({ log, cls }) => {
        const div = document.createElement('div');
        div.className = cls + (isMe ? ' me' : '');
        div.innerHTML = `<span class="who">${escapeHtml(name)}</span>${escapeHtml(text)}`;
        log.appendChild(div);
        log.scrollTop = log.scrollHeight;
      });

    // an incoming reply should be visible even if the overlay chat is closed
    if (!isMe) $('overlayChat').classList.add('open');
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function sendChatFrom(inputEl) {
    const text = inputEl.value.trim();
    if (!text) return;
    roomPeer.send('chat', { name: state.displayName, text });
    appendChatMessage(state.displayName, text, true);
    inputEl.value = '';
  }

  $('chatSendBtn').addEventListener('click', () => sendChatFrom($('chatInput')));
  $('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChatFrom($('chatInput')); });

  $('overlayChatSendBtn').addEventListener('click', () => sendChatFrom($('overlayChatInput')));
  $('overlayChatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChatFrom($('overlayChatInput')); });
  $('overlayChatToggle').addEventListener('click', () => $('overlayChat').classList.toggle('open'));

  // settings tab
  $('applySubtitleBtn').addEventListener('click', () => {
    const url = $('roomSubtitleLinkInput').value.trim();
    if (!url) return;
    applySubtitleFromUrl(url);
    if (state.isHost) roomPeer.send('settings-update', { subtitleSourceUrl: url });
  });
  $('subtitleShowCheckbox').addEventListener('change', (e) => {
    const t = player.textTracks[0];
    if (t) t.mode = e.target.checked ? 'showing' : 'hidden';
  });
  $('settingsUpdateVideoBtn').addEventListener('click', () => {
    const url = $('settingsNewVideoUrl').value.trim();
    if (!url) return;
    state.videoUrl = url;
    loadVideoSource(url);
    roomPeer.send('settings-update', { videoUrl: url });
    toast('ویدیو به‌روزرسانی شد.');
  });
  $('leaveRoomBtn').addEventListener('click', () => {
    if (state.isHost) roomPeer.send('end-room', {});
    leaveToLanding();
  });

  // ------------------------------------------------------------ deep link join (?room=CODE)
  (function autoJoinFromLink() {
    const params = new URLSearchParams(location.search);
    const room = params.get('room');
    if (room) {
      $('joinCodeInput').value = room.toUpperCase();
      showView('view-join');
    }
  })();
})();
