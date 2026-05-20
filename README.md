# RealDac CodePlayground

A real-time, room-synced music listening experience extracted from the GradeX project into its own standalone app. Multiple users can join a shared room, queue tracks, and stay perfectly in sync — backed by a small Node/Socket.IO server and a Convex store for persistent room state.

## Features

- Room-synced playback via Socket.IO (server-authoritative track + position)
- Local song catalog auto-discovered from `public/realdac-songs/`
- React + Vite frontend with `@react-three/fiber` 3D scene support
- Convex backend for persistent room track state (optional — can share or own deployment)
- QR-code based room sharing (`qrcode` package)
- Express API for serving songs and album metadata

## Tech stack

- **Frontend:** React 18, Vite 5, React Router, @react-three/fiber, @react-three/drei
- **Realtime:** Socket.IO (server + client)
- **Backend:** Express, Node ESM, Convex
- **Build/dev:** Vite, concurrently

## Project structure

```
.
├── src/
│   ├── components/RealDac.jsx     # main RealDac UI
│   ├── App.jsx
│   ├── main.jsx
│   └── styles.css
├── realdac/realdac-socket.js      # Socket.IO room sync server
├── server.mjs                     # Express app + static + Socket.IO host
├── convex/
│   ├── realdacRooms.ts            # room track-state function
│   └── schema.ts                  # Convex schema
├── public/realdac-songs/          # local song catalog (MP3s)
├── scripts/                       # helpers to download & deploy songs
└── vite.config.mjs
```

## Run locally

```bash
npm install
npm run dev:all
```

- Vite dev server: <http://localhost:5174>
- API + Socket.IO server: <http://localhost:3200>
- Health check: <http://localhost:3200/health>

The Vite dev server proxies `/api`, `/realdac-songs`, and `/realdac` (WebSocket) to the API server on port 3200.

## Available scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start Vite dev server only |
| `npm run server` | Start Express + Socket.IO server with `--watch` |
| `npm run dev:all` | Run both concurrently (recommended) |
| `npm run build` | Production build (Vite → `dist/`) |
| `npm run preview` | Preview the built bundle |
| `npm start` | Run the production Express server (serves `dist/`) |
| `npm run convex:dev` | Start a local Convex dev deployment |
| `npm run convex:deploy` | Deploy the Convex functions |

## Configuration

Environment variables (set in `.env` at the project root):

- `VITE_CONVEX_URL` — Convex deployment URL the client should talk to. Defaults to the shared GradeX deployment if unset.
- `PORT` — Port for the API/Socket.IO server. Defaults to `3200`.

## Notes

- This project was extracted from GradeX and keeps the same Convex contract.
- Intended deployment target: `https://realdac.gradex.bond`.
- Run `npm run convex:dev` in this folder if you want RealDac to own its own Convex backend instead of sharing GradeX's.

## License

Private project — all rights reserved.
