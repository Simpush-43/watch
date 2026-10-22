const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.UPLOAD_PASSWORD || ''; // set this so only YOU can upload/list/delete
const DATA = path.join(__dirname, 'data');
const SRC = path.join(DATA, '.src'); // dotfolder: never served
fs.mkdirSync(SRC, { recursive: true });

// Low-data ladder. bw = bits/sec (video+audio). Encoded in this order so 240p is watchable first.
const LADDER = [
  { name: '240p', h: 240, v: '220k', buf: '440k',  a: '48k', bw: 280000 },
  { name: '144p', h: 144, v: '90k',  buf: '180k',  a: '32k', bw: 130000 },
  { name: '360p', h: 360, v: '450k', buf: '900k',  a: '64k', bw: 520000 },
  { name: '480p', h: 480, v: '500k', buf: '1000k', a: '48k', bw: 548000 },
];

const app = express();

function auth(req, res, next) {
  if (!PASSWORD) return next();
  const given = Buffer.from(String(req.get('x-password') || ''));
  const want = Buffer.from(PASSWORD);
  if (given.length === want.length && crypto.timingSafeEqual(given, want)) return next();
  res.status(401).json({ error: 'Wrong password' });
}

const validId = (id) => /^[a-f0-9]{24}$/.test(id);
const metaPath = (id) => path.join(DATA, id, 'meta.json');
const readMeta = (id) => { try { return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')); } catch { return null; } };
const writeMeta = (m) => fs.writeFileSync(metaPath(m.id), JSON.stringify(m, null, 1));

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    p.on('error', (e) => reject(new Error(`Could not start ${cmd}. Reinstall the project dependencies. (${e.message})`)));
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(err.slice(-400) || `${cmd} exited ${c}`))));
  });
}

async function probe(file) {
  const out = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=height:format=duration', '-of', 'json', file]);
  const j = JSON.parse(out);
  return { height: (j.streams && j.streams[0] && j.streams[0].height) || 0, duration: parseFloat(j.format && j.format.duration) || 0 };
}

function writeMaster(m) {
  const rungs = LADDER.filter((r) => m.done.includes(r.name)).sort((a, b) => a.bw - b.bw);
  let s = '#EXTM3U\n#EXT-X-VERSION:3\n';
  for (const r of rungs) s += `#EXT-X-STREAM-INF:BANDWIDTH=${r.bw},NAME="${r.name}"\n${r.name}/index.m3u8\n`;
  fs.writeFileSync(path.join(DATA, m.id, 'master.m3u8'), s);
}

// One encode at a time so a small server doesn't melt.
const queue = [];
let busy = false;
function enqueue(job) { queue.push(job); pump(); }
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) await encode(queue.shift());
  busy = false;
}

async function encode({ id, file }) {
  const m = readMeta(id);
  try {
    for (const name of m.plan) {
      const r = LADDER.find((x) => x.name === name);
      m.current = name; writeMeta(m);
      const dir = path.join(DATA, id, name);
      fs.mkdirSync(dir, { recursive: true });
      await run(ffmpeg, [
        '-y', '-i', file, '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', `scale=-2:${r.h}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
        '-b:v', r.v, '-maxrate', r.v, '-bufsize', r.buf,
        '-force_key_frames', 'expr:gte(t,n_forced*4)', '-sc_threshold', '0',
        '-c:a', 'aac', '-b:a', r.a, '-ac', '2',
        '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
        '-hls_segment_filename', path.join(dir, 'seg_%04d.ts'),
        path.join(dir, 'index.m3u8'),
      ]);
      m.done.push(name);
      writeMaster(m); writeMeta(m);
    }
    m.status = 'ready';
  } catch (e) {
    m.status = m.done.length ? 'ready' : 'failed';
    m.error = e.message;
  }
  m.current = null;
  writeMeta(m);
  fs.rm(file, { force: true }, () => {});
}

const upload = multer({
  storage: multer.diskStorage({
    destination: SRC,
    filename: (req, f, cb) => cb(null, crypto.randomBytes(8).toString('hex') + path.extname(f.originalname).toLowerCase().slice(0, 8)),
  }),
  limits: { fileSize: 8 * 1024 ** 3 },
});

app.get('/api/config', (req, res) =>
  res.json({ needsPassword: !!PASSWORD, ladder: LADDER.map(({ name, bw }) => ({ name, bw })) }));

app.post('/api/upload', auth, upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  const id = crypto.randomBytes(12).toString('hex');
  try {
    const { height, duration } = await probe(req.file.path);
    if (!height) throw new Error('No video stream found in that file');
    fs.mkdirSync(path.join(DATA, id), { recursive: true });
    const plan = LADDER.filter((r) => r.h <= height).map((r) => r.name);
    const title = (req.body.title || '').trim() || req.file.originalname.replace(/\.[^.]+$/, '');
    const m = {
      id, title: title.slice(0, 120), duration, height,
      plan: plan.length ? plan : ['144p'],
      done: [], status: 'processing', current: null, error: null, createdAt: Date.now(),
    };
    writeMeta(m);
    enqueue({ id, file: req.file.path });
    res.json({ id });
  } catch (e) {
    fs.rm(req.file.path, { force: true }, () => {});
    res.status(400).json({ error: e.message });
  }
});

// Listing needs the password. Watching only needs the link (24 random hex chars).
app.get('/api/videos', auth, (req, res) => {
  const list = fs.readdirSync(DATA).filter(validId).map(readMeta).filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json(list);
});

app.get('/api/videos/:id', (req, res) => {
  const m = validId(req.params.id) && readMeta(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  res.json(m);
});

app.delete('/api/videos/:id', auth, (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  fs.rmSync(path.join(DATA, req.params.id), { recursive: true, force: true });
  res.json({ ok: true });
});

// Segments never change, so browsers cache them: re-watching costs zero data.
app.use('/media', express.static(DATA, {
  dotfiles: 'deny', index: false,
  setHeaders: (res, p) => res.setHeader('Cache-Control',
    p.endsWith('.ts') ? 'public, max-age=31536000, immutable' : 'no-cache'),
}));

app.get('/v/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'watch.html')));
app.use(express.static(path.join(__dirname, 'public')));

// Jobs interrupted by a restart can't resume; mark them so the UI doesn't spin forever.
for (const id of fs.readdirSync(DATA).filter(validId)) {
  const m = readMeta(id);
  if (m && m.status === 'processing') {
    m.status = m.done.length ? 'ready' : 'failed';
    m.error = 'Server restarted during encoding. Re-upload for the missing qualities.';
    m.current = null; writeMeta(m);
  }
}

app.listen(PORT, () => console.log(`Trickle running on http://localhost:${PORT}` + (PASSWORD ? '' : '  (WARNING: no UPLOAD_PASSWORD set, anyone can upload)')));
