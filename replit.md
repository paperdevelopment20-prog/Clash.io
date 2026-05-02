# clashes.pro

A fast-paced multiplayer fighting game with abilities, built with Node.js, Express, WebSockets, and MongoDB.

## Architecture

- **Backend**: `server.js` — Express HTTP server + WebSocket server (`ws` library) for real-time game logic, room management, ELO calculation, and user auth
- **Frontend**: `index.html` — Single-file client with HTML5 Canvas game engine and Tailwind CSS UI (served as static file from Express)
- **Database**: `dbconn.js` — MongoDB via Mongoose (user accounts, loadouts, wins, ELO)
- **Assets**: SVG files for ability icons and skins

## Key Dependencies

- `express` — HTTP server and static file serving
- `ws` — WebSocket server for real-time multiplayer
- `mongoose` — MongoDB ODM for user data
- `bcryptjs` — Password hashing

## Running the App

```bash
npm start
# Runs: node server.js
# Listens on port 5000 (0.0.0.0)
```

## Environment Variables

- `MONGODB_URI` — MongoDB connection string (required)
- `PORT` — Server port (defaults to 5000)

## Deployment

Configured as a `vm` deployment (WebSocket server needs persistent connections).
Run command: `node server.js`
