/**
 * RealDac – Synchronized music playback
 * Features: Room-based sync, 3-2-1 countdown, pause syncs everywhere.
 * 
 * Robustness improvements:
 * - Auto-reconnect with room rejoin
 * - Audio context resume on user interaction
 * - Proper cleanup on unmount
 * - Error recovery and retry logic
 * - Participant count display
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams, useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { io } from 'socket.io-client';
import { Capacitor } from '@capacitor/core';
import QRCode from 'qrcode';
import { log, warn } from '../lib/logger';

const SERVER_URL = Capacitor.isNativePlatform() ? 'https://realdac.gradex.bond' : '';

const DEFAULT_REALDAC_TRACK = '/realdac-songs/honey-singh/blue-eyes.mp3';
const DEFAULT_REALDAC_ALBUM_ID = 'honey-singh';
const FALLBACK_ALBUM = {
  id: DEFAULT_REALDAC_ALBUM_ID,
  name: 'Honey Singh',
  songs: [{ id: DEFAULT_REALDAC_TRACK, name: 'blue eyes' }],
};
const COUNTDOWN_SEC = 3;
// Burst size for offset measurement. More samples = better min-RTT pick.
// 7 hits the sweet spot recommended by NTP RFC 5905 for burst mode.
// Cross-network this trades ~200ms of handshake time for ~30-60ms of accuracy.
const TIME_SYNC_SAMPLES = 7;
const RECONNECT_REJOIN_DELAY = 500; // ms to wait before rejoining after reconnect
const SEEK_LEAD_MS = 350;
const CATCHUP_LEAD_MS = 900;
const OFFSET_REFRESH_INTERVAL_MS = 25000;
const DRIFT_CHECK_INTERVAL_MS = 900;
const DRIFT_IGNORE_MS = 60;
const DRIFT_HARD_RESYNC_MS = 180;
const DRIFT_RESYNC_COOLDOWN_MS = 1400;
const MAX_ROOM_RECOVERY_AGE_MS = 5 * 60 * 1000;

function readConnectionSnapshot() {
  if (typeof navigator === 'undefined') {
    return {
      online: true,
      effectiveType: 'unknown',
      downlink: 0,
      rtt: 0,
      saveData: false,
    };
  }

  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  return {
    online: navigator.onLine !== false,
    effectiveType: connection?.effectiveType || 'unknown',
    downlink: Number(connection?.downlink) || 0,
    rtt: Number(connection?.rtt) || 0,
    saveData: Boolean(connection?.saveData),
  };
}

function deriveSyncProfile(network, jitterMs = 0, reconnecting = false) {
  const effective = String(network?.effectiveType || '').toLowerCase();
  const veryWeak = !network?.online || network?.saveData || effective === 'slow-2g' || effective === '2g';
  const weak = veryWeak || effective === '3g';

  let profile = {
    syncSamples: TIME_SYNC_SAMPLES,
    syncTimeoutMs: 4000,
    syncSampleGapMs: 35,
    offsetRefreshMs: OFFSET_REFRESH_INTERVAL_MS,
    driftCheckMs: DRIFT_CHECK_INTERVAL_MS,
    driftIgnoreMs: DRIFT_IGNORE_MS,
    driftHardResyncMs: DRIFT_HARD_RESYNC_MS,
    seekLeadMs: SEEK_LEAD_MS,
    catchupLeadMs: CATCHUP_LEAD_MS,
    reconnectRejoinDelayMs: RECONNECT_REJOIN_DELAY,
    reconnectionDelayMs: 1000,
    reconnectionDelayMaxMs: 5000,
  };

  if (weak) {
    profile = {
      ...profile,
      syncSamples: 10,
      syncTimeoutMs: 8000,
      syncSampleGapMs: 90,
      offsetRefreshMs: 14000,
      driftCheckMs: 1200,
      driftIgnoreMs: 80,
      driftHardResyncMs: 220,
      seekLeadMs: 520,
      catchupLeadMs: 1250,
      reconnectRejoinDelayMs: 900,
      reconnectionDelayMs: 1300,
      reconnectionDelayMaxMs: 9000,
    };
  }

  const highRtt = Number(network?.rtt || 0) >= 240;
  const highJitter = Number(jitterMs || 0) >= 120;
  if (highRtt || highJitter) {
    profile = {
      ...profile,
      syncSamples: Math.max(profile.syncSamples, 12),
      syncTimeoutMs: Math.max(profile.syncTimeoutMs, 9000),
      syncSampleGapMs: Math.max(profile.syncSampleGapMs, 110),
      seekLeadMs: Math.max(profile.seekLeadMs, 640),
      catchupLeadMs: Math.max(profile.catchupLeadMs, 1450),
      driftIgnoreMs: Math.max(profile.driftIgnoreMs, 95),
      driftHardResyncMs: Math.max(profile.driftHardResyncMs, 260),
      offsetRefreshMs: Math.min(profile.offsetRefreshMs, 12000),
      reconnectRejoinDelayMs: Math.max(profile.reconnectRejoinDelayMs, 1100),
      reconnectionDelayMaxMs: Math.max(profile.reconnectionDelayMaxMs, 12000),
    };
  }

  if (reconnecting) {
    profile = {
      ...profile,
      syncSamples: Math.max(profile.syncSamples, 10),
      offsetRefreshMs: Math.min(profile.offsetRefreshMs, 9000),
      driftCheckMs: Math.max(profile.driftCheckMs, 1250),
      seekLeadMs: Math.max(profile.seekLeadMs, 680),
      catchupLeadMs: Math.max(profile.catchupLeadMs, 1600),
      reconnectRejoinDelayMs: Math.max(profile.reconnectRejoinDelayMs, 1200),
    };
  }

  return profile;
}

function formatTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function toProperCase(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => {
      if (/^[A-Z0-9]{2,}$/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

function resolvePlayableTrack(albums, requestedTrack, requestedAlbumId) {
  const catalogAlbums = Array.isArray(albums) && albums.length ? albums : [FALLBACK_ALBUM];
  const catalogSongs = catalogAlbums.flatMap((album) => album.songs || []);

  const trackMatch = catalogSongs.find((song) => song.id === requestedTrack);
  if (trackMatch) {
    const album = catalogAlbums.find((item) => item.songs?.some((song) => song.id === requestedTrack)) || catalogAlbums[0];
    return {
      trackId: trackMatch.id,
      albumId: album?.id || requestedAlbumId || FALLBACK_ALBUM.id,
      trackName: trackMatch.name,
    };
  }

  const albumMatch = catalogAlbums.find((album) => album.id === requestedAlbumId && album.songs?.length);
  if (albumMatch?.songs?.[0]) {
    return {
      trackId: albumMatch.songs[0].id,
      albumId: albumMatch.id,
      trackName: albumMatch.songs[0].name,
    };
  }

  const firstSong = catalogSongs[0] || FALLBACK_ALBUM.songs[0];
  const firstAlbum = catalogAlbums.find((album) => album.songs?.some((song) => song.id === firstSong.id)) || FALLBACK_ALBUM;
  return {
    trackId: firstSong.id,
    albumId: firstAlbum.id,
    trackName: firstSong.name,
  };
}

function getRoomPlaybackRecovery(playState, serverNow) {
  if (!playState?.track) return null;

  const playAtServerMs = Number(playState.playAtServerMs ?? playState.playAt);
  if (!Number.isFinite(playAtServerMs)) return null;
  if (serverNow - playAtServerMs > MAX_ROOM_RECOVERY_AGE_MS) return null;

  const startedAt = typeof playState.startedAt === 'number'
    ? playState.startedAt
    : (typeof playState.anchorStartedAtServerMs === 'number'
      ? playState.anchorStartedAtServerMs
      : playAtServerMs);

  const baseOffsetSec = Number.isFinite(playState.anchorOffsetSec)
    ? Math.max(0, Number(playState.anchorOffsetSec) || 0)
    : 0;

  return {
    track: playState.track,
    playAtServerMs,
    startedAtServerMs: startedAt,
    seekOffsetSec: Math.max(0, baseOffsetSec + Math.max(0, (serverNow - startedAt) / 1000)),
  };
}

/**
 * Monotonic wall-clock approximation for cross-device sync.
 *
 * Returns ms-since-epoch like Date.now(), BUT derived from performance.now()
 * which is monotonic and immune to OS clock adjustments. Critical for sync:
 * the OS can nudge Date.now() by 20-80ms when its NTP daemon corrects time
 * (common on iOS, Android, Windows). That nudge would silently invalidate
 * our cached offset and cause audible drift mid-playback. performance.now()
 * isn't touched by OS clock corrections — it only moves forward at the
 * hardware clock rate.
 *
 * performance.timeOrigin is captured once at page navigation. The sum
 * (timeOrigin + now()) is "wall-clock time as seen at startup, advanced
 * monotonically since". For sync deltas against a server's Date.now(),
 * that's exactly what we want.
 */
function clientNow() {
  if (typeof performance !== 'undefined' && performance.timeOrigin != null) {
    return performance.timeOrigin + performance.now();
  }
  return Date.now();
}

function TechIcon({ size = 20, strokeWidth = 1.8, children, style, ...props }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
      {...props}
    >
      {children}
    </svg>
  );
}

export default function RealDac() {
  const [searchParams] = useSearchParams();
  const { roomCode: urlRoomCode } = useParams();
  const navigate = useNavigate();
  const [screen, setScreen] = useState('join');
  const [roomCode, setRoomCode] = useState('');
  const [joinStatus, setJoinStatus] = useState('');
  const [roomStatus, setRoomStatus] = useState('');
  const [inputCode, setInputCode] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');

  useEffect(() => {
    const room = searchParams.get('room') || urlRoomCode;
    if (room) setInputCode(String(room).replace(/\D/g, '').slice(0, 6));
  }, [searchParams, urlRoomCode]);

  const autoJoinAttempted = useRef(false);
  // Browser autoplay policy: AudioContext can't be resumed without a user gesture.
  // We stash a pending playState here and run it on the first tap/click/keypress.
  const pendingRecoveryRef = useRef(null);
  const [awaitingTap, setAwaitingTap] = useState(false);
  const [trackPickerOpen, setTrackPickerOpen] = useState(false);
  const trackPickerRef = useRef(null);

  // Click-outside + Escape to close the track picker
  useEffect(() => {
    if (!trackPickerOpen) return undefined;
    const onClick = (e) => {
      if (!trackPickerRef.current) return;
      if (!trackPickerRef.current.contains(e.target)) setTrackPickerOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setTrackPickerOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [trackPickerOpen]);
  const [albums, setAlbums] = useState([FALLBACK_ALBUM]);
  const [selectedAlbum, setSelectedAlbum] = useState(FALLBACK_ALBUM.id);
  const [tracks, setTracks] = useState(FALLBACK_ALBUM.songs);
  const [selectedTrack, setSelectedTrack] = useState(FALLBACK_ALBUM.songs[0].id);
  const [socketConnected, setSocketConnected] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [countdown, setCountdown] = useState(null); // 3, 2, 1, 0
  const [volume, setVolume] = useState(1);
  const [syncError, setSyncError] = useState(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [participants, setParticipants] = useState(1);
  const [reconnecting, setReconnecting] = useState(false);
  const [playButtonLocked, setPlayButtonLocked] = useState(false);
  const [trackDurationMs, setTrackDurationMs] = useState(0);
  const [progressMs, setProgressMs] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekPreviewMs, setSeekPreviewMs] = useState(0);
  const [syncReadyCount, setSyncReadyCount] = useState(0);
  const [syncTotalParticipants, setSyncTotalParticipants] = useState(1);
  const [syncPhase, setSyncPhase] = useState('idle');

  const socketRef = useRef(null);
  const roomCodeRef = useRef(''); // Track room code for reconnection
  const albumsRef = useRef(albums);
  albumsRef.current = albums;
  const stopCurrentRef = useRef(null);
  const measureOffsetRef = useRef(null);
  const loadBufferRef = useRef(null);
  const schedulePlayRef = useRef(null);
  const offsetRef = useRef(0);
  const audioCtxRef = useRef(null);
  const gainNodeRef = useRef(null);
  const buffersRef = useRef({});
  const currentSourceRef = useRef(null);
  const countdownTimerRef = useRef(null);
  const playStartTimeRef = useRef(0);
  const trackDurationRef = useRef(0);
  const progressIntervalRef = useRef(null);
  const lastScheduledPlayAtRef = useRef(0);
  const playButtonLockRef = useRef(false);
  const lastScheduledTrackRef = useRef('');
  const lastScheduledOffsetRef = useRef(0);
  const lastSeekCommitAtRef = useRef(0);
  const lastSeekPositionRef = useRef(-1);
  const timeSyncQualityRef = useRef({ jitterMs: 0, sampleCount: 0 });
  const authoritativePlaybackRef = useRef(null);
  const localPlaybackRef = useRef({
    generation: 0,
    track: '',
    startAtCtxTime: 0,
    startOffsetSec: 0,
    anchorStartedAtServerMs: 0,
    playAtServerMs: 0,
  });
  const activeGenerationRef = useRef(0);
  const prepareGenerationRef = useRef(0);
  const driftCorrectionAtRef = useRef(0);
  const wakeLockRef = useRef(null);
  const participantsRef = useRef(1);
  const syncToPlaybackStateRef = useRef(null);
  const emitSyncReadyRef = useRef(null);
  const networkSnapshotRef = useRef(readConnectionSnapshot());
  const syncProfileRef = useRef(deriveSyncProfile(networkSnapshotRef.current, 0, false));

  participantsRef.current = participants;

  const refreshSyncProfile = useCallback((overrides = {}) => {
    const reconnectingNow = overrides.reconnecting ?? reconnecting;
    const jitterMs = Number(overrides.jitterMs ?? timeSyncQualityRef.current.jitterMs ?? 0);
    const profile = deriveSyncProfile(networkSnapshotRef.current, jitterMs, reconnectingNow);
    syncProfileRef.current = profile;

    const socket = socketRef.current;
    if (socket?.io) {
      socket.io.reconnectionDelay(profile.reconnectionDelayMs);
      socket.io.reconnectionDelayMax(profile.reconnectionDelayMaxMs);
    }
    return profile;
  }, [reconnecting]);

  useEffect(() => {
    fetch('/songs.json')
      .then((r) => r.json())
      .then((data) => {
        const alb = data?.albums?.length > 0 ? data.albums : [FALLBACK_ALBUM];
        setAlbums(alb);
        const first = alb[0];
        setSelectedAlbum(first.id);
        const songs = first.songs || [];
        setTracks(songs);
        setSelectedTrack(songs[0]?.id || FALLBACK_ALBUM.songs[0].id);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!roomCode) { setQrDataUrl(''); return; }
    const url = `${window.location.origin}/${roomCode}`;
    let cancelled = false;
    QRCode.toDataURL(url, { margin: 2, width: 160, color: { dark: '#000000', light: '#ffffff' } })
      .then((dataUrl) => { if (!cancelled) setQrDataUrl(dataUrl); })
      .catch(() => {
        QRCode.toString(url, { type: 'svg', margin: 2, width: 160 })
          .then((svg) => { if (!cancelled) setQrDataUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`); })
          .catch(() => { if (!cancelled) setQrDataUrl(''); });
      });
    return () => { cancelled = true; };
  }, [roomCode]);

  useEffect(() => {
    const album = albums.find((a) => a.id === selectedAlbum);
    if (album?.songs?.length) {
      setTracks(album.songs);
      const trackInAlbum = album.songs.some((s) => s.id === selectedTrack);
      if (!trackInAlbum) setSelectedTrack(album.songs[0].id);
    }
  }, [selectedAlbum, albums, selectedTrack]);

  // Convex query is supplementary — it persists last-selected-track for cross-device recovery.
  // The real-time sync goes through Socket.IO, so a broken Convex deployment must NOT crash the UI.
  let roomState;
  try {
    roomState = useQuery(
      roomCode ? api.realdacRooms.getByRoomCode : 'skip',
      roomCode ? { roomCode } : 'skip'
    );
  } catch (e) {
    if (typeof window !== 'undefined' && !window.__rdConvexWarned) {
      window.__rdConvexWarned = true;
      // eslint-disable-next-line no-console
      console.warn('[RealDac] Convex query failed — running socket-only:', e?.message || e);
    }
    roomState = undefined;
  }
  const updateRoomTrack = useMutation(api.realdacRooms.updateTrack);

  useEffect(() => {
    if (!roomCode || !roomState) return;
    setSelectedAlbum(roomState.currentAlbum);
    setSelectedTrack(roomState.currentTrack);
  }, [roomCode, roomState]);

  const measureOffset = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket?.connected) return offsetRef.current;

    const profile = refreshSyncProfile();
    const syncSamples = Math.max(2, Number(profile.syncSamples) || TIME_SYNC_SAMPLES);
    const syncTimeoutMs = Math.max(2000, Number(profile.syncTimeoutMs) || 4000);
    const sampleGapMs = Math.max(15, Number(profile.syncSampleGapMs) || 35);

    const samples = [];
    for (let i = 0; i < syncSamples; i += 1) {
      try {
        const sample = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Timeout')), syncTimeoutMs);
          const clientSend = clientNow();
          socket.emit('TIME_SYNC_REQ', clientSend, (data) => {
            clearTimeout(timeout);
            const clientRecv = clientNow();
            const rtt = clientRecv - clientSend;
            resolve({
              offset: data.serverTime - (clientSend + rtt / 2),
              rtt,
            });
          });
        });
        samples.push(sample);
      } catch (e) {
        warn('[RealDac] Time sync sample failed:', e.message);
      }

      if (i < syncSamples - 1) {
        await new Promise((resolve) => setTimeout(resolve, sampleGapMs));
      }
    }

    if (samples.length > 0) {
      // NTP-style min-RTT selection.
      // The offset estimate `serverTime - (clientSend + RTT/2)` is only exact
      // if the request and response legs took *the same* time. The lower the
      // RTT, the smaller the bound on that asymmetry. So instead of averaging
      // all samples (which lets bad samples poison the mean), we sort by RTT
      // ascending and keep only the lowest-RTT third — then take the median
      // of their offsets. This is what chrony / browser timesync libraries do
      // and it cuts cross-network offset error from ±RTT/2 down to ±jitter/2.
      const byRtt = [...samples].sort((a, b) => a.rtt - b.rtt);
      const keepK = Math.max(1, Math.ceil(byRtt.length / 3));
      const best = byRtt.slice(0, keepK).sort((a, b) => a.offset - b.offset);
      const bestOffset = best[Math.floor(best.length / 2)].offset;

      // Jitter = spread among the best samples (used for adaptive profile).
      const jitterMs = best.length > 1
        ? Math.max(...best.map((s) => Math.abs(s.offset - bestOffset)))
        : Math.max(0, best[0]?.rtt ?? 0);

      offsetRef.current = bestOffset;
      timeSyncQualityRef.current = {
        jitterMs,
        sampleCount: best.length,
        bestRttMs: byRtt[0]?.rtt ?? 0,
      };
      refreshSyncProfile({ jitterMs, reconnecting: reconnecting && socket?.connected !== true });
    }

    return offsetRef.current;
  }, [reconnecting, refreshSyncProfile]);

  // Get or create AudioContext, handle suspended state
  const getAudioCtx = useCallback(async () => {
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtxRef.current = new Ctx();
      const gainNode = audioCtxRef.current.createGain();
      gainNode.connect(audioCtxRef.current.destination);
      gainNodeRef.current = gainNode;
    }
    
    // Resume if suspended (required after user gesture on mobile)
    if (audioCtxRef.current.state === 'suspended') {
      try {
        await audioCtxRef.current.resume();
        log('[RealDac] AudioContext resumed');
      } catch (e) {
        warn('[RealDac] Failed to resume AudioContext:', e.message);
      }
    }
    
    return audioCtxRef.current;
  }, []);

  // Load and decode audio buffer with retry logic
  const loadBuffer = useCallback(async (url, retries = 2) => {
    const buffers = buffersRef.current;
    if (buffers[url]) return buffers[url];
    
    const ctx = await getAudioCtx();
    
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        
        const r = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        
        const ab = await r.arrayBuffer();
        const buf = await ctx.decodeAudioData(ab);
        buffers[url] = buf;
        log(`[RealDac] Loaded audio: ${url} (${(ab.byteLength / 1024 / 1024).toFixed(2)} MB)`);
        return buf;
      } catch (e) {
        warn(`[RealDac] Load attempt ${attempt + 1} failed for ${url}:`, e.message);
        if (attempt === retries) throw new Error(`Failed to load audio after ${retries + 1} attempts`);
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); // Exponential backoff
      }
    }
  }, [getAudioCtx]);

  const emitSyncReady = useCallback((generation, track, loadMs, bufferReady = true) => {
    const socket = socketRef.current;
    if (!socket?.connected) return;
    socket.emit('SYNC_READY', {
      generation,
      track,
      loadMs: Math.round(Math.max(0, loadMs || 0)),
      bufferReady,
      syncJitterMs: Math.round(Math.max(0, timeSyncQualityRef.current.jitterMs || 0)),
    }, (res) => {
      if (res?.readyCount != null) {
        setSyncReadyCount(res.readyCount);
        setSyncTotalParticipants(res.totalParticipants || participantsRef.current);
      }
      if (res?.error) {
        warn('[RealDac] SYNC_READY rejected:', res.error);
      }
    });
  }, []);

  const stopCurrent = useCallback(() => {
    if (currentSourceRef.current) {
      try { currentSourceRef.current.stop(); } catch (_) {}
      currentSourceRef.current = null;
    }
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    localPlaybackRef.current = {
      generation: 0,
      track: '',
      startAtCtxTime: 0,
      startOffsetSec: 0,
      anchorStartedAtServerMs: 0,
      playAtServerMs: 0,
    };
    setIsPlaying(false);
    setCountdown(null);
  }, []);

  stopCurrentRef.current = stopCurrent;
  measureOffsetRef.current = measureOffset;

  const startCountdown = useCallback((playAtMs) => {
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    const tick = () => {
      const serverNow = clientNow() + offsetRef.current;
      const remaining = (playAtMs - serverNow) / 1000;
      if (remaining <= 0) {
        clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
        setCountdown(0);
        setRoomStatus('Live');
        setSyncPhase('live');
        setTimeout(() => setCountdown(null), 200);
      } else {
        const nextValue = Math.ceil(remaining);
        setCountdown(nextValue);
        setRoomStatus(`Starting in ${nextValue}`);
        setSyncPhase('countdown');
      }
    };
    tick();
    countdownTimerRef.current = setInterval(tick, 80);
  }, []);

  const schedulePlay = useCallback(async (trackUrl, playAtServerMs, startOffsetSec = 0, options = {}) => {
    const force = options.force === true;
    const generation = options.generation ?? activeGenerationRef.current ?? 0;
    const anchorStartedAtServerMs = options.anchorStartedAtServerMs ?? (playAtServerMs - startOffsetSec * 1000);
    const authoritativeAnchorOffsetSec = options.authoritativeAnchorOffsetSec ?? startOffsetSec;

    if (
      !force &&
      trackUrl === lastScheduledTrackRef.current &&
      Math.abs(lastScheduledPlayAtRef.current - playAtServerMs) < 2000 &&
      Math.abs(lastScheduledOffsetRef.current - startOffsetSec) < 0.35
    ) {
      log('[RealDac] Skipping duplicate play schedule');
      return;
    }
    lastScheduledPlayAtRef.current = playAtServerMs;
    lastScheduledTrackRef.current = trackUrl;
    lastScheduledOffsetRef.current = startOffsetSec;

    stopCurrent();
    
    const ctx = await getAudioCtx();
    const buf = buffersRef.current[trackUrl];
    
    if (!buf) { 
      setRoomStatus('Track not ready'); 
      warn('[RealDac] Buffer not loaded for:', trackUrl);
      return; 
    }
    if (!gainNodeRef.current) {
      warn('[RealDac] Gain node not initialized');
      return;
    }

    const offset = offsetRef.current;
    const playAtClient = playAtServerMs - offset;
    const delayMs = Math.max(0, playAtClient - clientNow());
    const startAt = ctx.currentTime + delayMs / 1000;
    const safeOffsetSec = Math.max(0, Math.min(startOffsetSec, Math.max(0, buf.duration - 0.05)));

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gainNodeRef.current);

    src.onended = () => {
      if (currentSourceRef.current !== src) return;
      currentSourceRef.current = null;
      setIsPlaying(false);
      setCountdown(null);
      setRoomStatus('Finished');
      setSyncPhase('idle');
    };

    src.onerror = (e) => {
      console.error('[RealDac] Audio source error:', e);
      setRoomStatus('Playback error');
      setIsPlaying(false);
      setSyncPhase('idle');
    };

    try {
      gainNodeRef.current.gain.cancelScheduledValues(ctx.currentTime);
      gainNodeRef.current.gain.setValueAtTime(0.0001, ctx.currentTime);
      gainNodeRef.current.gain.linearRampToValueAtTime(volume, startAt + 0.05);

      src.start(startAt, safeOffsetSec);
      currentSourceRef.current = src;
      playStartTimeRef.current = playAtServerMs - safeOffsetSec * 1000;
      trackDurationRef.current = buf.duration * 1000;
      localPlaybackRef.current = {
        generation,
        track: trackUrl,
        startAtCtxTime: startAt,
        startOffsetSec: safeOffsetSec,
        anchorStartedAtServerMs,
        playAtServerMs,
      };
      activeGenerationRef.current = generation;
      authoritativePlaybackRef.current = {
        generation,
        track: trackUrl,
        playAtServerMs,
        anchorStartedAtServerMs,
        anchorOffsetSec: authoritativeAnchorOffsetSec,
        paused: false,
      };
      setTrackDurationMs(buf.duration * 1000);
      setProgressMs(safeOffsetSec * 1000);
      setIsPlaying(true);

      if (delayMs > 400) {
        startCountdown(playAtServerMs);
      } else {
        setCountdown(null);
        setRoomStatus(options.status || 'Live');
        setSyncPhase('live');
      }

      log(`[RealDac] Scheduled playback in ${delayMs}ms from ${safeOffsetSec.toFixed(2)}s`);
    } catch (e) {
      console.error('[RealDac] Failed to start playback:', e);
      setRoomStatus('Playback failed');
      setSyncPhase('idle');
    }
  }, [getAudioCtx, stopCurrent, startCountdown, volume]);

  loadBufferRef.current = loadBuffer;
  schedulePlayRef.current = schedulePlay;

  const syncToPlaybackState = useCallback(async (playbackState, options = {}) => {
    if (!playbackState?.track) return;

    authoritativePlaybackRef.current = playbackState;
    activeGenerationRef.current = playbackState.generation ?? activeGenerationRef.current;
    prepareGenerationRef.current = playbackState.generation ?? prepareGenerationRef.current;
    setSelectedTrack(playbackState.track);

    const albumWithTrack = albumsRef.current.find((album) => album.songs?.some((song) => song.id === playbackState.track));
    if (albumWithTrack) setSelectedAlbum(albumWithTrack.id);

    if (playbackState.paused) {
      stopCurrent();
      setProgressMs(Math.max(0, (playbackState.anchorOffsetSec || 0) * 1000));
      setRoomStatus('Paused');
      setSyncPhase('paused');
      return;
    }

    await measureOffset();

    if (!buffersRef.current[playbackState.track]) {
      setLoadingAudio(true);
      setRoomStatus(options.status || (options.catchup ? 'Catching up…' : 'Preparing'));
      try {
        const buffer = await loadBuffer(playbackState.track);
        setTrackDurationMs(buffer.duration * 1000);
      } catch (e) {
        console.error('[RealDac] Failed to load playback track:', e);
        setRoomStatus(`Load failed: ${e?.message || e}`);
        setSyncPhase('idle');
        setLoadingAudio(false);
        return;
      }
      setLoadingAudio(false);
    }

    const serverNow = clientNow() + offsetRef.current;
    const hasFutureCommit = Number.isFinite(playbackState.playAtServerMs) && playbackState.playAtServerMs > serverNow + 120;
    if (hasFutureCommit) {
      await schedulePlay(
        playbackState.track,
        playbackState.playAtServerMs,
        playbackState.anchorOffsetSec || 0,
        {
          force: true,
          generation: playbackState.generation,
          anchorStartedAtServerMs: playbackState.anchorStartedAtServerMs,
          authoritativeAnchorOffsetSec: playbackState.anchorOffsetSec || 0,
          status: options.status || 'Starting…',
        }
      );
      return;
    }

    const liveOffsetSec = Math.max(
      0,
      (playbackState.anchorOffsetSec || 0) + Math.max(0, (serverNow - playbackState.anchorStartedAtServerMs) / 1000)
    );
    await schedulePlay(
      playbackState.track,
      serverNow + (options.catchup ? syncProfileRef.current.catchupLeadMs : syncProfileRef.current.seekLeadMs),
      liveOffsetSec,
      {
        force: true,
        generation: playbackState.generation,
        anchorStartedAtServerMs: playbackState.anchorStartedAtServerMs,
        authoritativeAnchorOffsetSec: playbackState.anchorOffsetSec || 0,
        status: options.status || (options.catchup ? 'Catching up…' : 'Live'),
      }
    );
  }, [loadBuffer, measureOffset, schedulePlay, stopCurrent]);

  syncToPlaybackStateRef.current = syncToPlaybackState;
  emitSyncReadyRef.current = emitSyncReady;

  const recoverRoomPlayback = useCallback(async (playState, options = {}) => {
    if (!playState?.track) return false;

    await measureOffset();
    const serverNow = clientNow() + offsetRef.current;
    const recovery = getRoomPlaybackRecovery(playState, serverNow);
    if (!recovery) return false;

    const recoverTrack = resolvePlayableTrack(albumsRef.current, recovery.track).trackId;
    const recoverAlbum = albumsRef.current.find((album) => album.songs?.some((song) => song.id === recoverTrack));
    if (recoverAlbum) setSelectedAlbum(recoverAlbum.id);
    setSelectedTrack(recoverTrack);

    if (!buffersRef.current[recoverTrack]) {
      setRoomStatus(options.status || 'Loading…');
      await loadBuffer(recoverTrack);
    }

    await schedulePlay(recoverTrack, serverNow + syncProfileRef.current.seekLeadMs, recovery.seekOffsetSec, {
      force: true,
      generation: activeGenerationRef.current,
      anchorStartedAtServerMs: serverNow - recovery.seekOffsetSec * 1000,
      authoritativeAnchorOffsetSec: recovery.seekOffsetSec,
      status: options.status || 'Playing',
    });

    return true;
  }, [loadBuffer, measureOffset, schedulePlay]);

  useEffect(() => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.setValueAtTime(volume, audioCtxRef.current?.currentTime ?? 0);
    }
  }, [volume]);

  useEffect(() => {
    const cached = buffersRef.current[selectedTrack];
    if (cached) {
      setTrackDurationMs(cached.duration * 1000);
    }
  }, [selectedTrack]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;

    const updateNetworkSnapshot = () => {
      networkSnapshotRef.current = readConnectionSnapshot();
      refreshSyncProfile();
    };

    updateNetworkSnapshot();
    window.addEventListener('online', updateNetworkSnapshot);
    window.addEventListener('offline', updateNetworkSnapshot);
    connection?.addEventListener?.('change', updateNetworkSnapshot);

    return () => {
      window.removeEventListener('online', updateNetworkSnapshot);
      window.removeEventListener('offline', updateNetworkSnapshot);
      connection?.removeEventListener?.('change', updateNetworkSnapshot);
    };
  }, [refreshSyncProfile]);

  useEffect(() => {
    refreshSyncProfile();
  }, [reconnecting, refreshSyncProfile]);

  useEffect(() => {
    refreshSyncProfile();
    const profile = syncProfileRef.current;
    const socket = io(SERVER_URL, {
      path: '/realdac/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: profile.reconnectionDelayMs,
      reconnectionDelayMax: profile.reconnectionDelayMaxMs,
      timeout: 15000,
    });
    socketRef.current = socket;

    socket.on('connect', async () => {
      log('[RealDac] Socket connected');
      setSocketConnected(true);
      setReconnecting(false);
      refreshSyncProfile({ reconnecting: false });
      await measureOffsetRef.current?.();

      const savedRoom = roomCodeRef.current;
      if (savedRoom) {
        log('[RealDac] Rejoining room after reconnect:', savedRoom);
        setTimeout(() => {
          socket.emit('ROOM_JOIN', savedRoom, async (res) => {
            if (!res?.success) {
              warn('[RealDac] Failed to rejoin room:', res?.error);
              setRoomStatus('Room expired');
              setSyncPhase('idle');
              return;
            }

            log('[RealDac] Rejoined room:', savedRoom);
            setParticipants(res.participants || 1);
            setSyncReadyCount(0);
            setSyncTotalParticipants(res.participants || 1);

            if (res.playState?.track) {
              // Same autoplay-gesture guard as auto-join: only run recovery
              // immediately if the user has already interacted (audio context
              // is in 'running' state); otherwise defer.
              const ctx = audioCtxRef.current;
              if (ctx && ctx.state === 'running') {
                try {
                  const recovered = await recoverRoomPlayback(res.playState, { status: 'Catching up…' });
                  if (!recovered) {
                    setRoomStatus('Ready');
                    setSyncPhase('idle');
                  }
                } catch (e) {
                  console.error('[RealDac] Failed to rebuild playback after reconnect:', e);
                  setRoomStatus('Rejoin sync failed');
                }
              } else {
                pendingRecoveryRef.current = res.playState;
                setAwaitingTap(true);
                setRoomStatus('Tap to start');
                setSyncPhase('idle');
              }
            } else {
              authoritativePlaybackRef.current = null;
              setRoomStatus('Ready');
              setSyncPhase('idle');
            }
          });
        }, syncProfileRef.current.reconnectRejoinDelayMs);
      }
    });

    socket.on('disconnect', (reason) => {
      log('[RealDac] Socket disconnected:', reason);
      setSocketConnected(false);
      if (reason !== 'io client disconnect') {
        setReconnecting(true);
        refreshSyncProfile({ reconnecting: true });
        setRoomStatus('Reconnecting…');
      }
    });

    socket.on('connect_error', (err) => {
      warn('[RealDac] Connection error:', err.message);
      setSocketConnected(false);
      refreshSyncProfile({ reconnecting: true });
    });

    socket.on('reconnect_attempt', (attempt) => {
      log('[RealDac] Reconnect attempt:', attempt);
      setReconnecting(true);
      refreshSyncProfile({ reconnecting: true });
      setRoomStatus('Reconnecting…');
    });

    socket.on('SYNC_PREPARE', async ({ generation, track, startOffsetSec, reason, totalParticipants }) => {
      log('[RealDac] SYNC_PREPARE:', generation, track, reason);
      prepareGenerationRef.current = generation;
      activeGenerationRef.current = generation;
      setSyncReadyCount(0);
      setSyncTotalParticipants(totalParticipants || participantsRef.current);
      setSyncPhase('preparing');
      setRoomStatus(reason === 'seek' ? 'Preparing seek…' : 'Preparing');

      const albumWithTrack = albumsRef.current.find((album) => album.songs?.some((song) => song.id === track));
      if (albumWithTrack) setSelectedAlbum(albumWithTrack.id);
      setSelectedTrack(track);

      const loadStarted = performance.now();
      let bufferReady = false;

      try {
        await measureOffsetRef.current?.();
        await getAudioCtx();
        if (!buffersRef.current[track]) {
          setLoadingAudio(true);
          await loadBufferRef.current?.(track);
        }
        bufferReady = Boolean(buffersRef.current[track]);
      } catch (e) {
        console.error('[RealDac] Prepare load failed:', e);
        setRoomStatus('Track failed to load');
        setSyncPhase('idle');
      } finally {
        setLoadingAudio(false);
        emitSyncReadyRef.current?.(generation, track, performance.now() - loadStarted, bufferReady);
        if (!bufferReady && Number.isFinite(startOffsetSec)) {
          authoritativePlaybackRef.current = {
            generation,
            track,
            playAtServerMs: null,
            anchorStartedAtServerMs: 0,
            anchorOffsetSec: startOffsetSec,
            paused: true,
          };
        }
      }
    });

    socket.on('SYNC_STATUS', ({ generation, readyCount, totalParticipants }) => {
      if (generation < prepareGenerationRef.current) return;
      setSyncReadyCount(readyCount);
      setSyncTotalParticipants(totalParticipants || participantsRef.current);
      if (readyCount < (totalParticipants || participantsRef.current)) {
        setRoomStatus(`Waiting for listeners (${readyCount}/${totalParticipants || participantsRef.current})`);
        setSyncPhase('waiting');
      }
    });

    socket.on('SYNC_CANCEL', ({ generation, reason }) => {
      if (generation < prepareGenerationRef.current) return;
      setCountdown(null);
      playButtonLockRef.current = false;
      setPlayButtonLocked(false);
      setSyncPhase('idle');
      setRoomStatus(reason === 'superseded' ? 'Sync updated' : reason || 'Sync cancelled');
    });

    socket.on('SYNC_COMMIT', async (payload) => {
      log('[RealDac] SYNC_COMMIT:', payload.generation, payload.track);
      prepareGenerationRef.current = payload.generation;
      activeGenerationRef.current = payload.generation;
      playButtonLockRef.current = false;
      setPlayButtonLocked(false);
      setSyncReadyCount(payload.readyCount ?? 0);
      setSyncTotalParticipants(payload.totalParticipants || participantsRef.current);

      try {
        await syncToPlaybackStateRef.current?.({
          generation: payload.generation,
          track: payload.track,
          playAtServerMs: payload.playAtServerMs,
          anchorStartedAtServerMs: payload.anchorStartedAtServerMs,
          anchorOffsetSec: payload.startOffsetSec || 0,
          paused: false,
        }, { status: 'Starting…' });
      } catch (e) {
        console.error('[RealDac] Failed to apply sync commit:', e);
        setRoomStatus('Commit failed');
        setSyncPhase('idle');
      }
    });

    socket.on('PLAY_AT', async ({ track, playAt, playAtServerMs, generation }) => {
      const scheduledPlayAt = Number(playAtServerMs) || Number(playAt);
      if (!track || !Number.isFinite(scheduledPlayAt)) return;

      log('[RealDac] Received PLAY_AT:', track, scheduledPlayAt);
      if (
        track === lastScheduledTrackRef.current &&
        Math.abs(lastScheduledPlayAtRef.current - scheduledPlayAt) < 2000
      ) {
        log('[RealDac] Ignoring echoed PLAY_AT for locally scheduled playback');
        if (generation != null && localPlaybackRef.current.track === track) {
          activeGenerationRef.current = generation;
          localPlaybackRef.current = {
            ...localPlaybackRef.current,
            generation,
            playAtServerMs: scheduledPlayAt,
            anchorStartedAtServerMs: scheduledPlayAt,
          };
        }
        return;
      }

      stopCurrentRef.current?.();
      await measureOffsetRef.current?.();
      setSelectedTrack(track);

      const albumWithTrack = albumsRef.current.find((album) => album.songs?.some((song) => song.id === track));
      if (albumWithTrack) setSelectedAlbum(albumWithTrack.id);

      try {
        if (!buffersRef.current[track]) {
          setRoomStatus('Loading…');
          await loadBufferRef.current?.(track);
        }
        await schedulePlayRef.current?.(track, scheduledPlayAt, 0, {
          force: true,
          generation: generation ?? activeGenerationRef.current,
          anchorStartedAtServerMs: scheduledPlayAt,
          authoritativeAnchorOffsetSec: 0,
          status: 'Starting…',
        });
      } catch (e) {
        console.error('[RealDac] PLAY_AT handler error:', e);
        setRoomStatus('Playback error');
        setSyncPhase('idle');
      }
    });

    socket.on('SEEK', async ({ position, serverTime, track }) => {
      const seekTrack = track || lastScheduledTrackRef.current || selectedTrack;
      if (!seekTrack) return;

      log('[RealDac] Received SEEK:', position);
      try {
        await measureOffsetRef.current?.();
        if (!buffersRef.current[seekTrack]) {
          setRoomStatus('Loading…');
          await loadBufferRef.current?.(seekTrack);
        }
        const serverNow = clientNow() + offsetRef.current;
        const liveOffsetSec = Math.max(0, Number(position || 0) + Math.max(0, serverNow - Number(serverTime || serverNow)) / 1000);
        await schedulePlayRef.current?.(seekTrack, serverNow + syncProfileRef.current.seekLeadMs, liveOffsetSec, {
          force: true,
          generation: activeGenerationRef.current,
          anchorStartedAtServerMs: serverNow - liveOffsetSec * 1000,
          authoritativeAnchorOffsetSec: liveOffsetSec,
          status: 'Synced',
        });
        setRoomStatus('Synced');
        setSyncPhase('live');
      } catch (e) {
        console.error('[RealDac] SEEK handler error:', e);
        setRoomStatus('Seek failed');
        setSyncPhase('idle');
      }
    });

    socket.on('PLAYBACK_STATE', (playbackState) => {
      authoritativePlaybackRef.current = playbackState || null;
      if (playbackState?.paused) {
        setProgressMs(Math.max(0, (playbackState.anchorOffsetSec || 0) * 1000));
        return;
      }

      if (!playbackState?.track) return;

      const localPlayback = localPlaybackRef.current;
      const sameGeneration = localPlayback.generation === playbackState.generation;
      const sameTrack = localPlayback.track === playbackState.track;
      const sameAnchor = Math.abs((localPlayback.anchorStartedAtServerMs || 0) - (playbackState.anchorStartedAtServerMs || 0)) < 150;
      const needsPlaybackRecovery = !currentSourceRef.current || !sameGeneration || !sameTrack || !sameAnchor;

      if (needsPlaybackRecovery) {
        void syncToPlaybackStateRef.current?.(playbackState, {
          catchup: true,
          status: 'Recovering playback…',
        });
      }
    });

    socket.on('PAUSE', (payload = {}) => {
      log('[RealDac] Received PAUSE');
      const playbackState = payload?.playbackState;
      authoritativePlaybackRef.current = playbackState || authoritativePlaybackRef.current;
      stopCurrentRef.current?.();
      setCountdown(null);
      playButtonLockRef.current = false;
      setPlayButtonLocked(false);
      setProgressMs(Math.max(0, ((playbackState?.anchorOffsetSec) || 0) * 1000));
      setRoomStatus('Paused');
      setSyncPhase('paused');
    });

    socket.on('SYNC_TICK', ({ serverTime }) => {
      offsetRef.current = serverTime - clientNow();
    });

    socket.on('PARTICIPANT_JOINED', ({ count }) => {
      log('[RealDac] Participant joined, total:', count);
      setParticipants(count);
    });

    socket.on('PARTICIPANT_LEFT', ({ count }) => {
      log('[RealDac] Participant left, total:', count);
      setParticipants(count);
    });

    return () => {
      log('[RealDac] Cleaning up socket');
      socket.emit('ROOM_LEAVE');
      socket.disconnect();
    };
  }, [refreshSyncProfile]);

  useEffect(() => {
    if (!roomCode) return undefined;

    let cancelled = false;
    let timer = null;

    const run = async () => {
      if (cancelled) return;
      await measureOffset();
      refreshSyncProfile();
      const nextMs = Math.max(6000, syncProfileRef.current.offsetRefreshMs || OFFSET_REFRESH_INTERVAL_MS);
      timer = window.setTimeout(run, nextMs);
    };

    run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [roomCode, measureOffset, refreshSyncProfile]);

  const syncTrackToConvex = useCallback(async (roomCodeVal, trackVal, albumVal, trackNameVal) => {
    const code = String(roomCodeVal ?? '').trim();
    const resolved = resolvePlayableTrack(albumsRef.current, trackVal, albumVal);
    const track = resolved.trackId;
    const album = resolved.albumId;
    const trackName = String(trackNameVal ?? '').trim() || resolved.trackName;
    if (!code || code.length !== 6) return;
    setSyncError(null);
    try {
      await updateRoomTrack({ roomCode: code, currentTrack: track, currentAlbum: album, currentTrackName: trackName || undefined });
    } catch (err) {
      warn('[RealDac] Failed to sync track to Convex:', err);
      setSyncError('Sync failed');
    }
  }, [updateRoomTrack]);

  const enterRoom = useCallback(async (code, participantCount = 1, options = {}) => {
    const roomCodeStr = String(code ?? '').trim();
    if (!roomCodeStr) return;
    const resolvedTrack = resolvePlayableTrack(albumsRef.current, options.track ?? selectedTrack, options.album ?? selectedAlbum);
    const trackToLoad = resolvedTrack.trackId;
    const albumToUse = resolvedTrack.albumId;
    // Caller (auto-join / socket reconnect) can ask us to skip the audio
    // preload — needed because browsers refuse to create/resume AudioContext
    // outside a fresh user gesture, and the navigation that brought us here
    // doesn't count.
    const skipAudioWarm = options.skipAudioWarm === true;

    roomCodeRef.current = roomCodeStr;
    setRoomCode(roomCodeStr);
    setParticipants(participantCount);
    setSyncReadyCount(0);
    setSyncTotalParticipants(participantCount);
    setSyncPhase('idle');
    setScreen('room');
    navigate(`/${roomCodeStr}`, { replace: true });
    setRoomStatus('');
    setSyncError(null);
    setSelectedTrack(trackToLoad);
    setSelectedAlbum(albumToUse);

    if (skipAudioWarm) {
      // Don't touch AudioContext yet. The track buffer will be loaded the
      // first time the user taps Play (which IS a gesture). Persist the
      // selection to Convex so other clients still see the choice.
      setRoomStatus('Ready');
      await syncTrackToConvex(roomCodeStr, trackToLoad, albumToUse, resolvedTrack.trackName);
      return;
    }

    setLoadingAudio(true);
    try {
      await getAudioCtx();
      const buffer = await loadBuffer(trackToLoad);
      setTrackDurationMs(buffer.duration * 1000);
      setRoomStatus('Ready');
    } catch (e) {
      console.error('[RealDac] Failed to load initial track:', e);
      setRoomStatus(`Load failed: ${e?.message || e}`);
    } finally {
      setLoadingAudio(false);
      await syncTrackToConvex(roomCodeStr, trackToLoad, albumToUse, resolvedTrack.trackName);
    }
  }, [selectedTrack, selectedAlbum, getAudioCtx, loadBuffer, syncTrackToConvex, navigate]);

  const handleCreate = () => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      setJoinStatus('Connecting…');
      return;
    }
    setJoinStatus('Creating room…');
    socket.emit('ROOM_CREATE', async (res) => {
      if (res?.error || !res?.success) {
        setJoinStatus(res?.error || 'Failed to create room');
        return;
      }
      setJoinStatus('');
      await enterRoom(res.roomCode, 1);
    });
  };

  const handleJoin = () => {
    const code = inputCode.trim();
    if (!code) {
      setJoinStatus('Enter room code');
      return;
    }
    if (code.length !== 6 || !/^\d{6}$/.test(code)) {
      setJoinStatus('Room code must be 6 digits');
      return;
    }
    const socket = socketRef.current;
    if (!socket?.connected) {
      setJoinStatus('Connecting…');
      return;
    }
    setJoinStatus('Joining…');
    socket.emit('ROOM_JOIN', code, async (res) => {
      if (res?.error || !res?.success) {
        setJoinStatus(res?.error || 'Room not found');
        return;
      }

      setJoinStatus('');
      const participantCount = res.participants || 1;
      if (res.playState?.track) {
        const { track } = res.playState;
        const albumWithTrack = albums.find((a) => a.songs?.some((s) => s.id === track));
        const albumId = albumWithTrack?.id ?? FALLBACK_ALBUM.id;
        await enterRoom(res.roomCode, participantCount, { track, album: albumId });
        try {
          const recovered = await recoverRoomPlayback(res.playState, { status: 'Catching up…' });
          if (!recovered) {
            setRoomStatus('Ready');
            setSyncPhase('idle');
          }
        } catch (e) {
          console.error('[RealDac] Failed to sync to room playback:', e);
          setRoomStatus('Sync failed');
        }
      } else {
        await enterRoom(res.roomCode, participantCount);
        authoritativePlaybackRef.current = null;
        setSyncPhase('idle');
      }
    });
  };

  // Auto-join when arriving via URL (e.g. from Workspace "Start room" → /:code)
  useEffect(() => {
    if (autoJoinAttempted.current) return;
    if (screen === 'room') return;
    const code = (urlRoomCode || searchParams.get('room') || '').replace(/\D/g, '').slice(0, 6);
    if (code.length !== 6) return;
    if (!socketConnected || !socketRef.current?.connected) return;
    autoJoinAttempted.current = true;
    setInputCode(code);
    setJoinStatus('Joining…');
    socketRef.current.emit('ROOM_JOIN', code, async (res) => {
      if (res?.error || !res?.success) {
        autoJoinAttempted.current = false;
        setJoinStatus(res?.error || 'Room not found');
        return;
      }
      setJoinStatus('');
      const participantCount = res.participants || 1;
      if (res.playState?.track) {
        const { track } = res.playState;
        const albumWithTrack = albums.find((a) => a.songs?.some((s) => s.id === track));
        const albumId = albumWithTrack?.id ?? FALLBACK_ALBUM.id;
        // Skip AudioContext warm-up — navigation isn't a gesture; we'll
        // unlock + recover on the first tap.
        await enterRoom(res.roomCode, participantCount, { track, album: albumId, skipAudioWarm: true });
        pendingRecoveryRef.current = res.playState;
        setAwaitingTap(true);
        setRoomStatus('Tap to start');
        setSyncPhase('idle');
      } else {
        // Fresh room: no recovery needed, but still skip the audio warm so
        // we don't trip browser autoplay policy. First Play tap loads it.
        await enterRoom(res.roomCode, participantCount, { skipAudioWarm: true });
        authoritativePlaybackRef.current = null;
        setSyncPhase('idle');
      }
    });
  }, [urlRoomCode, searchParams, socketConnected, screen, albums, enterRoom]);

  // On the first real user gesture (tap/click/key), unlock the audio context
  // and consume any pending playback recovery that was deferred from auto-join
  // or socket reconnect. This is the canonical workaround for browser autoplay
  // policies (Safari/Chrome refuse to start AudioContext before a gesture).
  useEffect(() => {
    if (!awaitingTap) return undefined;
    let cancelled = false;
    const fire = async () => {
      if (cancelled) return;
      const playState = pendingRecoveryRef.current;
      pendingRecoveryRef.current = null;
      setAwaitingTap(false);
      try {
        await getAudioCtx(); // resume happens here (we're in a gesture handler)
      } catch (e) {
        warn('[RealDac] Could not resume AudioContext on gesture:', e?.message);
      }
      if (!playState) return;
      try {
        const recovered = await recoverRoomPlayback(playState, { status: 'Catching up…' });
        if (!recovered) {
          setRoomStatus('Ready');
          setSyncPhase('idle');
        }
      } catch (e) {
        console.error('[RealDac] Deferred recovery failed:', e);
        setRoomStatus('Sync failed');
        setSyncPhase('idle');
      }
    };
    const events = ['pointerdown', 'keydown', 'touchstart'];
    events.forEach((ev) => window.addEventListener(ev, fire, { once: true, capture: true }));
    return () => {
      cancelled = true;
      events.forEach((ev) => window.removeEventListener(ev, fire, { capture: true }));
    };
  }, [awaitingTap, getAudioCtx, recoverRoomPlayback]);

  const preparePlay = useCallback(async (trackId = selectedTrack, options = {}) => {
    if (!roomCode) {
      setRoomStatus('Not in a room');
      return;
    }
    if (playButtonLockRef.current) {
      log('[RealDac] Play button locked, ignoring');
      return;
    }
    
    const socket = socketRef.current;
    if (!socket?.connected) {
      setRoomStatus('Not connected - reconnecting…');
      return;
    }

    playButtonLockRef.current = true;
    setPlayButtonLocked(true);
    setSyncReadyCount(0);
    setSyncTotalParticipants(participants);

    try {
      await getAudioCtx();
      const resolvedTrack = resolvePlayableTrack(albumsRef.current, trackId, options.albumId ?? selectedAlbum);
      const playableTrackId = resolvedTrack.trackId;
      const playableAlbumId = resolvedTrack.albumId;
      if (playableTrackId !== selectedTrack) {
        setSelectedTrack(playableTrackId);
      }
      if (playableAlbumId !== selectedAlbum) {
        setSelectedAlbum(playableAlbumId);
      }

      if (!buffersRef.current[playableTrackId]) {
        setLoadingAudio(true);
        setRoomStatus('Loading track…');
        try {
          await loadBuffer(playableTrackId);
        } catch (e) {
          setRoomStatus(`Load failed: ${e?.message || e}`);
          setLoadingAudio(false);
          playButtonLockRef.current = false;
          setPlayButtonLocked(false);
          return;
        }
        setLoadingAudio(false);
      }

      await measureOffset();

      const albumId = playableAlbumId;
      const name = resolvedTrack.trackName;
      syncTrackToConvex(roomCode, playableTrackId, albumId, name).catch(() => {});

      const serverNow = clientNow() + offsetRef.current;
      const playAt = serverNow + COUNTDOWN_SEC * 1000;

      setRoomStatus('Preparing');
      setSyncPhase('preparing');

      socket.emit('PLAY_AT', { track: playableTrackId, playAt }, (res) => {
        if (res?.error) {
          console.error('[RealDac] PLAY_AT error:', res.error);
          setRoomStatus(res.error);
          setSyncPhase('idle');
          playButtonLockRef.current = false;
          setPlayButtonLocked(false);
          return;
        }

        if (Number.isFinite(res?.playAt)) {
          lastScheduledPlayAtRef.current = res.playAt;
        }
      });

      await schedulePlay(playableTrackId, playAt, 0, {
        force: true,
        generation: activeGenerationRef.current,
        anchorStartedAtServerMs: playAt,
        authoritativeAnchorOffsetSec: 0,
        status: 'Starting…',
      });
    } catch (e) {
      console.error('[RealDac] Failed to prepare play:', e);
      setRoomStatus('Playback failed');
      setSyncPhase('idle');
      playButtonLockRef.current = false;
      setPlayButtonLocked(false);
      return;
    }

    setTimeout(() => {
      playButtonLockRef.current = false;
      setPlayButtonLocked(false);
    }, (COUNTDOWN_SEC + 1) * 1000);
  }, [getAudioCtx, loadBuffer, measureOffset, participants, roomCode, schedulePlay, selectedAlbum, selectedTrack, syncTrackToConvex]);

  const handlePlay = useCallback(async () => {
    await preparePlay(selectedTrack);
  }, [preparePlay, selectedTrack]);

  const handlePause = () => {
    const socket = socketRef.current;
    if (socket?.connected) socket.emit('PAUSE');
    playButtonLockRef.current = false;
    setPlayButtonLocked(false);
    stopCurrent();
    if (authoritativePlaybackRef.current) {
      authoritativePlaybackRef.current = {
        ...authoritativePlaybackRef.current,
        paused: true,
        anchorOffsetSec: progressMs / 1000,
        playAtServerMs: null,
      };
    }
    setRoomStatus('Paused');
    setSyncPhase('paused');
  };

  const commitSeek = useCallback(async (nextMs) => {
    if (!roomCode || !isPlaying) return;
    const socket = socketRef.current;
    if (!socket?.connected) {
      setRoomStatus('Not connected');
      return;
    }

    const now = Date.now();
    if (
      Math.abs(lastSeekPositionRef.current - nextMs) < 250 &&
      now - lastSeekCommitAtRef.current < 500
    ) {
      return;
    }
    lastSeekCommitAtRef.current = now;
    lastSeekPositionRef.current = nextMs;

    const positionSec = Math.max(0, nextMs / 1000);

    try {
      await measureOffset();
      const track = selectedTrack;

      if (!buffersRef.current[track]) {
        const buffer = await loadBuffer(track);
        setTrackDurationMs(buffer.duration * 1000);
      }

      const serverNow = clientNow() + offsetRef.current;

      await schedulePlay(track, serverNow + syncProfileRef.current.seekLeadMs, positionSec, {
        force: true,
        generation: activeGenerationRef.current,
        anchorStartedAtServerMs: serverNow - positionSec * 1000,
        authoritativeAnchorOffsetSec: positionSec,
        status: 'Seeking…',
      });
      socket.emit('SEEK', { position: positionSec }, (res) => {
        if (res?.error) {
          console.error('[RealDac] SEEK error:', res.error);
          setRoomStatus(res.error);
          setSyncPhase('idle');
          return;
        }
      });
      setRoomStatus('Seeking…');
      setSyncPhase('live');
    } catch (e) {
      console.error('[RealDac] Seek failed:', e);
      setRoomStatus('Seek failed');
      setSyncPhase('idle');
    }
  }, [isPlaying, loadBuffer, measureOffset, roomCode, schedulePlay, selectedTrack]);

  const handleLeave = () => {
    const socket = socketRef.current;
    if (socket?.connected) socket.emit('ROOM_LEAVE');
    stopCurrent();
    
    // Clear room tracking
    roomCodeRef.current = '';
    setRoomCode('');
    setParticipants(1);
    autoJoinAttempted.current = false;
    pendingRecoveryRef.current = null;
    setAwaitingTap(false);

    setScreen('join');
    setRoomStatus('');
    setJoinStatus('');
    setSyncError(null);
    setLinkCopied(false);
    setReconnecting(false);
    setSyncReadyCount(0);
    setSyncTotalParticipants(1);
    setSyncPhase('idle');
    authoritativePlaybackRef.current = null;
    playButtonLockRef.current = false;
    setPlayButtonLocked(false);
    navigate('/', { replace: true });
  };

  const copyToClipboard = useCallback(async (text, successMessage = 'Copied') => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setLinkCopied(true);
      setRoomStatus(successMessage);
      window.setTimeout(() => setLinkCopied(false), 1800);
    } catch (_) {
      setRoomStatus('Clipboard unavailable');
    }
  }, []);

  const inviteUrl = typeof window !== 'undefined' && roomCode ? `${window.location.origin}/${roomCode}` : '';

  const handleShareInvite = useCallback(async () => {
    if (!inviteUrl) return;
    try {
      if (navigator.share) {
        await navigator.share({
          title: 'Join my RealDac room',
          text: `Join my RealDac room ${roomCode}`,
          url: inviteUrl,
        });
        setRoomStatus('Invite sent');
      } else {
        await copyToClipboard(inviteUrl, 'Invite link copied');
      }
    } catch (e) {
      if (e?.name !== 'AbortError') {
        setRoomStatus('Invite unavailable');
      }
    }
  }, [copyToClipboard, inviteUrl, roomCode]);

  const stepTrack = useCallback(async (direction) => {
    const currentIndex = tracks.findIndex((track) => track.id === selectedTrack);
    if (currentIndex < 0) return;
    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= tracks.length) return;
    const nextTrack = tracks[nextIndex];
    setSelectedTrack(nextTrack.id);
    if (roomCode) {
      syncTrackToConvex(roomCode, nextTrack.id, selectedAlbum, nextTrack.name).catch(() => {});
    }
    if (isPlaying || countdown !== null) {
      await preparePlay(nextTrack.id, { albumId: selectedAlbum, reason: 'track-change' });
    } else {
      setRoomStatus(`Armed ${nextTrack.name}`);
    }
  }, [countdown, isPlaying, preparePlay, roomCode, selectedAlbum, selectedTrack, syncTrackToConvex, tracks]);

  const trackName = (roomCode && roomState?.currentTrackName) || tracks.find((t) => t.id === selectedTrack)?.name || albums.flatMap((a) => a.songs || []).find((s) => s.id === selectedTrack)?.name || 'Unknown';
  const currentAlbumMeta = albums.find((a) => a.id === selectedAlbum) || FALLBACK_ALBUM;
  const currentProgressMs = isSeeking ? seekPreviewMs : progressMs;
  const progressPercent = trackDurationMs > 0 ? Math.min(100, (currentProgressMs / trackDurationMs) * 100) : 0;
  const canSeek = isPlaying && trackDurationMs > 0 && !loadingAudio;
  const isRoomActive = screen === 'room' && Boolean(roomCode);
  const isPlaybackActive = isPlaying || countdown !== null || syncPhase === 'resyncing';
  const shouldShowPauseButton = isPlaying || countdown !== null || syncPhase === 'resyncing';
  const currentTrackIndex = Math.max(0, tracks.findIndex((t) => t.id === selectedTrack));
  const hasPrevTrack = currentTrackIndex > 0;
  const hasNextTrack = currentTrackIndex < tracks.length - 1;
  const remainingMs = Math.max(0, trackDurationMs - currentProgressMs);
  const latencyMs = Math.max(0, Math.round(timeSyncQualityRef.current.jitterMs || 0));
  const syncMetaLabel = timeSyncQualityRef.current.sampleCount ? `Latency ${latencyMs}ms` : 'Calibrating link';
  const statusMessage = loadingAudio ? 'Loading lossless stream…' : (syncError || roomStatus || '');
  const displayTrackName = toProperCase(trackName) || 'Unknown';
  const displayAlbumName = toProperCase(currentAlbumMeta.name) || 'General';
  const syncBadge = (() => {
    if (reconnecting) return { label: 'RE-LINKING', tone: '#f59e0b', toneKey: 'reconnecting', detail: 'Recovering room state' };
    if (countdown !== null) return { label: `START ${countdown}`, tone: '#00f2ff', toneKey: 'buffering', detail: 'Commit received' };
    if (loadingAudio || syncPhase === 'preparing') return { label: 'STARTING', tone: '#00f2ff', toneKey: 'buffering', detail: 'Preparing the track' };
    if (syncPhase === 'resyncing') return { label: 'SYNCING', tone: '#10b981', toneKey: 'live', detail: 'Tightening drift' };
    if (syncPhase === 'paused') return { label: 'PAUSED', tone: '#94a3b8', toneKey: 'paused', detail: 'Room playback stopped' };
    if (isPlaying) return { label: 'SYNC LOCK', tone: '#10b981', toneKey: 'live', detail: 'Room playback stable' };
    return { label: 'STANDBY', tone: '#64748b', toneKey: 'standby', detail: 'Awaiting command' };
  })();
  const readinessLabel = `${participants} ${participants === 1 ? 'listener online' : 'listeners online'}`;
  const artFrameLabel = `${roomCode || '000000'} // ${displayAlbumName}`.toUpperCase();

  // Progress: elapsed since play started (approximate, synced via server time)
  useEffect(() => {
    if (!isPlaying || countdown !== null) return;
    const tick = () => {
      const elapsed = clientNow() + offsetRef.current - playStartTimeRef.current;
      setProgressMs(Math.max(0, Math.min(trackDurationRef.current || 0, elapsed)));
    };
    tick();
    progressIntervalRef.current = setInterval(tick, 200);
    return () => {
      if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
    };
  }, [isPlaying, countdown]);
  useEffect(() => {
    if (!isPlaying && !authoritativePlaybackRef.current?.paused) setProgressMs(0);
  }, [isPlaying]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const releaseWakeLock = async () => {
      if (!wakeLockRef.current) return;
      try {
        await wakeLockRef.current.release();
      } catch (_) {
        // no-op
      } finally {
        wakeLockRef.current = null;
      }
    };

    const requestWakeLock = async () => {
      if (!isRoomActive || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) {
        return;
      }
      try {
        if (!wakeLockRef.current) {
          wakeLockRef.current = await navigator.wakeLock.request('screen');
          wakeLockRef.current.addEventListener('release', () => {
            if (wakeLockRef.current?.released) {
              wakeLockRef.current = null;
            }
          });
        }
      } catch (e) {
        warn('[RealDac] Wake lock unavailable:', e?.message || e);
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void requestWakeLock();
      } else {
        void releaseWakeLock();
      }
    };

    if (isRoomActive) {
      void requestWakeLock();
    } else {
      void releaseWakeLock();
    }

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      void releaseWakeLock();
    };
  }, [isRoomActive]);

  useEffect(() => {
    if (!window.GradeXPlayback?.setRealDacState) return undefined;

    try {
      window.GradeXPlayback.setRealDacState(isRoomActive, isPlaybackActive);
    } catch (_) {
      // no-op
    }

    return () => {
      try {
        window.GradeXPlayback.setRealDacState(false, false);
      } catch (_) {
        // no-op
      }
    };
  }, [isPlaybackActive, isRoomActive]);

  useEffect(() => {
    if (!isPlaybackActive) return undefined;

    const tryResumeAudio = () => {
      if (audioCtxRef.current?.state === 'suspended') {
        void getAudioCtx();
      }
    };

    document.addEventListener('resume', tryResumeAudio, false);
    document.addEventListener('visibilitychange', tryResumeAudio, false);
    window.addEventListener('focus', tryResumeAudio, false);
    return () => {
      document.removeEventListener('resume', tryResumeAudio, false);
      document.removeEventListener('visibilitychange', tryResumeAudio, false);
      window.removeEventListener('focus', tryResumeAudio, false);
    };
  }, [getAudioCtx, isPlaybackActive]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return undefined;

    const mediaSession = navigator.mediaSession;
    if (!isRoomActive) {
      mediaSession.playbackState = 'none';
      mediaSession.metadata = null;
      return undefined;
    }

    try {
      mediaSession.metadata = new window.MediaMetadata({
        title: displayTrackName,
        artist: 'RealDac',
        album: displayAlbumName,
        artwork: [
          { src: '/arc-reactor1.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        ],
      });
      mediaSession.playbackState = isPlaybackActive ? 'playing' : 'paused';
      mediaSession.setActionHandler('play', () => { void handlePlay(); });
      mediaSession.setActionHandler('pause', () => { handlePause(); });
      mediaSession.setActionHandler('seekto', (details) => {
        if (!Number.isFinite(details.seekTime)) return;
        commitSeek(details.seekTime * 1000);
      });
      mediaSession.setActionHandler('seekbackward', () => {
        commitSeek(Math.max(0, currentProgressMs - 10000));
      });
      mediaSession.setActionHandler('seekforward', () => {
        commitSeek(Math.min(trackDurationMs || currentProgressMs + 10000, currentProgressMs + 10000));
      });
    } catch (e) {
      warn('[RealDac] Media session setup failed:', e?.message || e);
    }

    if (typeof mediaSession.setPositionState === 'function' && trackDurationMs > 0) {
      try {
        mediaSession.setPositionState({
          duration: trackDurationMs / 1000,
          playbackRate: 1,
          position: Math.min(trackDurationMs / 1000, Math.max(0, currentProgressMs / 1000)),
        });
      } catch (_) {
        // no-op
      }
    }

    return () => {
      try {
        mediaSession.setActionHandler('play', null);
        mediaSession.setActionHandler('pause', null);
        mediaSession.setActionHandler('seekto', null);
        mediaSession.setActionHandler('seekbackward', null);
        mediaSession.setActionHandler('seekforward', null);
      } catch (_) {
        // no-op
      }
    };
  }, [commitSeek, currentProgressMs, displayAlbumName, displayTrackName, handlePlay, handlePause, isPlaybackActive, isRoomActive, trackDurationMs]);

  useEffect(() => {
    if (!isPlaying || countdown !== null) return undefined;

    let cancelled = false;
    let driftTimer = null;

    const runDriftCheck = async () => {
      if (cancelled) return;
      const playback = authoritativePlaybackRef.current;
      const local = localPlaybackRef.current;
      const ctx = audioCtxRef.current;

      refreshSyncProfile();
      const profile = syncProfileRef.current;

      if (!playback || playback.paused || !ctx || !currentSourceRef.current || local.track !== playback.track) {
        driftTimer = window.setTimeout(runDriftCheck, Math.max(700, profile.driftCheckMs || DRIFT_CHECK_INTERVAL_MS));
        return;
      }

      const serverNow = clientNow() + offsetRef.current;
      const expectedMs = Math.max(
        0,
        (playback.anchorOffsetSec || 0) * 1000 + Math.max(0, serverNow - playback.anchorStartedAtServerMs)
      );
      const actualMs = Math.max(
        0,
        (ctx.currentTime - local.startAtCtxTime) * 1000 + (local.startOffsetSec || 0) * 1000
      );
      const driftMs = expectedMs - actualMs;

      if (Math.abs(driftMs) < profile.driftIgnoreMs) {
        // Within ignore band → also relax any in-flight playbackRate nudge.
        const src = currentSourceRef.current;
        if (src && src.playbackRate) {
          try {
            src.playbackRate.cancelScheduledValues(ctx.currentTime);
            src.playbackRate.linearRampToValueAtTime(1, ctx.currentTime + 0.2);
          } catch {}
        }
        driftTimer = window.setTimeout(runDriftCheck, Math.max(700, profile.driftCheckMs || DRIFT_CHECK_INTERVAL_MS));
        return;
      }
      if (Date.now() - driftCorrectionAtRef.current < DRIFT_RESYNC_COOLDOWN_MS) {
        driftTimer = window.setTimeout(runDriftCheck, Math.max(700, profile.driftCheckMs || DRIFT_CHECK_INTERVAL_MS));
        return;
      }

      driftCorrectionAtRef.current = Date.now();
      const hardResync = Math.abs(driftMs) > profile.driftHardResyncMs;

      // SOFT correction: drift in (ignore, hard) → nudge playbackRate. This is
      // how broadcast-grade players (e.g. Twitch low-latency, HLS LL) hold
      // sync — inaudibly stretches/compresses time without re-anchoring.
      // A 1.5% rate change is ~26 cents of pitch shift; humans can't detect
      // drift correction below ~30 cents in dense audio content like music.
      if (!hardResync) {
        const src = currentSourceRef.current;
        if (src && src.playbackRate && typeof src.playbackRate.setValueAtTime === 'function') {
          // driftMs > 0 → we're BEHIND the server clock → speed up.
          // Correction window: pull the drift back over ~4s.
          const CORRECTION_WINDOW_MS = 4000;
          const MAX_RATE_DELTA = 0.015; // ±1.5% — inaudible pitch shift on music
          const desiredRate = 1 + driftMs / CORRECTION_WINDOW_MS;
          const rate = Math.max(1 - MAX_RATE_DELTA, Math.min(1 + MAX_RATE_DELTA, desiredRate));
          try {
            const now = ctx.currentTime;
            src.playbackRate.cancelScheduledValues(now);
            src.playbackRate.setValueAtTime(src.playbackRate.value, now);
            src.playbackRate.linearRampToValueAtTime(rate, now + 0.1);
            // Ease back to 1.0 once we've consumed the drift.
            src.playbackRate.linearRampToValueAtTime(1, now + CORRECTION_WINDOW_MS / 1000);
            setSyncPhase('resyncing');
            log(`[RealDac] Soft drift correction: ${driftMs.toFixed(1)}ms → rate ${rate.toFixed(4)}`);
            // Briefly indicate, then settle back.
            window.setTimeout(() => setSyncPhase('live'), Math.max(500, CORRECTION_WINDOW_MS - 500));
            driftTimer = window.setTimeout(runDriftCheck, Math.max(700, profile.driftCheckMs || DRIFT_CHECK_INTERVAL_MS));
            return;
          } catch (e) {
            warn('[RealDac] playbackRate nudge failed, falling back to hard resync:', e?.message);
            // Fall through to the hard-resync path below.
          }
        }
      }

      // HARD resync: drift exceeded threshold (or no source available)
      // → re-anchor by scheduling a fresh start. This is audible (small gap)
      // but only fires for big drifts that can't be hidden via rate.
      const leadMs = hardResync ? profile.catchupLeadMs : profile.seekLeadMs;
      const correctedOffsetSec = Math.max(0, expectedMs / 1000 + leadMs / 1000);

      try {
        setRoomStatus(hardResync ? 'Re-syncing…' : 'Tightening sync…');
        setSyncPhase('resyncing');
        await schedulePlay(
          playback.track,
          serverNow + leadMs,
          correctedOffsetSec,
          {
            force: true,
            generation: playback.generation,
            anchorStartedAtServerMs: playback.anchorStartedAtServerMs,
            authoritativeAnchorOffsetSec: playback.anchorOffsetSec || 0,
            status: hardResync ? 'Re-syncing…' : 'Live',
          }
        );
      } catch (e) {
        console.error('[RealDac] Drift correction failed:', e);
      }

      driftTimer = window.setTimeout(runDriftCheck, Math.max(700, profile.driftCheckMs || DRIFT_CHECK_INTERVAL_MS));
    };

    runDriftCheck();
    return () => {
      cancelled = true;
      if (driftTimer) clearTimeout(driftTimer);
    };
  }, [countdown, isPlaying, refreshSyncProfile, schedulePlay]);

  /* Build derived view-state pieces (kept compatible with existing handlers/state) */
  const showPause = Boolean(shouldShowPauseButton);
  const elapsedLabel = formatTime(currentProgressMs);
  const remainingLabel = formatTime(remainingMs);
  const safeParticipants = Math.max(0, Number(participants) || 0);
  const avatarMaxVisible = 4;
  const overflowCount = Math.max(0, safeParticipants - avatarMaxVisible);
  const avatarSeeds = Array.from({ length: Math.min(safeParticipants, avatarMaxVisible) }, (_, i) => i);

  return (
    <div className="realdac-page">
      {/* Countdown overlay (sync 3-2-1-0) */}
      {countdown !== null && (
        <div className="rd-countdown" role="status" aria-live="assertive">
          <div className="rd-countdown-digit">{countdown}</div>
          <div className="rd-countdown-sub">{countdown === 0 ? 'Go' : 'Syncing'}</div>
        </div>
      )}

      {/* ───────── Top bar ───────── */}
      <header className="rd-topbar">
        <div className="rd-topbar-left">
          <div className="rd-brand">
            <span className="rd-brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none">
                <circle cx="12" cy="12" r="3" fill="currentColor" />
                <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth="1.5" opacity="0.45" />
                <circle cx="12" cy="12" r="10.5" stroke="currentColor" strokeWidth="1" opacity="0.2" />
              </svg>
            </span>
            <span className="rd-brand-name">RealDac</span>
            {screen !== 'room' && <span className="rd-brand-tag">console</span>}
          </div>

          {screen === 'room' && roomCode && (
            <>
              <span className="rd-topbar-divider" aria-hidden="true" />
              <button
                type="button"
                className="rd-codechip"
                onClick={() => void copyToClipboard(roomCode, 'Room code copied')}
                title="Click to copy room code"
                aria-label={`Room code ${roomCode}, click to copy`}
              >
                <span className="rd-codechip-label">Room</span>
                <span className="rd-codechip-code">{String(roomCode).replace(/^(\d{3})(\d{3})$/, '$1 $2')}</span>
                <span className="rd-codechip-icon" aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="5" y="5" width="9" height="9" rx="1.6" />
                    <path d="M3 11H2.5A.5.5 0 0 1 2 10.5V2.5A.5.5 0 0 1 2.5 2h8a.5.5 0 0 1 .5.5V3" />
                  </svg>
                </span>
              </button>
            </>
          )}
        </div>

        <div className="rd-topbar-right">
          <span
            className={`rd-syncpill rd-syncpill--${syncBadge.toneKey || 'standby'}`}
            title={syncBadge.detail}
            role="status"
            aria-live="polite"
          >
            <span className="rd-syncpill-dot" />
            <span className="rd-syncpill-label">{syncBadge.label}</span>
          </span>

          {screen === 'room' && (
            <>
              <button
                type="button"
                className="rd-btn rd-btn--primary"
                onClick={() => void handleShareInvite()}
                title="Share invite"
              >
                <TechIcon size={14} strokeWidth={2}>
                  <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
                  <path d="M16 6l-4-4-4 4" />
                  <path d="M12 2v13" />
                </TechIcon>
                Invite
              </button>
              <button
                type="button"
                className="rd-btn rd-btn--danger"
                onClick={handleLeave}
                title="Leave room"
              >
                <TechIcon size={14} strokeWidth={2}>
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <path d="M16 17l5-5-5-5" />
                  <path d="M21 12H9" />
                </TechIcon>
                Leave
              </button>
            </>
          )}
        </div>
      </header>

      {/* ───────── Connecting state (URL has a code, auto-join in flight) ───────── */}
      {screen === 'join' && urlRoomCode && (
        <section className="rd-fallback rd-fallback--connecting" aria-busy="true">
          <div className="rd-fallback-disc" aria-hidden="true">
            <div className="rd-disc-rings" />
          </div>
          <h2>Joining room {urlRoomCode}</h2>
          <p>{joinStatus || (socketConnected ? 'Syncing with the room…' : 'Connecting to the server…')}</p>
          {joinStatus && /not found|error|failed/i.test(joinStatus) && (
            <a href="/" className="rd-btn rd-btn--lg" style={{ textDecoration: 'none', marginTop: 'var(--space-2)' }}>
              ← Back to entry
            </a>
          )}
        </section>
      )}

      {/* ───────── Manual fallback (no URL code — direct hit on /app) ───────── */}
      {screen === 'join' && !urlRoomCode && (
        <section className="rd-fallback">
          <h2>Start or join a room</h2>
          <p>Head back to the entry to create a fresh room or paste a 6-digit code.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', width: '100%', maxWidth: 280 }}>
            <input
              type="text"
              placeholder="000000"
              maxLength={6}
              inputMode="numeric"
              value={inputCode}
              onChange={(e) => setInputCode(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
              className="rd-select"
              style={{ textAlign: 'center', fontFamily: "'JetBrains Mono', monospace", fontSize: 18, letterSpacing: '0.32em' }}
              aria-label="Room code"
            />
            {joinStatus && <p style={{ margin: 0, fontSize: 12, color: 'var(--danger)' }}>{joinStatus}</p>}
            <button className="rd-btn rd-btn--primary rd-btn--lg" onClick={handleJoin} disabled={!socketConnected}>
              Join room
            </button>
            <button className="rd-btn rd-btn--lg" onClick={handleCreate} disabled={!socketConnected}>
              Create new room
            </button>
            <a href="/" className="rd-btn rd-btn--lg" style={{ textDecoration: 'none' }}>
              ← Back to entry
            </a>
          </div>
        </section>
      )}

      {/* ───────── Room (3-panel layout) ───────── */}
      {screen === 'room' && (
        <section className="rd-room">
          {/* ─── Now-playing card ─── */}
          <article className="rd-card rd-now">
            {awaitingTap && (
              <button
                type="button"
                className="rd-tap-overlay"
                onClick={() => { /* listener in effect handles it */ }}
                aria-label="Tap to start listening"
              >
                <span className="rd-tap-overlay-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </span>
                <span className="rd-tap-overlay-text">
                  <strong>Tap to start</strong>
                  <small>Catch up to live playback</small>
                </span>
              </button>
            )}
            <div className={`rd-disc ${isPlaying ? 'is-playing' : ''}`} aria-hidden="true">
              <div className="rd-disc-rings" />
            </div>

            <div className="rd-track-meta" ref={trackPickerRef}>
              <button
                type="button"
                className={`rd-track-trigger ${trackPickerOpen ? 'is-open' : ''}`}
                onClick={() => setTrackPickerOpen((v) => !v)}
                aria-haspopup="listbox"
                aria-expanded={trackPickerOpen}
                title="Change track"
                disabled={tracks.length <= 1}
              >
                <span className="rd-track-title">{displayTrackName || 'Untitled track'}</span>
                {tracks.length > 1 && (
                  <span className="rd-track-chevron" aria-hidden="true">
                    <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2.5 4.5L6 8l3.5-3.5" />
                    </svg>
                  </span>
                )}
              </button>

              <div className="rd-track-sub">
                <span className="rd-track-sub-album">{displayAlbumName || '—'}</span>
                <span className="rd-track-sub-dot">·</span>
                <span>{syncBadge.detail || (isPlaying ? 'Playing in sync' : 'Ready')}</span>
              </div>

              {trackPickerOpen && tracks.length > 1 && (
                <div className="rd-track-popover" role="listbox" aria-label="Tracks in this album">
                  <div className="rd-track-popover-head">
                    <span className="rd-track-popover-label">Tracks</span>
                    <span className="rd-track-popover-count">{tracks.length}</span>
                  </div>
                  <ul className="rd-track-list">
                    {tracks.map((t, i) => {
                      const active = t.id === selectedTrack;
                      return (
                        <li key={t.id}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={active}
                            className={`rd-track-item ${active ? 'is-active' : ''}`}
                            onClick={() => {
                              setSelectedTrack(t.id);
                              setTrackPickerOpen(false);
                              if (roomCode) {
                                const tn = t.name;
                                syncTrackToConvex(roomCode, t.id, selectedAlbum, tn);
                              }
                            }}
                          >
                            <span className="rd-track-item-num">{String(i + 1).padStart(2, '0')}</span>
                            <span className="rd-track-item-name">{toProperCase(t.name)}</span>
                            {active && (
                              <span className="rd-track-item-active" aria-hidden="true">
                                <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M3 7l3 3 5-6" />
                                </svg>
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>

            <div className="rd-progress">
              <div className="rd-progress-times">
                <span>{elapsedLabel}</span>
                <span>{remainingLabel}</span>
              </div>
              <input
                type="range"
                min={0}
                max={Math.max(0, trackDurationMs)}
                step={250}
                value={Math.min(currentProgressMs, trackDurationMs || 0)}
                disabled={!canSeek}
                className="rd-range"
                style={{ '--range-progress': `${progressPercent}%` }}
                onPointerDown={() => setIsSeeking(true)}
                onChange={(e) => setSeekPreviewMs(Number(e.target.value))}
                onPointerUp={(e) => {
                  const nextMs = Number(e.currentTarget.value);
                  setIsSeeking(false);
                  setSeekPreviewMs(nextMs);
                  commitSeek(nextMs);
                }}
                onKeyUp={(e) => {
                  const nextMs = Number(e.currentTarget.value);
                  setIsSeeking(false);
                  setSeekPreviewMs(nextMs);
                  commitSeek(nextMs);
                }}
                aria-label="Playback position"
              />
            </div>

            <div className="rd-transport">
              <button
                className="rd-tbtn"
                onClick={() => void stepTrack(-1)}
                disabled={!hasPrevTrack}
                title="Previous track"
                aria-label="Previous track"
              >
                <TechIcon size={16} strokeWidth={0}>
                  <path d="M11 19L3 12l8-7v14z" fill="currentColor" stroke="none" />
                  <path d="M21 19l-8-7 8-7v14z" fill="currentColor" stroke="none" />
                </TechIcon>
              </button>

              {showPause ? (
                <button
                  className="rd-playbtn"
                  onClick={handlePause}
                  title="Pause room playback"
                  aria-label="Pause"
                >
                  <TechIcon size={24} strokeWidth={0}>
                    <rect x="7" y="5" width="4" height="14" rx="1.4" fill="currentColor" />
                    <rect x="13" y="5" width="4" height="14" rx="1.4" fill="currentColor" />
                  </TechIcon>
                </button>
              ) : (
                <button
                  className="rd-playbtn"
                  onClick={handlePlay}
                  disabled={!socketConnected || loadingAudio || playButtonLocked || countdown !== null || syncPhase === 'preparing'}
                  title="Start synchronized playback"
                  aria-label="Play"
                >
                  <TechIcon size={22} strokeWidth={0}>
                    <path d="M8 6l10 6-10 6z" fill="currentColor" />
                  </TechIcon>
                </button>
              )}

              <button
                className="rd-tbtn"
                onClick={() => void stepTrack(1)}
                disabled={!hasNextTrack}
                title="Next track"
                aria-label="Next track"
              >
                <TechIcon size={16} strokeWidth={0}>
                  <path d="M13 19l8-7-8-7v14z" fill="currentColor" stroke="none" />
                  <path d="M3 19l8-7-8-7v14z" fill="currentColor" stroke="none" />
                </TechIcon>
              </button>
            </div>

            <div className="rd-readout">
              <span>{syncMetaLabel || 'Anchor locked'}</span>
              <span className="rd-readout-sep">·</span>
              <span>{canSeek ? 'Drag to seek' : 'Press play to begin'}</span>
            </div>
          </article>

          {/* ─── Sidebar stack ─── */}
          <aside className="rd-side">
            {/* Roster + Invite */}
            <div className="rd-card rd-card-pad">
              <div className="rd-card-title">Roster & Invite</div>
              <div className="rd-roster">
                <div className="rd-roster-meta">
                  <div className="rd-avatars" aria-label={`${safeParticipants} listeners`}>
                    {avatarSeeds.map((i) => {
                      const hues = [188, 200, 210, 175, 220];
                      const hue = hues[i % hues.length];
                      const initials = ['LA', 'LB', 'LC', 'LD', 'LE'][i] || 'L' + (i + 1);
                      return (
                        <span
                          key={i}
                          className="rd-av"
                          style={{
                            background: `linear-gradient(180deg, hsl(${hue} 70% 28%), hsl(${hue} 60% 18%))`,
                            color: `hsl(${hue} 90% 88%)`,
                          }}
                          title={`Listener ${i + 1}`}
                        >
                          {initials}
                        </span>
                      );
                    })}
                    {overflowCount > 0 && (
                      <span className="rd-av rd-av--more">+{overflowCount}</span>
                    )}
                    {safeParticipants === 0 && (
                      <span className="rd-av rd-av--more" style={{ marginLeft: 0 }}>—</span>
                    )}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="rd-roster-count">
                      <strong>{safeParticipants}</strong>
                      {safeParticipants === 1 ? 'listener' : 'listeners'}
                    </div>
                    <div className="rd-roster-detail">{readinessLabel}</div>
                  </div>
                </div>

                {qrDataUrl ? (
                  <div className="rd-qr">
                    <img src={qrDataUrl} alt={`Scan to join room ${roomCode}`} style={{ width: 152, height: 152 }} />
                    <span className="rd-qr-hint">Scan to join</span>
                  </div>
                ) : (
                  <div className="rd-qr" style={{ minHeight: 152, alignItems: 'center', justifyContent: 'center', background: 'var(--surface-1)', color: 'var(--ink-faint)', fontSize: 12 }}>
                    Generating QR…
                  </div>
                )}

                <div className="rd-field">
                  <span className="rd-field-label">Invite link</span>
                  <span className="rd-link">{inviteUrl}</span>
                  <button
                    type="button"
                    className="rd-btn rd-btn--lg"
                    onClick={() => void copyToClipboard(inviteUrl, 'Invite link copied')}
                  >
                    <TechIcon size={14} strokeWidth={1.8}>
                      <path d="M15 7h3a5 5 0 0 1 0 10h-3" />
                      <path d="M9 17H6A5 5 0 0 1 6 7h3" />
                      <path d="M8 12h8" />
                    </TechIcon>
                    {linkCopied ? 'Copied' : 'Copy invite link'}
                  </button>
                </div>
              </div>
            </div>

            {/* Library */}
            <div className="rd-card rd-card-pad">
              <div className="rd-card-title">Library</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                {albums.length > 1 && (
                  <div className="rd-field">
                    <span className="rd-field-label">Album</span>
                    <select
                      value={selectedAlbum}
                      onChange={(e) => {
                        const albumId = e.target.value;
                        setSelectedAlbum(albumId);
                        const album = albums.find((a) => a.id === albumId);
                        const trackId = album?.songs?.[0]?.id;
                        if (trackId) setSelectedTrack(trackId);
                        if (roomCode) {
                          const t = trackId ?? selectedTrack;
                          const tn = album?.songs?.find((s) => s.id === t)?.name || tracks.find((x) => x.id === t)?.name;
                          syncTrackToConvex(roomCode, t, albumId, tn);
                        }
                      }}
                      className="rd-select"
                    >
                      {albums.map((a) => (
                        <option key={a.id} value={a.id}>{toProperCase(a.name)}</option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="rd-field">
                  <span className="rd-field-label">Track</span>
                  <p className="rd-field-hint">
                    Tap the song name above the disc to switch tracks.
                  </p>
                </div>

                <div className="rd-field">
                  <div className="rd-volume-row">
                    <span className="rd-field-label" style={{ margin: 0 }}>Volume</span>
                    <span className="rd-volume-value">{Math.round(volume * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={volume}
                    onChange={(e) => setVolume(Number(e.target.value))}
                    className="rd-range"
                    style={{ '--range-progress': `${Math.round(volume * 100)}%` }}
                    aria-label="Volume"
                  />
                </div>
              </div>
            </div>
          </aside>
        </section>
      )}

      {/* Subtle status toast for non-critical messages */}
      {statusMessage && screen === 'room' && (
        <div className="rd-toast" role="status" aria-live="polite">{statusMessage}</div>
      )}
    </div>
  );
}
