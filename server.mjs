import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { attachRealDac } from './realdac/realdac-socket.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3200;

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/realdac/songs', (_req, res) => {
  const albums = new Map();
  const seenSongs = new Set();
  const dirs = [join(__dirname, 'public', 'realdac-songs')];

  function addSong(albumId, albumName, songId, songName) {
    const key = `${albumId}:${songId}`;
    if (seenSongs.has(key)) return;
    seenSongs.add(key);
    if (!albums.has(albumId)) {
      albums.set(albumId, { id: albumId, name: albumName, songs: [] });
    }
    albums.get(albumId).songs.push({ id: songId, name: songName });
  }

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.mp3')) {
        const name = entry.name.replace(/\.mp3$/i, '').replace(/-/g, ' ');
        addSong('general', 'General', `/realdac-songs/${entry.name}`, name);
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const albumPath = join(dir, entry.name);
      const albumId = entry.name.toLowerCase().replace(/\s+/g, '-');
      const albumName = entry.name.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
      const files = fs.readdirSync(albumPath);
      for (const file of files) {
        if (!file.endsWith('.mp3')) continue;
        const relPath = `${entry.name}/${file}`;
        const name = file.replace(/\.mp3$/i, '').replace(/-/g, ' ');
        addSong(albumId, albumName, `/realdac-songs/${relPath}`, name);
      }
    }
  }

  const albumsList = Array.from(albums.values()).filter((album) => album.songs.length > 0);
  const songs = albumsList.flatMap((album) => album.songs);
  if (songs.length === 0) {
    albumsList.push({
      id: 'honey-singh',
      name: 'Honey Singh',
      songs: [{ id: '/realdac-songs/honey-singh/blue-eyes.mp3', name: 'blue eyes' }],
    });
  }

  res.json({ songs, albums: albumsList });
});

app.use('/realdac-songs', (req, res, next) => {
  const file = req.path.slice(1);
  if (!file || file.includes('..')) return next();
  const fp = join(__dirname, 'public', 'realdac-songs', file);
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    // Static MP3s never change — let browsers cache for a year and skip revalidation.
    // Huge win for mobile users joining a room: subsequent loads are instant.
    return res
      .type('audio/mpeg')
      .set({
        'Cache-Control': 'public, max-age=31536000, immutable',
      })
      .sendFile(fp);
  }
  next();
});

app.use(express.static(join(__dirname, 'dist')));

app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

const server = http.createServer(app);
attachRealDac(server);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`RealDac server running on http://localhost:${PORT}`);
});
