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
import QRCode from 'qrcode';
import { log, warn } from '../lib/logger';

const DEFAULT_REALDAC_TRACK = '/realdac-songs/honey-singh/blue-eyes.mp3';
const DEFAULT_REALDAC_ALBUM_ID = 'honey-singh';
const FALLBACK_ALBUM = {
  id: DEFAULT_REALDAC_ALBUM_ID,
  name: 'Honey Singh',
  songs: [{ id: DEFAULT_REALDAC_TRACK, name: 'blue eyes' }],
};
const COUNTDOWN_SEC = 3;
const TIME_SYNC_SAMPLES = 3;
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
      syncSamples: 4,
      syncTimeoutMs: 6500,
      syncSampleGapMs: 80,
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
      syncSamples: Math.max(profile.syncSamples, 5),
      syncTimeoutMs: Math.max(profile.syncTimeoutMs, 7000),
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
      syncSamples: Math.max(profile.syncSamples, 5),
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
    fetch('/api/realdac/songs')
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

  const roomState = useQuery(
    roomCode ? api.realdacRooms.getByRoomCode : 'skip',
    roomCode ? { roomCode } : 'skip'
  );
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
          const clientSend = Date.now();
          socket.emit('TIME_SYNC_REQ', clientSend, (data) => {
            clearTimeout(timeout);
            const clientRecv = Date.now();
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
      samples.sort((a, b) => a.offset - b.offset);
      const trimmed = samples.length > 3 ? samples.slice(1, -1) : samples;
      const totalOffset = trimmed.reduce((sum, sample) => sum + sample.offset, 0);
      const averageOffset = totalOffset / trimmed.length;
      const jitterMs = trimmed.length > 1
        ? Math.max(...trimmed.map((sample) => Math.abs(sample.offset - averageOffset)))
        : Math.max(0, trimmed[0]?.rtt ?? 0);

      offsetRef.current = averageOffset;
      timeSyncQualityRef.current = {
        jitterMs,
        sampleCount: trimmed.length,
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
      const serverNow = Date.now() + offsetRef.current;
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
    const delayMs = Math.max(0, playAtClient - Date.now());
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
        setRoomStatus('Load failed');
        setSyncPhase('idle');
        setLoadingAudio(false);
        return;
      }
      setLoadingAudio(false);
    }

    const serverNow = Date.now() + offsetRef.current;
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
    const serverNow = Date.now() + offsetRef.current;
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
    const socket = io({
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
        const serverNow = Date.now() + offsetRef.current;
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
      offsetRef.current = serverTime - Date.now();
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
    setLoadingAudio(true);
    setSelectedTrack(trackToLoad);
    setSelectedAlbum(albumToUse);
    
    try {
      await getAudioCtx();
      const buffer = await loadBuffer(trackToLoad);
      setTrackDurationMs(buffer.duration * 1000);
      setRoomStatus('Ready');
    } catch (e) {
      console.error('[RealDac] Failed to load initial track:', e);
      setRoomStatus('Load failed - tap Play to retry');
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
          setRoomStatus('Load failed - try again');
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

      const serverNow = Date.now() + offsetRef.current;
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

      const serverNow = Date.now() + offsetRef.current;

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
    if (reconnecting) return { label: 'RE-LINKING', tone: '#f59e0b', detail: 'Recovering room state' };
    if (countdown !== null) return { label: `START ${countdown}`, tone: '#00f2ff', detail: 'Commit received' };
    if (loadingAudio || syncPhase === 'preparing') return { label: 'BUFFERING', tone: '#00f2ff', detail: 'Loading current track' };
    if (syncPhase === 'resyncing') return { label: 'SYNCING', tone: '#10b981', detail: 'Tightening drift' };
    if (syncPhase === 'paused') return { label: 'PAUSED', tone: '#94a3b8', detail: 'Room playback stopped' };
    if (isPlaying) return { label: 'SYNC LOCK', tone: '#10b981', detail: 'Room playback stable' };
    return { label: 'STANDBY', tone: '#64748b', detail: 'Awaiting command' };
  })();
  const readinessLabel = `${participants} ${participants === 1 ? 'listener online' : 'listeners online'}`;
  const artFrameLabel = `${roomCode || '000000'} // ${displayAlbumName}`.toUpperCase();

  // Progress: elapsed since play started (approximate, synced via server time)
  useEffect(() => {
    if (!isPlaying || countdown !== null) return;
    const tick = () => {
      const elapsed = Date.now() + offsetRef.current - playStartTimeRef.current;
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

      const serverNow = Date.now() + offsetRef.current;
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
        driftTimer = window.setTimeout(runDriftCheck, Math.max(700, profile.driftCheckMs || DRIFT_CHECK_INTERVAL_MS));
        return;
      }
      if (Date.now() - driftCorrectionAtRef.current < DRIFT_RESYNC_COOLDOWN_MS) {
        driftTimer = window.setTimeout(runDriftCheck, Math.max(700, profile.driftCheckMs || DRIFT_CHECK_INTERVAL_MS));
        return;
      }

      driftCorrectionAtRef.current = Date.now();
      const hardResync = Math.abs(driftMs) > profile.driftHardResyncMs;
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

  return (
    <div className="realdac-page" style={{
      width: '100%',
      maxWidth: screen === 'room' ? '1360px' : '1200px',
      margin: '0 auto',
      padding: screen === 'room' ? 'clamp(10px, 3vw, 24px)' : 'clamp(16px, 4vw, 32px)',
      minHeight: screen === 'room' ? '100dvh' : '100vh',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: screen === 'room' ? 'center' : 'flex-start',
      boxSizing: 'border-box',
      background: 'transparent',
    }}>
      <style>{`
        @keyframes realdacCountdown {
          0% { transform: scale(0.3); opacity: 0; }
          15% { transform: scale(1.15); opacity: 1; }
          30% { transform: scale(1); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
        .realdac-countdown-digit { animation: realdacCountdown 0.5s ease-out; }
        @keyframes livePulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .realdac-page .realdac-card {
          background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02));
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 4px;
          box-shadow: 0 18px 48px rgba(0,0,0,0.22);
          transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
        }
        .realdac-page .realdac-card:hover { border-color: rgba(255,255,255,0.16); transform: translateY(-1px); }
        .realdac-page input:focus, .realdac-page select:focus { outline: none; border-color: var(--text-tertiary); box-shadow: 0 0 0 2px rgba(255,255,255,0.08); }
        .realdac-page .realdac-room-shell {
          position: relative;
          border-radius: 4px;
          padding: clamp(14px, 2.4vw, 22px);
          background:
            radial-gradient(circle at top center, rgba(0, 242, 255, 0.10), transparent 32%),
            linear-gradient(180deg, rgba(17, 20, 23, 0.98), rgba(8, 10, 12, 0.98));
          border: 1px solid rgba(0, 242, 255, 0.12);
          overflow: hidden;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.04), 0 26px 80px rgba(0,0,0,0.45);
          max-height: calc(100dvh - 24px);
        }
        .realdac-page .realdac-room-shell::before {
          content: '';
          position: absolute;
          inset: 0;
          pointer-events: none;
          background-image:
            linear-gradient(rgba(0, 242, 255, 0.04) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0, 242, 255, 0.04) 1px, transparent 1px);
          background-size: 44px 44px;
          mask-image: linear-gradient(180deg, rgba(0,0,0,0.45), transparent 70%);
        }
        .realdac-page .realdac-room-stage {
          display: grid;
          grid-template-columns: minmax(0, 1.32fr) minmax(260px, 0.68fr);
          gap: 18px;
          align-items: start;
          position: relative;
          z-index: 1;
        }
        .realdac-page .realdac-tech-panel {
          position: relative;
          padding: clamp(14px, 2.2vw, 22px);
          border-radius: 4px;
          background:
            linear-gradient(180deg, rgba(28, 31, 35, 0.96), rgba(11, 12, 14, 0.96));
          border: 1px solid rgba(0, 242, 255, 0.12);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.03), 0 16px 48px rgba(0,0,0,0.32);
          overflow: hidden;
        }
        .realdac-page .realdac-tech-panel::after {
          content: '';
          position: absolute;
          inset: 10px;
          border: 1px solid rgba(0, 242, 255, 0.06);
          border-radius: 4px;
          pointer-events: none;
        }
        .realdac-page .realdac-tech-chip {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 6px 10px;
          border-radius: 4px;
          border: 1px solid rgba(0, 242, 255, 0.14);
          background: rgba(10, 16, 19, 0.88);
          color: #dffcff;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
        }
        .realdac-page .realdac-tech-chip-muted {
          color: rgba(229, 226, 227, 0.68);
          border-color: rgba(58, 73, 75, 0.42);
          background: rgba(15, 16, 18, 0.78);
        }
        .realdac-page .realdac-console-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 14px;
        }
        .realdac-page .realdac-console-brand {
          display: flex;
          align-items: center;
          gap: 12px;
          min-width: 0;
        }
        .realdac-page .realdac-console-kicker {
          font-size: 9px;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: rgba(0, 242, 255, 0.9);
          font-weight: 700;
          margin-bottom: 2px;
        }
        .realdac-page .realdac-console-title {
          font-family: 'AmericanCaptain', 'Bebas Neue', sans-serif;
          font-size: clamp(24px, 3.2vw, 34px);
          letter-spacing: 0.10em;
          color: var(--text-primary);
          line-height: 0.95;
        }
        .realdac-page .realdac-console-meta {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          flex-wrap: wrap;
          gap: 8px;
        }
        .realdac-page .realdac-panel-button {
          width: 42px;
          height: 42px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 4px;
          border: 1px solid rgba(58, 73, 75, 0.62);
          background: rgba(10, 13, 15, 0.92);
          color: rgba(229, 226, 227, 0.86);
          cursor: pointer;
          transition: transform 0.18s ease, border-color 0.18s ease, color 0.18s ease, background 0.18s ease;
        }
        .realdac-page .realdac-panel-button:hover:not(:disabled) {
          transform: translateY(-1px);
          border-color: rgba(0, 242, 255, 0.32);
          color: #dffcff;
        }
        .realdac-page .realdac-panel-button:disabled {
          opacity: 0.35;
          cursor: not-allowed;
        }
        .realdac-page .realdac-tech-art {
          position: relative;
          width: min(100%, clamp(240px, 30vh, 340px));
          aspect-ratio: 1 / 1;
          margin: 0 auto 14px;
          border-radius: 4px;
          overflow: hidden;
          background:
            radial-gradient(circle at 50% 46%, rgba(0, 242, 255, 0.20), transparent 16%),
            radial-gradient(circle at 50% 50%, rgba(255, 59, 48, 0.10), transparent 30%),
            linear-gradient(180deg, rgba(7, 10, 12, 0.94), rgba(13, 16, 19, 0.98));
          border: 1px solid rgba(0, 242, 255, 0.18);
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.03), 0 32px 72px rgba(0,0,0,0.42);
        }
        .realdac-page .realdac-tech-art::before,
        .realdac-page .realdac-tech-art::after {
          content: '';
          position: absolute;
          inset: 14px;
          border-radius: 4px;
          border: 1px solid rgba(0, 242, 255, 0.08);
        }
        .realdac-page .realdac-tech-art::after {
          inset: auto 14px 14px 14px;
          height: 24%;
          background: linear-gradient(180deg, transparent, rgba(6, 8, 10, 0.92));
          border: none;
          border-radius: 0 0 4px 4px;
        }
        .realdac-page .realdac-tech-art-grid {
          position: absolute;
          inset: 0;
          background-image:
            linear-gradient(rgba(0, 242, 255, 0.06) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0, 242, 255, 0.05) 1px, transparent 1px);
          background-size: 34px 34px;
          mask-image: radial-gradient(circle at center, rgba(0,0,0,0.55), transparent 72%);
          opacity: 0.72;
        }
        .realdac-page .realdac-tech-art-core {
          position: absolute;
          left: 50%;
          top: 50%;
          width: 54%;
          height: 54%;
          transform: translate(-50%, -54%);
          border-radius: 50%;
          border: 1px solid rgba(0, 242, 255, 0.18);
          box-shadow: 0 0 0 14px rgba(0, 242, 255, 0.04), 0 0 40px rgba(0, 242, 255, 0.18);
        }
        .realdac-page .realdac-tech-art-core::before,
        .realdac-page .realdac-tech-art-core::after {
          content: '';
          position: absolute;
          inset: 14%;
          border-radius: 50%;
          border: 1px solid rgba(0, 242, 255, 0.24);
        }
        .realdac-page .realdac-tech-art-core::after {
          inset: 28%;
          border-color: rgba(255, 59, 48, 0.18);
          box-shadow: 0 0 24px rgba(255, 59, 48, 0.14);
        }
        .realdac-page .realdac-tech-art-logo {
          position: absolute;
          inset: 20%;
          width: 60%;
          height: 60%;
          object-fit: contain;
          opacity: 0.2;
          filter: hue-rotate(170deg) saturate(1.2) brightness(1.05);
        }
        .realdac-page .realdac-tech-art-label,
        .realdac-page .realdac-tech-art-footer {
          position: absolute;
          left: 18px;
          right: 18px;
          z-index: 2;
        }
        .realdac-page .realdac-tech-art-label {
          top: 18px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
        }
        .realdac-page .realdac-tech-art-footer {
          bottom: 18px;
          display: flex;
          align-items: center;
          justify-content: flex-start;
          gap: 10px;
        }
        .realdac-page .realdac-tech-code {
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: rgba(223, 252, 255, 0.78);
        }
        .realdac-page .realdac-tech-tag {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 5px 9px;
          border-radius: 4px;
          background: rgba(6, 9, 10, 0.88);
          border: 1px solid rgba(0, 242, 255, 0.15);
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: #dffcff;
        }
        .realdac-page .realdac-hud-title {
          font-family: 'Space Grotesk', system-ui, sans-serif;
          font-size: clamp(24px, 2.4vw, 30px);
          font-weight: 800;
          line-height: 1.02;
          color: var(--text-primary);
          margin: 0 0 4px;
        }
        .realdac-page .realdac-hud-subtitle {
          font-family: 'Space Grotesk', system-ui, sans-serif;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-wrap: wrap;
          gap: 6px;
          font-size: 13px;
          color: rgba(223, 252, 255, 0.82);
          margin-bottom: 12px;
        }
        .realdac-page .realdac-progress-shell {
          margin-bottom: 16px;
          padding: 12px 14px;
          border-radius: 4px;
          background: rgba(8, 11, 12, 0.84);
          border: 1px solid rgba(58, 73, 75, 0.32);
        }
        .realdac-page .realdac-progress-meta {
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
          gap: 12px;
          margin-bottom: 8px;
        }
        .realdac-page .realdac-time-cluster {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .realdac-page .realdac-time-value {
          font-family: 'Space Grotesk', system-ui, sans-serif;
          font-size: 11px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          color: rgba(229, 226, 227, 0.84);
        }
        .realdac-page .realdac-time-label {
          font-size: 8px;
          text-transform: uppercase;
          letter-spacing: 0.16em;
          color: rgba(137, 160, 166, 0.72);
        }
        .realdac-page .realdac-range {
          height: 6px;
          background: linear-gradient(90deg, #00c8d6 0%, #00c8d6 var(--range-progress, 0%), rgba(58,73,75,0.55) var(--range-progress, 0%), rgba(58,73,75,0.55) 100%);
        }
        .realdac-page .realdac-range::-webkit-slider-thumb {
          width: 16px;
          height: 16px;
          background: #dffcff;
          box-shadow: 0 0 0 4px rgba(0, 242, 255, 0.18), 0 0 18px rgba(0, 242, 255, 0.22);
        }
        .realdac-page .realdac-range::-moz-range-thumb {
          width: 16px;
          height: 16px;
          background: #dffcff;
          box-shadow: 0 0 0 4px rgba(0, 242, 255, 0.18), 0 0 18px rgba(0, 242, 255, 0.22);
        }
        .realdac-page .realdac-tech-readout {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          margin-top: 8px;
          font-size: 9px;
          text-transform: uppercase;
          letter-spacing: 0.14em;
          color: rgba(137, 160, 166, 0.85);
        }
        .realdac-page .realdac-tech-controls {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          margin-bottom: 14px;
          flex-wrap: wrap;
        }
        .realdac-page .realdac-reactor-button {
          width: 68px;
          height: 52px;
          border-radius: 4px;
          border: 1px solid rgba(0, 242, 255, 0.24);
          background: linear-gradient(180deg, rgba(13, 17, 19, 0.98), rgba(7, 10, 12, 0.98));
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: #e6fdff;
          cursor: pointer;
          transition: transform 0.18s ease, border-color 0.18s ease, background 0.18s ease, color 0.18s ease;
        }
        .realdac-page .realdac-reactor-button:hover:not(:disabled) {
          transform: translateY(-1px);
          border-color: rgba(0, 242, 255, 0.36);
          background: linear-gradient(180deg, rgba(16, 21, 24, 0.98), rgba(8, 11, 13, 0.98));
          color: #ffffff;
        }
        .realdac-page .realdac-reactor-button:disabled {
          opacity: 0.42;
          cursor: not-allowed;
        }
        .realdac-page .realdac-diagnostics {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 10px 12px;
          margin-bottom: 14px;
          border-radius: 4px;
          background: rgba(6, 9, 10, 0.86);
          border: 1px solid rgba(58, 73, 75, 0.32);
          flex-wrap: wrap;
        }
        .realdac-page .realdac-diagnostics-users {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .realdac-page .realdac-user-pip {
          width: 22px;
          height: 22px;
          border-radius: 4px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 9px;
          font-weight: 800;
          color: #dffcff;
          background: rgba(0, 242, 255, 0.12);
          border: 1px solid rgba(0, 242, 255, 0.2);
        }
        .realdac-page .realdac-action-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px;
        }
        .realdac-page .realdac-command-button {
          min-height: 70px;
          border-radius: 4px;
          border: 1px solid rgba(58, 73, 75, 0.34);
          background: linear-gradient(180deg, rgba(14, 17, 19, 0.96), rgba(9, 10, 12, 0.98));
          color: var(--text-primary);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 5px;
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.10em;
          text-transform: uppercase;
          cursor: pointer;
          transition: transform 0.18s ease, border-color 0.18s ease, color 0.18s ease;
        }
        .realdac-page .realdac-command-button:hover {
          transform: translateY(-1px);
          border-color: rgba(0, 242, 255, 0.22);
          color: #dffcff;
        }
        .realdac-page .realdac-command-button-danger {
          color: #ff8d84;
          border-color: rgba(255, 59, 48, 0.28);
        }
        .realdac-page .realdac-sidebar-stack {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .realdac-page .realdac-mobile-room-access {
          display: none;
        }
        .realdac-page .realdac-sidebar-title {
          font-size: 9px;
          text-transform: uppercase;
          letter-spacing: 0.16em;
          color: rgba(0, 242, 255, 0.86);
          font-weight: 700;
          margin-bottom: 8px;
        }
        .realdac-page .realdac-muted-readout {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 6px 10px;
          border-radius: 4px;
          background: rgba(8, 11, 12, 0.78);
          border: 1px solid rgba(58, 73, 75, 0.30);
          color: rgba(223, 252, 255, 0.74);
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
        }
        .realdac-page .realdac-sidebar-block {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .realdac-page .realdac-input-shell {
          width: 100%;
          padding: 10px 12px;
          font-size: 12px;
          border-radius: 4px;
          border: 1px solid rgba(58, 73, 75, 0.42);
          background: rgba(8, 11, 12, 0.82);
          color: var(--text-primary);
          box-sizing: border-box;
        }
        .realdac-page .realdac-room-code-display {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
          padding: 12px 14px;
          border-radius: 4px;
          background: rgba(8, 11, 12, 0.86);
          border: 1px solid rgba(0, 242, 255, 0.14);
        }
        .realdac-page .realdac-room-code-value {
          font-size: clamp(24px, 3.2vw, 34px);
          font-family: 'Space Grotesk', system-ui, sans-serif;
          font-weight: 800;
          letter-spacing: 0.22em;
          color: #dffcff;
          text-shadow: 0 0 18px rgba(0, 242, 255, 0.22);
        }
        .realdac-page .realdac-qr-shell {
          padding: 12px;
          border-radius: 4px;
          background: rgba(255,255,255,0.98);
          display: inline-flex;
          flex-direction: column;
          align-items: center;
          gap: 10px;
          align-self: center;
          box-shadow: 0 12px 32px rgba(0,0,0,0.24);
        }
        .realdac-page .realdac-mini-note {
          font-size: 10px;
          color: rgba(229, 226, 227, 0.62);
          line-height: 1.6;
        }
        @media (min-width: 900px) {
          .realdac-page .realdac-room-shell { display: flex; align-items: center; }
          .realdac-page .realdac-room-stage { width: 100%; }
          .realdac-page .realdac-command-button svg,
          .realdac-page .realdac-panel-button svg { transform: scale(0.92); }
        }
        .realdac-page .realdac-range {
          -webkit-appearance: none;
          appearance: none;
          width: 100%;
          height: 4px;
          border-radius: 999px;
          outline: none;
          background: linear-gradient(90deg, #1db954 0%, #1db954 var(--range-progress, 0%), rgba(255,255,255,0.18) var(--range-progress, 0%), rgba(255,255,255,0.18) 100%);
        }
        .realdac-page .realdac-range::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: #ffffff;
          box-shadow: 0 0 0 4px rgba(29,185,84,0.18);
          cursor: pointer;
        }
        .realdac-page .realdac-range::-moz-range-thumb {
          width: 14px;
          height: 14px;
          border: 0;
          border-radius: 50%;
          background: #ffffff;
          box-shadow: 0 0 0 4px rgba(29,185,84,0.18);
          cursor: pointer;
        }
        @media (min-width: 900px) {
          .realdac-page .realdac-join-grid { display: grid !important; grid-template-columns: 1fr 1fr; gap: 24px; align-items: start; }
          .realdac-page .realdac-room-layout { display: grid !important; grid-template-columns: minmax(0, 1.2fr) minmax(280px, 0.8fr); gap: 24px; align-items: start; }
        }
        @media (max-width: 600px) {
          .realdac-page {
            padding: 8px max(10px, env(safe-area-inset-left)) max(18px, calc(12px + env(safe-area-inset-bottom))) max(10px, env(safe-area-inset-right)) !important;
          }
          .realdac-page .realdac-room-shell {
            max-height: none !important;
            overflow: visible !important;
          }
          .realdac-page .realdac-header { margin-bottom: 20px !important; padding-top: 0 !important; }
          .realdac-page .realdac-header h1 { font-size: 24px !important; letter-spacing: 0.08em !important; }
          .realdac-page .realdac-header p { font-size: 13px !important; }
          .realdac-page .realdac-card { border-radius: 4px; padding: 16px !important; }
          .realdac-page .realdac-join-grid { gap: 16px !important; }
          .realdac-page .realdac-room-grid { gap: 16px !important; }
          .realdac-page .realdac-room-main { padding: 16px !important; }
          .realdac-page .realdac-room-code { font-size: clamp(40px, 14vw, 72px) !important; letter-spacing: 0.2em !important; font-weight: 900 !important; }
          .realdac-page .realdac-play-btn { min-width: 52px !important; min-height: 52px !important; }
          .realdac-page .realdac-room-shell { padding: 14px !important; border-radius: 4px !important; }
          .realdac-page .realdac-room-stage { grid-template-columns: 1fr !important; gap: 16px !important; }
          .realdac-page .realdac-tech-panel { padding: 14px !important; border-radius: 4px !important; }
          .realdac-page .realdac-console-header { align-items: center !important; gap: 10px !important; margin-bottom: 14px !important; }
          .realdac-page .realdac-console-brand { gap: 10px !important; }
          .realdac-page .realdac-console-kicker { font-size: 9px !important; margin-bottom: 0 !important; }
          .realdac-page .realdac-console-title { font-size: 24px !important; }
          .realdac-page .realdac-console-meta { justify-content: flex-end !important; gap: 6px !important; }
          .realdac-page .realdac-tech-chip { padding: 5px 8px !important; font-size: 9px !important; letter-spacing: 0.1em !important; }
          .realdac-page .realdac-tech-art { width: min(100%, 278px) !important; border-radius: 4px !important; margin-bottom: 14px !important; }
          .realdac-page .realdac-tech-art-label,
          .realdac-page .realdac-tech-art-footer { left: 16px !important; right: 16px !important; }
          .realdac-page .realdac-tech-code,
          .realdac-page .realdac-tech-tag { font-size: 8px !important; }
          .realdac-page .realdac-hud-title { font-size: 24px !important; margin-bottom: 4px !important; }
          .realdac-page .realdac-hud-subtitle { justify-content: center !important; text-align: center !important; margin-bottom: 12px !important; font-size: 12px !important; gap: 6px !important; }
          .realdac-page .realdac-progress-shell { padding: 12px !important; margin-bottom: 16px !important; }
          .realdac-page .realdac-progress-meta { align-items: flex-end !important; margin-bottom: 10px !important; }
          .realdac-page .realdac-time-value { font-size: 11px !important; }
          .realdac-page .realdac-time-label { font-size: 8px !important; }
          .realdac-page .realdac-tech-readout { gap: 6px !important; font-size: 8px !important; letter-spacing: 0.1em !important; }
          .realdac-page .realdac-tech-controls { gap: 10px !important; }
          .realdac-page .realdac-panel-button { width: 40px !important; height: 40px !important; }
          .realdac-page .realdac-reactor-button { width: 64px !important; height: 48px !important; }
          .realdac-page .realdac-diagnostics { gap: 10px !important; padding: 10px 12px !important; margin-bottom: 14px !important; }
          .realdac-page .realdac-user-pip { width: 22px !important; height: 22px !important; font-size: 9px !important; }
          .realdac-page .realdac-action-grid { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; gap: 8px !important; }
          .realdac-page .realdac-command-button { min-height: 64px !important; gap: 5px !important; font-size: 8px !important; letter-spacing: 0.08em !important; padding: 8px 4px !important; }
          .realdac-page .realdac-sidebar-stack { display: none !important; }
          .realdac-page .realdac-mobile-room-access { display: block !important; margin-bottom: 14px !important; }
          .realdac-page .realdac-room-code-display { padding: 14px !important; }
          .realdac-page .realdac-room-code-value { font-size: clamp(24px, 9vw, 34px) !important; }
          .realdac-page .realdac-qr-shell { width: 100%; box-sizing: border-box; }
          .realdac-page .realdac-sidebar-stack { gap: 14px !important; }
          .realdac-page input, .realdac-page button { -webkit-tap-highlight-color: transparent; min-height: 44px; }
          .realdac-page .realdac-qr-img { width: 120px !important; height: 120px !important; }
        }
        @media (max-width: 480px) {
          .realdac-page .realdac-room-code { font-size: clamp(32px, 11vw, 56px) !important; letter-spacing: 0.12em !important; }
          .realdac-page .realdac-card { padding: 14px !important; }
          .realdac-page .realdac-room-main { padding: 14px !important; }
        }
        @media (max-width: 600px) {
          .realdac-countdown-digit { font-size: clamp(72px, 32vw, 120px) !important; }
        }
      `}</style>

      {/* ========== COUNTDOWN OVERLAY (sync 3-2-1-0) ========== */}
      {countdown !== null && (
        <div style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(0,0,0,0.85)',
          pointerEvents: 'none',
        }}>
          <div className="realdac-countdown-digit" style={{
            fontSize: 'clamp(80px, 35vw, 200px)',
            fontWeight: 800,
            fontFamily: 'monospace',
            color: 'var(--text-primary)',
            lineHeight: 1,
            textShadow: '0 0 60px rgba(255,255,255,0.3)',
          }}>
            {countdown}
          </div>
          <div style={{ fontSize: '14px', color: 'var(--text-secondary)', marginTop: '12px' }}>
            {countdown === 0 ? 'Go!' : 'seconds'}
          </div>
        </div>
      )}

      {/* ========== HEADER ========== */}
      {screen !== 'room' && (
        <div className="realdac-header" style={{ textAlign: 'center', marginBottom: '32px', paddingTop: '8px' }}>
          <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: '6px' }}>
            Sync
          </div>
          <h1 style={{
            fontSize: 'clamp(28px, 5vw, 44px)',
            fontWeight: 400,
            letterSpacing: '0.14em',
            margin: '0 0 10px 0',
            fontFamily: "'AmericanCaptain', 'Bebas Neue', sans-serif",
            color: 'var(--text-primary)',
            textTransform: 'uppercase',
          }}>
            RealDac
          </h1>
          <p style={{
            fontSize: '14px',
            color: 'var(--text-secondary)',
            margin: '0 auto',
            lineHeight: 1.6,
            maxWidth: '520px',
          }}>
            Everyone in the same room hears the same music at the exact same moment.
          </p>
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            marginTop: '12px',
            padding: '6px 14px',
            borderRadius: '4px',
            background: 'var(--card-bg)',
            border: '1px solid var(--border-color)',
            fontSize: '12px',
            fontWeight: 600,
            color: socketConnected ? 'var(--success-color)' : '#f59e0b',
            letterSpacing: '0.05em',
          }}>
            <span style={{
              width: '6px', height: '6px', borderRadius: '50%',
              background: socketConnected ? 'var(--success-color)' : '#f59e0b',
              animation: socketConnected ? 'livePulse 2s infinite' : 'none',
            }} />
            {socketConnected ? 'Live' : 'Connecting…'}
          </div>
        </div>
      )}

      {/* ========== JOIN SCREEN ========== */}
      {screen === 'join' && (
        <div className="realdac-join-grid" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div className="realdac-card" style={{ padding: '24px' }}>
              <label style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: '8px', display: 'block' }}>
                Room code
              </label>
              <input
                type="text"
                placeholder="000000"
                maxLength={6}
                inputMode="numeric"
                value={inputCode}
                onChange={(e) => setInputCode(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                style={{
                  width: '100%', padding: '14px', fontSize: '20px', fontWeight: 700,
                  letterSpacing: '0.35em', textAlign: 'center', fontFamily: 'monospace',
                  border: '2px solid var(--border-color)', borderRadius: '4px',
                  background: 'var(--input-bg)', color: 'var(--text-primary)',
                  boxSizing: 'border-box', outline: 'none',
                }}
              />
              {joinStatus && <p style={{ fontSize: '12px', color: 'var(--error-color)', margin: '8px 0 0 0' }}>{joinStatus}</p>}
              <button
                onClick={handleJoin}
                disabled={!socketConnected}
                style={{
                  width: '100%', marginTop: '14px', padding: '14px',
                  fontSize: '14px', fontWeight: 600, border: 'none', borderRadius: '4px',
                  background: 'var(--text-primary)', color: 'var(--bg-primary)',
                  cursor: socketConnected ? 'pointer' : 'not-allowed',
                  opacity: socketConnected ? 1 : 0.5,
                }}
              >
                Join Room
              </button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', color: 'var(--text-tertiary)', fontSize: '12px' }}>
              <div style={{ flex: 1, height: 1, background: 'var(--border-color)' }} />
              or
              <div style={{ flex: 1, height: 1, background: 'var(--border-color)' }} />
            </div>
            <button
              onClick={handleCreate}
              disabled={!socketConnected}
              style={{
                width: '100%', padding: '14px', fontSize: '14px', fontWeight: 500,
                border: '1px solid var(--border-color)', borderRadius: '4px',
                background: 'transparent', color: 'var(--text-secondary)',
                cursor: socketConnected ? 'pointer' : 'not-allowed',
                opacity: socketConnected ? 1 : 0.5,
              }}
            >
              Create Room
            </button>
          </div>

          {/* How it works */}
          <div className="realdac-card" style={{ padding: '24px' }}>
            <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: '12px' }}>
              How it works
            </div>
            {[
              ['1', 'One person creates a room'],
              ['2', 'Share the 6-digit code with friends'],
              ['3', 'Everyone joins the room'],
              ['4', 'Anyone can play, pause, or change the song — syncs for all'],
            ].map(([n, text]) => (
              <div key={n} style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '8px' }}>
                <span style={{
                  minWidth: '20px', height: '20px', borderRadius: '50%',
                  background: 'var(--border-color)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', flexShrink: 0,
                }}>
                  {n}
                </span>
                <span style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ========== ROOM / PLAYER SCREEN ========== */}
      {screen === 'room' && (
        <div className="realdac-room-shell">
          <div className="realdac-room-stage">
            <div className="realdac-tech-panel">
              <div className="realdac-console-header">
                <div className="realdac-console-brand">
                  <button className="realdac-panel-button" onClick={handleLeave} title="Leave room">
                    <TechIcon size={18}>
                      <path d="M15 18l-6-6 6-6" />
                      <path d="M21 12H9" />
                    </TechIcon>
                  </button>
                  <div>
                    <div className="realdac-console-kicker">Now Playing</div>
                    <div className="realdac-console-title">GradeX RealDac</div>
                  </div>
                </div>
                <div className="realdac-console-meta">
                  <span className="realdac-tech-chip realdac-tech-chip-muted">#{roomCode}</span>
                  <span className="realdac-tech-chip realdac-tech-chip-muted">
                    <TechIcon size={14} strokeWidth={1.7}>
                      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </TechIcon>
                    {participants} {participants === 1 ? 'listener' : 'listeners'}
                  </span>
                  <span className="realdac-tech-chip" style={{ color: syncBadge.tone, borderColor: `${syncBadge.tone}44` }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: syncBadge.tone, boxShadow: `0 0 12px ${syncBadge.tone}` }} />
                    {syncBadge.label}
                  </span>
                </div>
              </div>

              <div className="realdac-mobile-room-access">
                <div className="realdac-sidebar-title">Room Access</div>
                <div className="realdac-room-code-display">
                  <div>
                    <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.16em', color: 'rgba(137,160,166,0.82)', fontWeight: 700, marginBottom: 6 }}>
                      Join code
                    </div>
                    <div className="realdac-room-code-value">{roomCode}</div>
                  </div>
                  <span className="realdac-tech-chip" style={{ color: syncBadge.tone, borderColor: `${syncBadge.tone}44` }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: syncBadge.tone }} />
                    {participants} live
                  </span>
                </div>
              </div>

              <div className="realdac-tech-art">
                <div className="realdac-tech-art-grid" />
                <div className="realdac-tech-art-core" />
                <img className="realdac-tech-art-logo" src="/arc-reactor1.png" alt="" />
                <div className="realdac-tech-art-label">
                  <span className="realdac-tech-code">{artFrameLabel}</span>
                  <span className="realdac-tech-tag">
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#00f2ff', boxShadow: '0 0 12px rgba(0,242,255,0.65)' }} />
                    HD Lossless
                  </span>
                </div>
                <div className="realdac-tech-art-footer">
                  <span className="realdac-muted-readout">
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: syncBadge.tone, boxShadow: `0 0 10px ${syncBadge.tone}` }} />
                    {syncBadge.label}
                  </span>
                </div>
              </div>

              <h2 className="realdac-hud-title" style={{ letterSpacing: '-0.02em' }}>{displayTrackName}</h2>
              <div className="realdac-hud-subtitle">
                <span style={{ color: '#81e8ff', fontWeight: 600 }}>{displayAlbumName}</span>
                <span style={{ opacity: 0.4 }}>•</span>
                <span>{syncBadge.detail}</span>
              </div>

              <div className="realdac-progress-shell">
                <div className="realdac-progress-meta">
                  <div className="realdac-time-cluster">
                    <span className="realdac-time-value">{formatTime(currentProgressMs)}</span>
                    <span className="realdac-time-label">Elapsed</span>
                  </div>
                  <div className="realdac-time-cluster" style={{ alignItems: 'flex-end' }}>
                    <span className="realdac-time-value">{formatTime(remainingMs)}</span>
                    <span className="realdac-time-label">Remaining</span>
                  </div>
                </div>

                <input
                  type="range"
                  min={0}
                  max={Math.max(0, trackDurationMs)}
                  step={250}
                  value={Math.min(currentProgressMs, trackDurationMs || 0)}
                  disabled={!canSeek}
                  className="realdac-range"
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
                />

                <div className="realdac-tech-readout">
                  <span>24-bit / 192kHz</span>
                  <span>{syncMetaLabel}</span>
                  <span>{canSeek ? 'Drag to room-seek' : 'Playback required to seek'}</span>
                </div>
              </div>

              <div className="realdac-tech-controls">
                <button className="realdac-panel-button" onClick={() => void stepTrack(-1)} disabled={!hasPrevTrack} title="Previous track">
                  <TechIcon size={20}>
                    <path d="M11 19L3 12l8-7v14z" fill="currentColor" stroke="none" />
                    <path d="M21 19l-8-7 8-7v14z" fill="currentColor" stroke="none" />
                  </TechIcon>
                </button>

                {shouldShowPauseButton ? (
                  <button className="realdac-reactor-button" onClick={handlePause} title="Pause room playback">
                    <TechIcon size={28} strokeWidth={0}>
                      <rect x="7" y="5" width="4" height="14" rx="1.4" fill="currentColor" />
                      <rect x="13" y="5" width="4" height="14" rx="1.4" fill="currentColor" />
                    </TechIcon>
                  </button>
                ) : (
                  <button
                    className="realdac-reactor-button"
                    onClick={handlePlay}
                    disabled={!socketConnected || loadingAudio || playButtonLocked || countdown !== null || syncPhase === 'preparing'}
                    title="Start synchronized playback"
                  >
                    <TechIcon size={24} strokeWidth={0}>
                      <path d="M8 6l10 6-10 6z" fill="currentColor" />
                    </TechIcon>
                  </button>
                )}

                <button className="realdac-panel-button" onClick={() => void stepTrack(1)} disabled={!hasNextTrack} title="Next track">
                  <TechIcon size={20}>
                    <path d="M13 19l8-7-8-7v14z" fill="currentColor" stroke="none" />
                    <path d="M3 19l8-7-8-7v14z" fill="currentColor" stroke="none" />
                  </TechIcon>
                </button>
              </div>

              <div className="realdac-diagnostics">
                <div className="realdac-diagnostics-users">
                  <span className="realdac-user-pip">GX</span>
                  <span className="realdac-user-pip" style={{ opacity: 0.82 }}>RD</span>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.14em', color: 'rgba(137,160,166,0.82)', fontWeight: 700 }}>
                      Listener readiness
                    </span>
                    <span style={{ fontSize: 13, color: '#dffcff', fontWeight: 700 }}>
                      {readinessLabel}
                    </span>
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <span className="realdac-muted-readout">{syncMetaLabel}</span>
                  <span className="realdac-muted-readout">{statusMessage || syncBadge.detail || 'Anchor locked'}</span>
                </div>
              </div>

              <div className="realdac-action-grid">
                <button className="realdac-command-button" onClick={() => void copyToClipboard(roomCode, 'Room code copied')}>
                  <TechIcon size={18}>
                    <rect x="9" y="9" width="11" height="11" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </TechIcon>
                  Copy Room
                </button>
                <button className="realdac-command-button" onClick={() => void handleShareInvite()}>
                  <TechIcon size={18}>
                    <path d="M14 9l-8 4 8 4" />
                    <path d="M18 5a3 3 0 1 0 0.001 6.001A3 3 0 0 0 18 5z" />
                    <path d="M6 10a3 3 0 1 0 0.001 6.001A3 3 0 0 0 6 10z" />
                    <path d="M18 13a3 3 0 1 0 0.001 6.001A3 3 0 0 0 18 13z" />
                  </TechIcon>
                  Invite
                </button>
                <button className="realdac-command-button realdac-command-button-danger" onClick={handleLeave}>
                  <TechIcon size={18}>
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <path d="M16 17l5-5-5-5" />
                    <path d="M21 12H9" />
                  </TechIcon>
                  Leave Room
                </button>
              </div>
            </div>

            <div className="realdac-sidebar-stack">
              <div className="realdac-tech-panel">
                <div className="realdac-sidebar-title">Room Access</div>
                <div className="realdac-sidebar-block">
                  <div className="realdac-room-code-display">
                    <div>
                      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.16em', color: 'rgba(137,160,166,0.82)', fontWeight: 700, marginBottom: 6 }}>
                        Join code
                      </div>
                      <div className="realdac-room-code-value">{roomCode}</div>
                    </div>
                    <span className="realdac-tech-chip" style={{ color: syncBadge.tone, borderColor: `${syncBadge.tone}44` }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: syncBadge.tone }} />
                      {participants} live
                    </span>
                  </div>

                  {qrDataUrl ? (
                    <div className="realdac-qr-shell">
                      <img className="realdac-qr-img" src={qrDataUrl} alt={`Scan to join room ${roomCode}`} style={{ display: 'block', width: 168, height: 168 }} />
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#475569', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                        Scan to join
                      </div>
                    </div>
                  ) : (
                    <div className="realdac-mini-note" style={{ minHeight: 90, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      Generating QR invite…
                    </div>
                  )}

                  <div>
                    <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.16em', color: 'rgba(137,160,166,0.82)', fontWeight: 700, marginBottom: 8 }}>
                      Invite link
                    </div>
                    <div className="realdac-mini-note" style={{ wordBreak: 'break-all', marginBottom: 10 }}>
                      {inviteUrl}
                    </div>
                    <button className="realdac-command-button" style={{ minHeight: 54 }} onClick={() => void copyToClipboard(inviteUrl, 'Invite link copied')}>
                      <TechIcon size={18}>
                        <path d="M15 7h3a5 5 0 0 1 0 10h-3" />
                        <path d="M9 17H6A5 5 0 0 1 6 7h3" />
                        <path d="M8 12h8" />
                      </TechIcon>
                      {linkCopied ? 'Copied' : 'Copy Invite Link'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="realdac-tech-panel">
                <div className="realdac-sidebar-title">Source Control</div>
                <div className="realdac-sidebar-block">
                  {albums.length > 1 && (
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
                      className="realdac-input-shell"
                    >
                      {albums.map((a) => (
                        <option key={a.id} value={a.id}>Album: {toProperCase(a.name)}</option>
                      ))}
                    </select>
                  )}

                  <select
                    value={selectedTrack}
                    onChange={(e) => {
                      const trackId = e.target.value;
                      setSelectedTrack(trackId);
                      if (roomCode) {
                        const tn = tracks.find((t) => t.id === trackId)?.name;
                        syncTrackToConvex(roomCode, trackId, selectedAlbum, tn);
                      }
                    }}
                    className="realdac-input-shell"
                  >
                    {tracks.map((t) => (
                      <option key={t.id} value={t.id}>{toProperCase(t.name)}</option>
                    ))}
                  </select>

                  <div>
                    <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.16em', color: 'rgba(137,160,166,0.82)', fontWeight: 700, marginBottom: 10 }}>
                      Output gain
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={volume}
                      onChange={(e) => setVolume(Number(e.target.value))}
                      className="realdac-range"
                      style={{ '--range-progress': `${Math.round(volume * 100)}%` }}
                    />
                    <div className="realdac-mini-note" style={{ marginTop: 8 }}>
                      Reactor gain {Math.round(volume * 100)}%
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
