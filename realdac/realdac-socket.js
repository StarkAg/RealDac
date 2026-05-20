/**
 * RealDac - Synchronized music playback
 * WebSocket handler for room management, time sync, and PLAY_AT commands.
 *
 * Sync mechanism:
 * 1. Client sends TIME_SYNC_REQ; server responds with server timestamp.
 * 2. Client calculates offset = serverTime - (clientTime + RTT/2).
 * 3. Server broadcasts PLAY_AT with server timestamp; clients convert to local time and schedule playback.
 * 4. Periodic drift correction: server sends SYNC_TICK; clients re-measure offset.
 */

import { Server } from 'socket.io';

// Room storage: roomCode -> { sockets: Set, playState, createdAt, lastActivity }
const rooms = new Map();

// Room cleanup interval (check every 5 minutes, remove rooms inactive for 30 minutes)
const ROOM_CLEANUP_INTERVAL = 5 * 60 * 1000;
const ROOM_MAX_INACTIVE_MS = 30 * 60 * 1000;

function generateRoomCode() {
  let code;
  let attempts = 0;
  const maxAttempts = 100;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
    attempts++;
    if (attempts >= maxAttempts) {
      throw new Error('Failed to generate unique room code');
    }
  } while (rooms.has(code));
  return code;
}

function getRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (room) {
    room.lastActivity = Date.now();
  }
  return room;
}

function createRoom() {
  const code = generateRoomCode();
  const now = Date.now();
  rooms.set(code, {
    sockets: new Set(),
    playState: null,
    createdAt: now,
    lastActivity: now,
  });
  console.log(`[RealDac] Room created: ${code}`);
  return code;
}

function cleanupStaleRooms() {
  const now = Date.now();
  let cleaned = 0;
  for (const [code, room] of rooms.entries()) {
    const inactive = now - room.lastActivity;
    const empty = room.sockets.size === 0;
    if (empty && inactive > ROOM_MAX_INACTIVE_MS) {
      rooms.delete(code);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[RealDac] Cleaned up ${cleaned} stale rooms. Active rooms: ${rooms.size}`);
  }
}

export function attachRealDac(httpServer) {
  const io = new Server(httpServer, {
    path: '/realdac/socket.io',
    cors: { origin: '*' },
    pingTimeout: 30000,
    pingInterval: 10000,
    connectTimeout: 20000,
    maxHttpBufferSize: 1e6,
  });

  // Start room cleanup interval
  const cleanupInterval = setInterval(cleanupStaleRooms, ROOM_CLEANUP_INTERVAL);

  // Cleanup on server shutdown
  io.engine.on('close', () => {
    clearInterval(cleanupInterval);
  });

  io.on('connection', (socket) => {
    let roomCode = null;
    console.log(`[RealDac] Client connected: ${socket.id}`);

    // Error handler
    socket.on('error', (err) => {
      console.error(`[RealDac] Socket error for ${socket.id}:`, err.message);
    });

    // --- TIME SYNC (NTP-style) ---
    socket.on('TIME_SYNC_REQ', (clientSendTime, ack) => {
      const serverTime = Date.now();
      const response = { clientSendTime, serverTime };

      // Support both event response and acknowledgement
      if (typeof ack === 'function') {
        ack(response);
      } else {
        socket.emit('TIME_SYNC_RES', response);
      }
    });

    // --- ROOM: Create ---
    socket.on('ROOM_CREATE', (ack) => {
      try {
        // Leave any existing room first
        if (roomCode) {
          leaveRoom();
        }

        const code = createRoom();
        roomCode = code;
        socket.join(code);
        getRoom(code).sockets.add(socket.id);

        if (typeof ack === 'function') {
          ack({ roomCode: code, success: true });
        }
      } catch (err) {
        console.error(`[RealDac] Error creating room:`, err.message);
        if (typeof ack === 'function') {
          ack({ error: err.message, success: false });
        }
      }
    });

    // --- ROOM: Join ---
    socket.on('ROOM_JOIN', (code, ack) => {
      try {
        const c = String(code || '').trim();

        if (!c || c.length !== 6 || !/^\d{6}$/.test(c)) {
          if (typeof ack === 'function') {
            ack({ error: 'Invalid room code format', success: false });
          }
          return;
        }

        if (!rooms.has(c)) {
          if (typeof ack === 'function') {
            ack({ error: 'Room not found', success: false });
          }
          return;
        }

        // Leave any existing room first
        if (roomCode) {
          leaveRoom();
        }

        roomCode = c;
        socket.join(c);
        const room = getRoom(c);
        room.sockets.add(socket.id);

        console.log(`[RealDac] Client ${socket.id} joined room ${c}. Total: ${room.sockets.size}`);

        if (typeof ack === 'function') {
          ack({
            roomCode: c,
            playState: room.playState,
            participants: room.sockets.size,
            success: true,
          });
        }

        // Notify others in room
        socket.to(c).emit('PARTICIPANT_JOINED', { count: room.sockets.size });
      } catch (err) {
        console.error(`[RealDac] Error joining room:`, err.message);
        if (typeof ack === 'function') {
          ack({ error: 'Failed to join room', success: false });
        }
      }
    });

    // --- ROOM: Leave ---
    const leaveRoom = () => {
      if (!roomCode) return;

      const room = rooms.get(roomCode);
      if (room) {
        room.sockets.delete(socket.id);
        const remaining = room.sockets.size;

        console.log(`[RealDac] Client ${socket.id} left room ${roomCode}. Remaining: ${remaining}`);

        // Notify others
        socket.to(roomCode).emit('PARTICIPANT_LEFT', { count: remaining });

        // Don't delete room immediately - let cleanup handle it
        // This allows rejoining briefly disconnected rooms
      }

      socket.leave(roomCode);
      roomCode = null;
    };

    socket.on('ROOM_LEAVE', (ack) => {
      leaveRoom();
      if (typeof ack === 'function') {
        ack({ success: true });
      }
    });

    socket.on('disconnect', (reason) => {
      console.log(`[RealDac] Client disconnected: ${socket.id}, reason: ${reason}`);
      leaveRoom();
    });

    // --- PAUSE: Broadcast to room; everyone stops playback ---
    socket.on('PAUSE', (ack) => {
      if (!roomCode) {
        if (typeof ack === 'function') {
          ack({ error: 'Not in a room', success: false });
        }
        return;
      }

      const room = getRoom(roomCode);
      if (room) {
        room.playState = null;
        room.lastActivity = Date.now();
      }

      // Send to others (sender already stops locally)
      socket.to(roomCode).emit('PAUSE');

      if (typeof ack === 'function') {
        ack({ success: true });
      }
    });

    // --- PLAY: Host schedules playback; server broadcasts PLAY_AT ---
    socket.on('PLAY_AT', ({ track, playAt }, ack) => {
      if (!roomCode) {
        if (typeof ack === 'function') {
          ack({ error: 'Not in a room', success: false });
        }
        return;
      }

      const room = getRoom(roomCode);
      if (!room) {
        if (typeof ack === 'function') {
          ack({ error: 'Room not found', success: false });
        }
        return;
      }

      // Validate track
      if (!track || typeof track !== 'string') {
        if (typeof ack === 'function') {
          ack({ error: 'Invalid track', success: false });
        }
        return;
      }

      const serverNow = Date.now();
      const playAtMs = typeof playAt === 'number' && playAt > serverNow
        ? playAt
        : serverNow + 3000; // default: 3s from now

      room.playState = {
        track,
        playAt: playAtMs,
        startedAt: playAtMs,
      };
      room.lastActivity = serverNow;

      const payload = {
        track,
        playAt: playAtMs,
        serverTime: serverNow,
      };

      // Broadcast to everyone in room (including sender)
      io.to(roomCode).emit('PLAY_AT', payload);

      console.log(`[RealDac] PLAY_AT in room ${roomCode}: ${track} at ${playAtMs}`);

      if (typeof ack === 'function') {
        ack({ success: true, playAt: playAtMs });
      }
    });

    // --- SEEK: Sync seek position across room ---
    socket.on('SEEK', ({ position }, ack) => {
      if (!roomCode) {
        if (typeof ack === 'function') {
          ack({ error: 'Not in a room', success: false });
        }
        return;
      }

      const room = getRoom(roomCode);
      if (!room || !room.playState) {
        if (typeof ack === 'function') {
          ack({ error: 'No active playback', success: false });
        }
        return;
      }

      const serverNow = Date.now();

      // Update play state with new position
      room.playState.startedAt = serverNow - (position * 1000);
      room.lastActivity = serverNow;

      // Broadcast to others
      socket.to(roomCode).emit('SEEK', { position, serverTime: serverNow });

      if (typeof ack === 'function') {
        ack({ success: true });
      }
    });

    // --- GET_ROOM_INFO: Get current room state ---
    socket.on('GET_ROOM_INFO', (ack) => {
      if (!roomCode) {
        if (typeof ack === 'function') {
          ack({ error: 'Not in a room', success: false });
        }
        return;
      }

      const room = getRoom(roomCode);
      if (!room) {
        if (typeof ack === 'function') {
          ack({ error: 'Room not found', success: false });
        }
        return;
      }

      if (typeof ack === 'function') {
        ack({
          success: true,
          roomCode,
          playState: room.playState,
          participants: room.sockets.size,
        });
      }
    });

    // --- DRIFT: Server sends periodic sync tick; clients can re-measure offset ---
    socket.on('SYNC_TICK_REQ', (ack) => {
      const response = { serverTime: Date.now() };
      if (typeof ack === 'function') {
        ack(response);
      } else {
        socket.emit('SYNC_TICK', response);
      }
    });
  });

  console.log('[RealDac] WebSocket server attached');
  return io;
}
