'use strict';

// Campaign music has its own preference and volume, independent of battle sounds and alert chimes.
const CampaignMusic = (() => {
  const audio = new Audio('/assets/sounds/CWR1_Theme.mp3');
  audio.loop = true;
  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const save = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };
  const savedEnabled = read('woe.campaignMusic');
  let enabled = savedEnabled === null ? read('menuMusic') !== 'off' : savedEnabled === '1';
  const savedVolume = Number(read('woe.campaignMusicVolume') ?? read('menuMusicVolume') ?? 8);
  let volume = Number.isFinite(savedVolume) ? Math.max(0, Math.min(20, savedVolume)) : 8;
  audio.volume = volume / 100;
  let initialized = false;
  let cachePrefix = '';
  let pending = null;
  let saving = false;

  function cache() {
    if (!cachePrefix) return;
    save(cachePrefix + 'volume', String(volume));
    save(cachePrefix + 'enabled', enabled ? '1' : '0');
  }
  async function flush() {
    if (saving || !pending) return;
    saving = true;
    const settings = pending;
    pending = null;
    try {
      await api.request('PATCH', '/api/auth/me/audio', settings, { keepalive: true });
    } catch {
      pending = { ...settings, ...pending };
      toast('Could not save audio settings. Your next change will retry.');
      saving = false;
      return;
    }
    saving = false;
    if (pending) await flush();
  }
  function persist(settings) {
    cache();
    pending = { ...pending, ...settings };
    void flush();
  }
  async function initialize(userId) {
    cachePrefix = `woe.audio.${userId}.`;
    const cachedVolume = read(cachePrefix + 'volume');
    const cachedEnabled = read(cachePrefix + 'enabled');
    if (cachedVolume !== null && Number.isFinite(Number(cachedVolume))) volume = Math.max(0, Math.min(20, Number(cachedVolume)));
    if (cachedEnabled !== null) enabled = cachedEnabled === '1';
    try {
      const { settings } = await api.get('/api/auth/me/audio');
      const initial = {};
      if (settings.musicVolume === null) initial.musicVolume = volume;
      else volume = settings.musicVolume;
      if (settings.musicEnabled === null) initial.musicEnabled = enabled;
      else enabled = settings.musicEnabled;
      // Carry over this browser's preferences only when the account has none yet.
      if (Object.keys(initial).length) {
        pending = initial;
        await flush();
      }
    } catch {
      toast('Could not load saved audio settings. Using this browser’s settings.');
    }
    audio.volume = volume / 100;
    cache();
    initialized = true;
    if (enabled) play().catch(() => {});
  }

  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('woe-campaign-music') : null;
  if (channel) channel.onmessage = event => { if (event.data === 'playing') audio.pause(); };

  async function play() {
    if (!initialized || !enabled || document.hidden || !audio.paused) return;
    await audio.play();
    channel?.postMessage('playing');
  }
  function setEnabled(on) {
    enabled = !!on;
    save('woe.campaignMusic', enabled ? '1' : '0');
    persist({ musicEnabled: enabled });
    if (enabled) play().catch(() => { /* browser needs a user gesture */ });
    else audio.pause();
  }
  function setVolume(value) {
    volume = Math.max(0, Math.min(20, Number(value) || 0));
    audio.volume = volume / 100;
    save('woe.campaignMusicVolume', String(volume));
    persist({ musicVolume: volume });
  }

  window.addEventListener('pointerdown', () => { if (enabled) play().catch(() => {}); }, { passive: true });
  window.addEventListener('keydown', () => { if (enabled) play().catch(() => {}); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) audio.pause();
    else if (enabled) play().catch(() => {});
  });
  window.addEventListener('pagehide', () => {
    audio.pause();
    // Keep queued slider changes alive when the user refreshes immediately.
    if (pending) fetch('/api/auth/me/audio', { method: 'PATCH', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending), keepalive: true }).catch(() => {});
  });

  return { initialize, get enabled() { return enabled; }, set enabled(on) { setEnabled(on); },
    get volume() { return volume; }, set volume(value) { setVolume(value); } };
})();

window.CampaignMusic = CampaignMusic;
