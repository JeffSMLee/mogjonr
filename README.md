Don't make him mog you...

# Trob bot

A Discord bot that sits in a voice channel, listens to what people say, and plays a random clip from `clips/` whenever someone says "trob". Speech is transcribed locally with [faster-whisper](https://github.com/SYSTRAN/faster-whisper), so no audio leaves your machine.

It has two parts that run side by side:

- `bot.js`: the Discord bot (Node.js).
- `stt_server.py`: a small local speech-to-text server the bot sends audio to (Python).

## Requirements

- [Node.js](https://nodejs.org/) 22.12 or newer
- [Python](https://www.python.org/) 3.9 or newer
- Optional: an NVIDIA GPU for faster transcription. The server falls back to CPU automatically.

## 1. Create the Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. Open the **Bot** tab and click **Reset Token**. Copy the token; you'll need it in step 3.
3. Open **OAuth2 → URL Generator**:
   - Scopes: `bot` and `applications.commands`
   - Bot permissions: **View Channels**, **Connect** and **Speak**
4. Open the generated URL and add the bot to your server.

No privileged intents are needed.

## 2. Install

```sh
git clone https://github.com/JeffSMLee/mogjonr.git
cd mogjonr
npm install
pip install faster-whisper numpy scipy
```

For GPU transcription, also install the CUDA 12 libraries:

```sh
pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
```

## 3. Configure

Copy the example settings file and fill in your bot token:

```sh
cp .env.example .env
```

On Windows PowerShell, use `Copy-Item .env.example .env`. Then open `.env` and set `DISCORD_TOKEN`.

| Setting | Default | What it does |
|---|---|---|
| `DISCORD_TOKEN` | (required) | Your bot token from step 1 |
| `STT_URL` | `http://127.0.0.1:8765/transcribe` | Where the speech-to-text server is running |
| `CLIPS_DIR` | `./clips` | Folder of clips to play |
| `COOLDOWN_MS` | `4000` | Cooldown after an isolated trob |
| `MAX_COOLDOWN_MS` | `300000` | Longest the cooldown can get (5 min) |
| `HEAT_HALF_LIFE_MS` | `240000` | How quickly the cooldown shrinks back down when nobody triggers it |
| `RAPID_WINDOW_MS` | `150000` | Triggers closer together than about this count as rapid and grow the cooldown faster |

Every trob makes the next cooldown longer, and rapid repeats make it grow much faster. The cooldown shrinks back toward `COOLDOWN_MS` over time.

The speech-to-text server reads its own settings from environment variables:

| Setting | Default | What it does |
|---|---|---|
| `WHISPER_MODEL` | `base.en` | Whisper model. Try `small.en` if it misses "trob" too often |
| `WHISPER_DEVICE` | `auto` | `cuda`, `cpu` or `auto` |
| `STT_HOST` / `STT_PORT` | `127.0.0.1` / `8765` | Address the server listens on |

## 4. Run

Start the speech-to-text server in one terminal:

```sh
python stt_server.py
```

The first run downloads the Whisper model. Wait for the `STT server on http://...` line.

Then start the bot in a second terminal:

```sh
npm start
```

## 5. Use it

In Discord, join a voice channel, then:

- `/join`: the bot joins your channel and starts listening.
- `/leave`: the bot leaves.

Say "trob" and it plays a random clip. The terminal shows what it heard from each person and which clip it played.

## Adding clips

Drop any `.mp3`, `.wav`, `.ogg`, `.opus`, `.m4a` or `.flac` file into `clips/`. The bot picks new files up on the next trob, with no restart needed.

To cut a clip out of a video or recording with [ffmpeg](https://ffmpeg.org/):

```sh
ffmpeg -ss 37 -to 37.5 -i recording.mp4 -vn -ac 2 clips/my_clip.mp3
```

Add `-af volume=6dB` to make it louder, or a negative value to make it quieter.

To grab a section of a YouTube video with [yt-dlp](https://github.com/yt-dlp/yt-dlp):

```sh
yt-dlp -x --audio-format mp3 --force-keyframes-at-cuts --download-sections "*0:08-0:09" -o "clips/%(title)s.%(ext)s" "<video URL>"
```
