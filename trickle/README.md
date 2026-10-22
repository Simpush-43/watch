# Trickle

Upload a video once. Friend opens the link and watches on very little data.

It re-encodes your upload into HLS at 144p / 240p / 360p / 480p (H.264 + AAC, 4s segments).
The 480p version is encoded at a reduced bitrate (about 247 MB per hour) to use less data
while keeping 480p resolution. The watch page starts at 480p when available; choose a lower
resolution to save more data. Segments are cached by the browser, so re-watching costs nothing.

## Run it

Needs Node 18+. FFmpeg and ffprobe are installed locally with the project dependencies; you do not need to install them system-wide or add them to PATH.

    npm install
    UPLOAD_PASSWORD=pickSomething node server.js

Open http://localhost:3000, upload, wait for 480p to finish, then copy the link.

Windows (PowerShell):  $env:UPLOAD_PASSWORD="pickSomething"; node server.js

## Let your friend reach it

- Quick, free, from your own PC: `cloudflared tunnel --url http://localhost:3000` and send the
  https link it prints. Your PC must stay on, and the stream uses your upload bandwidth
  (240p needs only about 0.3 Mbps).
- Always on: a small VPS (Hetzner, Oracle free tier, DigitalOcean). Same commands, run with pm2.
- Vercel / Netlify will NOT work: no ffmpeg, no persistent disk, tiny upload limits.

## Notes

- The password protects upload, listing and delete. Watching only needs the link (24 random hex chars).
- Source files are deleted after encoding; only the small versions are kept in ./data.
- Encodes one video at a time. A 1 hour video takes roughly 10-25 min on a modest CPU.
- iPhone/Safari plays through native HLS and has no quality picker; it uses 480p when available.
