require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: false }, maxHttpBufferSize: 2e7 });
const PORT = Number(process.env.PORT || 3000);
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1h', fallthrough: false }));
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
const pendingSharedRecordings = new Map();
const MAX_PLAYERS = 8;
const MAX_UPLOAD = Math.max(1, Number(process.env.MAX_UPLOAD_MB || 18)) * 1024 * 1024;
const allowedExts = new Set(['.wav', '.mp3', '.webm', '.ogg', '.m4a', '.mp4', '.aac', '.flac']);
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (allowedExts.has(ext) || /^audio\//i.test(file.mimetype)) return cb(null, true);
    cb(new Error('اختار ملف صوتي بحال WAV أو MP3 أو WEBM.'));
  }
});

const tidy = (value, max = 24) => String(value || '').trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, max);
const makeCode = () => {
  let code;
  do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
  return code;
};
function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    roundId: room.roundId,
    selectedSoundId: room.selectedSoundId,
    currentSoundId: room.currentSoundId,
    aiScoring: Boolean(process.env.OPENAI_API_KEY),
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, host: p.id === room.hostId,
      voiceReady: Boolean(p.voiceReady), voiceMuted: p.voiceReady ? Boolean(p.voiceMuted) : true,
      totalScore: p.totalScore || 0,
      submitted: room.submissions.has(p.id),
      roundScore: room.submissions.has(p.id) ? room.submissions.get(p.id).score : null
    })),
    sounds: room.sounds.map(s => ({ id: s.id, name: s.name, url: s.url, ext: s.ext })),
    currentSound: room.sounds.find(s => s.id === room.currentSoundId) || null,
    selectedSound: room.sounds.find(s => s.id === room.selectedSoundId) || null,
    results: room.status === 'results' ? [...room.submissions.entries()].map(([id, result]) => {
      const p = room.players.get(id);
      return { id, name: p ? p.name : result.name, score: result.score, feedback: result.feedback, method: result.method };
    }).sort((a, b) => b.score - a.score) : []
  };
}
function broadcastRoom(room) { io.to(room.code).emit('room:state', publicRoom(room)); }
function scheduleSharedRecording(id) {
  const job = pendingSharedRecordings.get(id);
  if (!job || job.scheduled) return;
  job.scheduled = true;
  clearTimeout(job.timeout);
  job.item.playAt = Date.now() + 1200;
  if (rooms.has(job.roomCode)) io.to(job.roomCode).emit('room:recording-play', job.item);
  const cleanupJob = setTimeout(() => pendingSharedRecordings.delete(id), 30000);
  cleanupJob.unref?.();
}
function errorTo(socket, message) { socket.emit('app:error', { message }); }
function completeIfReady(room) {
  const players = [...room.players.keys()];
  if (room.status === 'playing' && players.length > 0 && players.every(id => room.submissions.has(id))) {
    room.status = 'results';
  }
  broadcastRoom(room);
}
function unlinkSocket(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) { socket.data.roomCode = null; return; }
  socket.to(code).emit('voice:peer-left', { id: socket.id });
  room.players.delete(socket.id);
  room.submissions.delete(socket.id);
  for (const [recordingId, job] of pendingSharedRecordings) {
    if (job.roomCode !== code || !job.expected.has(socket.id)) continue;
    job.expected.delete(socket.id);
    if ([...job.expected].every(id => job.ready.has(id))) scheduleSharedRecording(recordingId);
  }
  socket.leave(code);
  socket.data.roomCode = null;
  if (room.players.size === 0) {
    rooms.delete(code);
  } else {
    if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
    completeIfReady(room);
  }
}
function getRoomForHost(socket) {
  const room = rooms.get(socket.data.roomCode);
  if (!room || room.hostId !== socket.id) return null;
  return room;
}

function getIceServers() {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];
  if (process.env.TURN_URL?.trim()) {
    const turn = {
      urls: process.env.TURN_URL.split(',').map(value => value.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || ''
    };
    if (turn.urls.length) servers.push(turn);
  }
  return servers;
}
app.get('/api/config', (_req, res) => res.json({
  aiScoring: Boolean(process.env.OPENAI_API_KEY),
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 18),
  iceServers: getIceServers()
}));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

app.post('/api/sounds', upload.single('audio'), (req, res) => {
  const code = tidy(req.body.roomCode, 6).toUpperCase();
  const socketId = tidy(req.body.socketId, 64);
  const room = rooms.get(code);
  const uploader = room?.players.get(socketId);
  if (!room || room.hostId !== socketId || !uploader || !req.body.playerToken || req.body.playerToken !== uploader.token) return res.status(403).json({ error: 'غير المضيف هو اللي يقدر يزيد الأصوات.' });
  if (!req.file) return res.status(400).json({ error: 'اختار ملف صوتي أولاً.' });
  const name = tidy(req.body.name || path.parse(req.file.originalname).name, 48) || 'صوت جديد';
  const ext = (path.extname(req.file.originalname || '').toLowerCase() || '.bin');
  if (!allowedExts.has(ext)) return res.status(415).json({ error: 'الصيغة غير مدعومة. جرّب WAV أو MP3 أو WEBM.' });
  const filename = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), req.file.buffer);
  const sound = { id: crypto.randomUUID(), name, filename, ext, url: `/uploads/${filename}`, size: req.file.size };
  room.sounds.push(sound);
  room.selectedSoundId = sound.id;
  io.to(code).emit('room:state', publicRoom(room));
  res.json({ ok: true, sound: { id: sound.id, name: sound.name, url: sound.url } });
});

// Store a short player recording and schedule it for room-wide playback at a shared server timestamp.
const recordingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext === '.wav' || file.mimetype === 'audio/wav' || file.mimetype === 'audio/x-wav') return cb(null, true);
    cb(new Error('التسجيل خاصو يكون WAV.'));
  }
});
app.post('/api/room-recordings', recordingUpload.single('recording'), (req, res) => {
  const code = tidy(req.body.roomCode, 6).toUpperCase();
  const socketId = tidy(req.body.socketId, 64);
  const room = rooms.get(code);
  const player = room?.players.get(socketId);
  if (!room || !player || !req.body.playerToken || req.body.playerToken !== player.token) {
    return res.status(403).json({ error: 'الغرفة أو اللاعب ما بقاش صالح.' });
  }
  if (!req.file) return res.status(400).json({ error: 'التسجيل الصوتي ناقص.' });
  const filename = `shared-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.wav`;
  const absolutePath = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(absolutePath, req.file.buffer);
  const item = {
    id: crypto.randomUUID(),
    playerName: player.name,
    url: `/uploads/${filename}`
  };
  const job = {
    roomCode: code,
    item,
    expected: new Set([...room.players.keys()]),
    ready: new Set(),
    scheduled: false,
    timeout: null
  };
  pendingSharedRecordings.set(item.id, job);
  job.timeout = setTimeout(() => scheduleSharedRecording(item.id), 8000);
  job.timeout.unref?.();
  io.to(code).emit('room:recording-preload', item);
  // Shared attempts are ephemeral: automatically remove the clip after 3 hours.
  const cleanup = setTimeout(() => fs.promises.unlink(absolutePath).catch(() => {}), 3 * 60 * 60 * 1000);
  cleanup.unref?.();
  res.json({ ok: true });
});

// Optional model-based judging. Uploaded audio is sent only when an API key is configured.
app.post('/api/score-ai', upload.single('recording'), async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'تقييم AI ما مفعّلش. استعملنا التقييم المحلي.' });
  const code = tidy(req.body.roomCode, 6).toUpperCase();
  const socketId = tidy(req.body.socketId, 64);
  const room = rooms.get(code);
  const scorer = room?.players.get(socketId);
  if (!room || room.status !== 'playing' || !scorer || !req.body.playerToken || req.body.playerToken !== scorer.token) return res.status(403).json({ error: 'الجولة سالات أو الغرفة ما بقاتش صالحة.' });
  if (room.submissions.has(socketId)) return res.status(409).json({ error: 'سبق ليك رسلتي النتيجة.' });
  if (!req.file) return res.status(400).json({ error: 'التسجيل الصوتي ناقص.' });
  const sound = room.sounds.find(s => s.id === room.currentSoundId);
  if (!sound) return res.status(400).json({ error: 'ما كاينش صوت مرجعي لهاد الجولة.' });
  const refExt = sound.ext.replace('.', '');
  const recExt = path.extname(req.file.originalname || '').toLowerCase().replace('.', '');
  if (!['wav', 'mp3'].includes(refExt) || !['wav', 'mp3'].includes(recExt)) {
    return res.status(415).json({ error: 'AI كيدعم حالياً المرجع والتسجيل بصيغة WAV أو MP3. جرّب WAV/MP3 أو خدم بالتقييم المحلي.' });
  }
  try {
    const referenceBuffer = fs.readFileSync(path.join(UPLOAD_DIR, sound.filename));
    const body = {
      model: process.env.OPENAI_AUDIO_MODEL || 'gpt-4o-audio-preview',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'You are a fair judge in a playful audio-imitation party game. Clip 1 is the reference sound; clip 2 is the player imitating it, usually with their voice. Judge how recognizably the player copied the timing/rhythm, pitch or intonation contour, envelope, and characteristic pattern. Do not demand identical timbre because a human voice will sound different from an animal/object/instrument. Ignore harmless background noise. Give a fun, fair integer score 0-100 and brief constructive feedback in Moroccan Darija or simple Arabic. Return ONLY valid JSON in this shape: {"score": 0, "feedback": "..."}.' },
          { type: 'input_audio', input_audio: { data: referenceBuffer.toString('base64'), format: refExt } },
          { type: 'input_audio', input_audio: { data: req.file.buffer.toString('base64'), format: recExt } }
        ]
      }],
      max_completion_tokens: 180,
      temperature: 0.2
    };
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('Audio judge API error:', response.status, payload.error?.message || 'unknown');
      return res.status(502).json({ error: 'AI ما قدرش يقيّم هاد التسجيل دابا. غادي نجرب التقييم المحلي.' });
    }
    const raw = payload.choices?.[0]?.message?.content || '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return res.status(502).json({ error: 'AI رجع جواب غير متوقع. غادي نجرب التقييم المحلي.' });
    const result = JSON.parse(match[0]);
    const score = Math.max(0, Math.min(100, Math.round(Number(result.score))));
    if (!Number.isFinite(score)) throw new Error('AI score was not numeric');
    res.json({ score, feedback: tidy(result.feedback || 'محاولة زوينة!', 180), method: 'AI' });
  } catch (err) {
    console.error('AI scoring error:', err.message);
    res.status(502).json({ error: 'وقع خطأ فالتقييم بالذكاء الاصطناعي. غادي نجرب التقييم المحلي.' });
  }
});

io.on('connection', socket => {
  socket.on('time:sync', ack => {
    if (typeof ack === 'function') ack({ serverNow: Date.now() });
  });
  socket.on('room:leave', ack => { unlinkSocket(socket); if (typeof ack === 'function') ack({ ok: true }); });
  socket.on('room:create', (payload = {}, ack = () => {}) => {
    unlinkSocket(socket);
    const name = tidy(payload.name, 24) || 'لاعب';
    const code = makeCode();
    const room = { code, hostId: socket.id, status: 'lobby', roundId: 0, players: new Map(), sounds: [], selectedSoundId: null, currentSoundId: null, submissions: new Map() };
    const playerToken = crypto.randomBytes(24).toString('hex');
    room.players.set(socket.id, { id: socket.id, name, totalScore: 0, token: playerToken, voiceReady: false, voiceMuted: true });
    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.join(code);
    ack({ ok: true, roomCode: code, playerToken });
    broadcastRoom(room);
  });
  socket.on('room:join', (payload = {}, ack = () => {}) => {
    unlinkSocket(socket);
    const code = tidy(payload.code, 6).toUpperCase();
    const room = rooms.get(code);
    if (!room) return ack({ ok: false, error: 'ما لقيناش هاد الغرفة. تأكد من الرمز.' });
    if (room.players.size >= MAX_PLAYERS) return ack({ ok: false, error: `الغرفة عامرة (الحد الأقصى ${MAX_PLAYERS} لاعبين).` });
    if (room.status === 'playing') return ack({ ok: false, error: 'الجولة بدات، تسنى حتى تسالي باش تدخل.' });
    const name = tidy(payload.name, 24) || 'لاعب';
    const playerToken = crypto.randomBytes(24).toString('hex');
    room.players.set(socket.id, { id: socket.id, name, totalScore: 0, token: playerToken, voiceReady: false, voiceMuted: true });
    socket.data.roomCode = code;
    socket.join(code);
    ack({ ok: true, roomCode: code, playerToken });
    broadcastRoom(room);
  });
  socket.on('room:recording-ready', (payload = {}) => {
    const roomCode = socket.data.roomCode;
    const job = pendingSharedRecordings.get(tidy(payload.id, 64));
    if (!job || job.scheduled || job.roomCode !== roomCode || !job.expected.has(socket.id)) return;
    job.ready.add(socket.id);
    if ([...job.expected].every(id => job.ready.has(id))) scheduleSharedRecording(job.item.id);
  });
  socket.on('voice:ready', (payload = {}) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.id);
    if (!room || !player) return;
    const enabled = payload.enabled === true;
    player.voiceReady = enabled;
    player.voiceMuted = !enabled;
    if (enabled) {
      const peers = [...room.players.values()]
        .filter(p => p.id !== socket.id && p.voiceReady)
        .map(p => ({ id: p.id, name: p.name, muted: Boolean(p.voiceMuted) }));
      socket.emit('voice:peers', peers);
      socket.to(room.code).emit('voice:peer-ready', { id: socket.id, name: player.name, muted: false });
    } else {
      socket.to(room.code).emit('voice:peer-left', { id: socket.id });
    }
    broadcastRoom(room);
  });
  socket.on('voice:mute', (payload = {}) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.id);
    if (!room || !player || !player.voiceReady) return;
    player.voiceMuted = payload.muted !== false;
    socket.to(room.code).emit('voice:peer-mute', { id: socket.id, muted: player.voiceMuted });
    broadcastRoom(room);
  });
  socket.on('voice:signal', (payload = {}) => {
    const room = rooms.get(socket.data.roomCode);
    const from = room?.players.get(socket.id);
    const targetId = tidy(payload.targetId, 64);
    const target = room?.players.get(targetId);
    const signal = payload.signal;
    if (!room || !from?.voiceReady || !target?.voiceReady || targetId === socket.id || !signal || !['offer', 'answer', 'candidate'].includes(signal.type)) return;
    // Keep signaling payloads small; media itself travels peer-to-peer via WebRTC.
    try { if (JSON.stringify(signal).length > 100000) return; } catch { return; }
    io.to(targetId).emit('voice:signal', { fromId: socket.id, signal });
  });
  socket.on('room:select-sound', payload => {
    const room = getRoomForHost(socket);
    if (!room || room.status === 'playing') return;
    if (room.sounds.some(s => s.id === payload?.soundId)) room.selectedSoundId = payload.soundId;
    broadcastRoom(room);
  });
  socket.on('round:start', payload => {
    const room = getRoomForHost(socket);
    if (!room) return errorTo(socket, 'غير المضيف هو اللي يقدر يبدا الجولة.');
    if (room.status === 'playing') return errorTo(socket, 'الجولة الحالية مازال خدامة.');
    const sound = room.sounds.find(s => s.id === payload?.soundId || s.id === room.selectedSoundId);
    if (!sound) return errorTo(socket, 'زيد صوت من المكتبة قبل ما تبدا.');
    if (room.players.size < 1) return;
    room.currentSoundId = sound.id;
    room.selectedSoundId = sound.id;
    room.roundId += 1;
    room.submissions.clear();
    room.status = 'playing';
    io.to(room.code).emit('round:started', { roundId: room.roundId, sound: { id: sound.id, name: sound.name, url: sound.url }, seconds: 8 });
    broadcastRoom(room);
  });
  socket.on('round:submit', payload => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing' || room.submissions.has(socket.id) || !room.players.has(socket.id)) return;
    const score = Math.max(0, Math.min(100, Math.round(Number(payload?.score))));
    if (!Number.isFinite(score)) return errorTo(socket, 'النتيجة غير صالحة.');
    const player = room.players.get(socket.id);
    const result = { score, feedback: tidy(payload?.feedback || '', 180), method: payload?.method === 'AI' ? 'AI' : 'محلي', name: player.name };
    room.submissions.set(socket.id, result);
    player.totalScore = (player.totalScore || 0) + score;
    completeIfReady(room);
  });
  socket.on('round:pass', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing' || room.submissions.has(socket.id) || !room.players.has(socket.id)) return;
    const player = room.players.get(socket.id);
    room.submissions.set(socket.id, { score: 0, feedback: 'دوزتي هاد الجولة.', method: 'محلي', name: player.name });
    completeIfReady(room);
  });
  socket.on('round:back-to-lobby', () => {
    const room = getRoomForHost(socket);
    if (!room || room.status !== 'results') return;
    room.status = 'lobby';
    room.currentSoundId = null;
    room.submissions.clear();
    broadcastRoom(room);
  });
  socket.on('disconnect', () => unlinkSocket(socket));
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `الملف كبير بزاف. الحد الأقصى ${process.env.MAX_UPLOAD_MB || 18} MB.` });
  if (err) return res.status(400).json({ error: err.message || 'وقع خطأ غير متوقع.' });
  res.status(500).json({ error: 'خطأ داخلي.' });
});
server.listen(PORT, '0.0.0.0', () => console.log(`MimicParty MVP running on http://localhost:${PORT}`));
