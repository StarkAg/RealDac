import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { io } from 'socket.io-client';

const CODE_LENGTH = 6;

function CodeSlots({ value, onChange, onComplete, autoFocus = true, disabled = false }) {
  const inputRef = useRef(null);
  const [focused, setFocused] = useState(false);
  const slots = useMemo(() => Array.from({ length: CODE_LENGTH }), []);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const activeIndex = Math.min(value.length, CODE_LENGTH - 1);
  const isFilled = value.length === CODE_LENGTH;

  const handleChange = (e) => {
    const next = e.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH);
    onChange(next);
    if (next.length === CODE_LENGTH) onComplete?.(next);
  };

  return (
    <div
      className={`code-slots ${focused ? 'is-focused' : ''} ${isFilled ? 'is-filled' : ''} ${disabled ? 'is-disabled' : ''}`}
      onClick={() => inputRef.current?.focus()}
      role="group"
      aria-label="Six-digit room code"
    >
      <input
        ref={inputRef}
        className="code-slots-input"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        spellCheck={false}
        maxLength={CODE_LENGTH}
        value={value}
        disabled={disabled}
        onChange={handleChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        aria-label="Room code"
      />
      {slots.map((_, i) => {
        const char = value[i];
        const isActive = focused && i === activeIndex;
        const hasChar = Boolean(char);
        return (
          <div
            key={i}
            className={`code-slot ${hasChar ? 'has-char' : ''} ${isActive ? 'is-active' : ''}`}
            aria-hidden="true"
            data-index={i}
          >
            <span className="code-slot-char">{char || ''}</span>
            {isActive && !hasChar && <span className="code-slot-caret" />}
            <span className="code-slot-underline" />
          </div>
        );
      })}
    </div>
  );
}

export default function Workspace() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [serverState, setServerState] = useState('checking');
  const socketRef = useRef(null);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const r = await fetch('/health', { cache: 'no-store' });
        if (!alive) return;
        setServerState(r.ok ? 'up' : 'down');
      } catch {
        if (alive) setServerState('down');
      }
    };
    check();
    const id = setInterval(check, 15000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const ensureSocket = useCallback(() => {
    if (socketRef.current && socketRef.current.connected) return socketRef.current;
    const s = io({
      path: '/realdac/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: false,
      timeout: 6000,
    });
    socketRef.current = s;
    return s;
  }, []);

  useEffect(() => () => {
    try { socketRef.current?.disconnect(); } catch {}
  }, []);

  const handleCreate = useCallback(() => {
    if (creating) return;
    if (serverState === 'down') {
      setError('Server unreachable');
      return;
    }
    setError('');
    setCreating(true);
    const s = ensureSocket();
    const timeout = setTimeout(() => {
      setCreating(false);
      setError('Could not reach server');
    }, 8000);

    const proceed = () => {
      s.emit('ROOM_CREATE', (res) => {
        clearTimeout(timeout);
        setCreating(false);
        if (res?.error || !res?.success) {
          setError(res?.error || 'Failed to create room');
          return;
        }
        navigate(`/${res.roomCode}`);
      });
    };

    if (s.connected) proceed();
    else s.once('connect', proceed);
  }, [creating, serverState, ensureSocket, navigate]);

  const handleJoin = useCallback((raw) => {
    const candidate = String(raw ?? code).trim();
    if (!/^\d{6}$/.test(candidate)) {
      setError('Enter a 6-digit room code');
      return;
    }
    setError('');
    setJoining(true);
    navigate(`/${candidate}`);
  }, [code, navigate]);

  useEffect(() => {
    const onKey = (e) => {
      const target = e.target;
      const isEditable = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleCreate();
        return;
      }
      if (!isEditable && (e.key === '/' || e.key === 'j')) {
        e.preventDefault();
        document.querySelector('.code-slots-input')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleCreate]);

  const statusLabel = useMemo(() => ({
    checking: 'Connecting',
    up: 'Live',
    down: 'Offline',
  })[serverState], [serverState]);

  const canJoin = code.length === CODE_LENGTH && !joining;

  return (
    <main className="ws">
      {/* ===================== TOP BAR ===================== */}
      <header className="ws-bar" data-anim="rise" style={{ '--delay': '0ms' }}>
        <div className="ws-brand">
          <span className="ws-brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none">
              <circle cx="12" cy="12" r="3" fill="currentColor" />
              <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth="1.5" opacity="0.45" />
              <circle cx="12" cy="12" r="10.5" stroke="currentColor" strokeWidth="1" opacity="0.2" />
            </svg>
          </span>
          <span className="ws-brand-name">RealDac</span>
          <span className="ws-brand-tag">console</span>
        </div>
        <div className="ws-bar-right">
          <span className={`ws-status ws-status--${serverState}`} role="status" aria-live="polite">
            <span className="ws-status-dot" />
            <span className="ws-status-label">{statusLabel}</span>
          </span>
          <button type="button" className="ws-iconbtn" aria-label="Command palette" title="Command palette (coming soon)">
            <kbd className="ws-kbd ws-kbd--bare">⌘K</kbd>
          </button>
          <a
            className="ws-iconbtn ws-iconbtn--ghost"
            href="https://github.com/StarkAg/RealDac"
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub repository"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
              <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.55v-2.04c-3.2.69-3.87-1.36-3.87-1.36-.52-1.32-1.28-1.67-1.28-1.67-1.04-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.11-.74.4-1.26.73-1.55-2.55-.29-5.24-1.27-5.24-5.66 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.16 1.17.92-.26 1.9-.39 2.88-.39s1.96.13 2.88.39c2.2-1.48 3.16-1.17 3.16-1.17.62 1.58.23 2.75.11 3.04.74.8 1.18 1.82 1.18 3.07 0 4.4-2.7 5.36-5.27 5.65.41.35.78 1.05.78 2.12v3.14c0 .31.21.66.8.55C20.21 21.38 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5Z"/>
            </svg>
          </a>
        </div>
      </header>

      {/* ===================== MAIN ===================== */}
      <section className="ws-main">
        <div className="ws-eyebrow ws-eyebrow--lead" data-anim="rise" style={{ '--delay': '60ms' }}>
          <span className="ws-eyebrow-line" /> New session
        </div>

        <h1 className="ws-headline" data-anim="rise" style={{ '--delay': '100ms' }}>
          Listen together,
          <span className="ws-headline-soft">in sync.</span>
        </h1>

        <p className="ws-lede" data-anim="rise" style={{ '--delay': '160ms' }}>
          One room. One beat. Everyone hears the same moment, anywhere.
        </p>

        {/* Primary action — Create room */}
        <article
          className="ws-card ws-card--primary"
          data-anim="rise"
          style={{ '--delay': '220ms' }}
        >
          <div className="ws-card-glow" aria-hidden="true" />
          <div className="ws-card-body">
            <div className="ws-card-head">
              <span className="ws-card-eyebrow">Start</span>
              <h2 className="ws-card-title">Create a new room</h2>
              <p className="ws-card-sub">
                Generates a fresh 6-digit code. Share the link, code, or QR — everyone joins in seconds.
              </p>
            </div>
            <button
              type="button"
              className="ws-btn ws-btn--primary"
              onClick={handleCreate}
              disabled={creating || serverState === 'down'}
              aria-busy={creating}
            >
              {creating ? (
                <>
                  <Spinner />
                  <span>Creating room…</span>
                </>
              ) : (
                <>
                  <span>Start room</span>
                  <span className="ws-btn-tail">
                    <kbd className="ws-kbd ws-kbd--inline">⌘</kbd>
                    <kbd className="ws-kbd ws-kbd--inline">⏎</kbd>
                    <ArrowRight />
                  </span>
                </>
              )}
            </button>
          </div>
        </article>

        {/* Divider eyebrow */}
        <div className="ws-eyebrow" data-anim="rise" style={{ '--delay': '280ms' }}>
          <span className="ws-eyebrow-line" /> or join with code
        </div>

        {/* Join row */}
        <form
          className="ws-join"
          data-anim="rise"
          style={{ '--delay': '320ms' }}
          onSubmit={(e) => { e.preventDefault(); handleJoin(); }}
        >
          <CodeSlots
            value={code}
            onChange={(v) => { setCode(v); if (error) setError(''); }}
            onComplete={(v) => handleJoin(v)}
            disabled={joining}
          />
          <button
            type="submit"
            className="ws-btn ws-btn--ghost"
            disabled={!canJoin}
          >
            <span>Join</span>
            <ArrowRight />
          </button>
        </form>

        {error && (
          <p className="ws-error" role="alert" data-anim="rise" style={{ '--delay': '0ms' }}>
            <DotIcon /> {error}
          </p>
        )}
      </section>

      {/* ===================== FOOTER ===================== */}
      <footer className="ws-foot" data-anim="rise" style={{ '--delay': '380ms' }}>
        <div className="ws-foot-meta">
          <Badge>Socket.IO</Badge>
          <Badge>Convex</Badge>
          <Badge>React + Vite</Badge>
        </div>
        <div className="ws-foot-hints">
          <span className="ws-foot-hint"><kbd className="ws-kbd">/</kbd> focus code</span>
          <span className="ws-foot-hint"><kbd className="ws-kbd">⌘⏎</kbd> new room</span>
        </div>
      </footer>
    </main>
  );
}

/* ---- Tiny inline SVG / utility components ---- */

function ArrowRight() {
  return (
    <svg className="ws-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path d="M3 8h10m0 0L9 4m4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="ws-spinner" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" opacity="0.25" fill="none" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function DotIcon() {
  return (
    <svg viewBox="0 0 8 8" width="6" height="6" aria-hidden="true">
      <circle cx="4" cy="4" r="3" fill="currentColor" />
    </svg>
  );
}

function Badge({ children }) {
  return <span className="ws-badge">{children}</span>;
}
