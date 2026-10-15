# قَلِّدها! — Mimic Party MVP

An Arabic/Darija online audio-imitation party game. The project is a small Node.js/Express + Socket.IO app with a browser UI, room codes, custom audio uploads, microphone recordings, local similarity scoring, optional AI scoring, peer-to-peer room voice chat, and synchronized room-wide recording playback.

## Requirements

- Node.js 20 or newer
- Chrome or Edge recommended
- Internet connection for installing npm dependencies and playing with remote friends

## Run on Windows

1. Extract the ZIP file into a normal folder.
2. Double-click `RUN_ME_FIRST.bat`. On first launch, it runs `npm install` and then starts the server.
3. Open `http://localhost:3000` in Chrome or Edge.
4. Keep the console window open while playing.

You can also run it manually from PowerShell or Command Prompt:

```bash
npm install
npm start
```

The server listens on port `3000` by default. You can set `PORT` in `.env` if needed.

## Play the game

1. Enter a nickname and create a room, or join a friend's room with its six-character code.
2. The host can upload audio files (WAV, MP3, WEBM, OGG, M4A, AAC, or FLAC; up to `MAX_UPLOAD_MB`, 18 MB by default).
3. Choose a sound and start a round.
4. Click the record button. After a three-second preparation countdown, the microphone records for up to eight seconds.
5. Listen to your clip, then submit it for a score or click **سمّع المحاولة للكل** so the whole room hears it.
6. Scores and the round leaderboard are shared with everyone in the room.

Local scoring compares rough sound features; it is an approximation, not semantic AI. Optional AI judging uses a server-side API key if configured.

## Live voice chat

- Each player clicks **دخل للدردشة الصوتية** once and grants microphone permission. The mic remains open until muted or until the player leaves the voice chat/room.
- Use **كتم الميكروفون** to mute temporarily, then unmute when ready.
- The app uses WebRTC for live peer-to-peer audio; Socket.IO carries only connection signaling.
- The interface shows which players enabled voice chat and whether the local mic is muted.
- Use headphones where possible to prevent echo and feedback.

### Microphone permissions and online play

Browsers require a secure context for microphone access. `http://localhost:3000` works for local testing. For friends connecting over the internet, deploy the app on a host with **HTTPS and WebSocket support**. The mic does not activate until a player deliberately clicks the voice-chat button.

The initial WebRTC configuration uses public STUN servers. Some network setups require a TURN relay. Add the following variables to a `.env` file if you have TURN credentials from a provider:

```dotenv
TURN_URL=turn:your-turn-host:3478
TURN_USERNAME=your-username
TURN_CREDENTIAL=your-password-or-credential
```

You can supply comma-separated TURN URLs in `TURN_URL`. For production, prefer short-lived TURN credentials rather than a permanent shared password.

## Synchronized playback of a room recording

When someone clicks **سمّع المحاولة للكل**, the server stores the short WAV clip temporarily and notifies the room. Each browser preloads the audio and acknowledges readiness. Once everyone has loaded the clip (or the eight-second safety timeout is reached), the server schedules playback against a shared server timestamp; the client estimates clock offset to reduce device-clock differences. This aims to align playback but cannot guarantee sample-perfect synchronization across different browsers and networks.

Shared clips are automatically deleted after three hours while the server remains running. This is an MVP cleanup strategy, not durable media storage.

## Optional AI judging

1. Copy `.env.example` to `.env`.
2. Put your API key in `OPENAI_API_KEY` on the server only.
3. Restart the server.

Never place the API key in `public/app.js` or other browser files. API usage may incur charges. Without the key, the game falls back to a rough local audio-feature similarity score.

## Checks and limitations

- Rooms support up to eight players.
- Voice chat uses a mesh topology (one WebRTC peer connection per other voice-enabled player). This is suitable for small rooms, not large broadcasts.
- Production hardening should add better reconnect handling, upload/playback rate limits, durable cleanup jobs, and monitoring.
- Voice chat and synchronized playback need a real multi-browser test on the deployed HTTPS domain before public launch.
