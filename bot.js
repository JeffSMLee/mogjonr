// Trob bot: listens in a voice channel and plays a random clip whenever someone says "trob".
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  entersState,
  EndBehaviorType,
  AudioPlayerStatus,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import OpusScript from 'opusscript';

const TOKEN = process.env.DISCORD_TOKEN;
const STT_URL = process.env.STT_URL ?? 'http://127.0.0.1:8765/transcribe';
const CLIPS_DIR = process.env.CLIPS_DIR ?? './clips';
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? 4000);            // cooldown after an isolated trob
const MAX_COOLDOWN_MS = Number(process.env.MAX_COOLDOWN_MS ?? 300_000);   // 5 min cap
const HEAT_HALF_LIFE_MS = Number(process.env.HEAT_HALF_LIFE_MS ?? 120_000); // off-cooldown time for built-up heat to halve
const RAPID_WINDOW_MS = Number(process.env.RAPID_WINDOW_MS ?? 30_000);    // plays closer together than ~this add extra heat
const HEAT_BASE = 1.1; // each point of heat multiplies the cooldown by this
const MAX_HEAT = 1 + Math.log(MAX_COOLDOWN_MS / COOLDOWN_MS) / Math.log(HEAT_BASE);

// Speech recognizers often hear "trob" as "throb", "t-rob", "trobe", etc. Tune this after testing.
const TRIGGER = /\b(t[\s-]?rob+e?s?|throb+s?|trobb?e?)\b/i;

const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.opus', '.m4a', '.flac']);
const SILENCE_MS = 700;        // end of an utterance = this much silence
const MIN_BYTES = 48000 * 2 * 0.3; // ignore utterances under ~0.3 s (48 kHz mono s16)
const MAX_BYTES = 48000 * 2 * 15;  // cap at 15 s

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// Per-guild state: audio player, last-played time, users currently being captured
const guilds = new Map();

function randomClip() {
  const files = fs.readdirSync(CLIPS_DIR).filter((f) => AUDIO_EXT.has(path.extname(f).toLowerCase()));
  if (!files.length) return null;
  return path.join(CLIPS_DIR, files[Math.floor(Math.random() * files.length)]);
}

async function transcribe(pcm) {
  const res = await fetch(STT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: pcm,
  });
  if (!res.ok) throw new Error(`STT server returned ${res.status}`);
  return (await res.json()).text ?? '';
}

// Escalating cooldown: every play adds "heat", and the cooldown is COOLDOWN_MS * HEAT_BASE^(heat - 1), capped at
// MAX_COOLDOWN_MS. A play adds 1 heat, plus up to 2 more the sooner it follows the previous play. Heat halves
// every HEAT_HALF_LIFE_MS the bot spends off cooldown, so the cooldown shrinks back toward COOLDOWN_MS.
function nextCooldown(state, now) {
  const idle = Math.max(0, now - state.cooldownUntil);
  const gap = now - state.lastPlayed;
  state.heat *= 0.5 ** (idle / HEAT_HALF_LIFE_MS);
  state.heat = Math.min(MAX_HEAT, state.heat + 1 + 2 * Math.exp(-gap / RAPID_WINDOW_MS));
  return Math.min(MAX_COOLDOWN_MS, COOLDOWN_MS * HEAT_BASE ** (state.heat - 1));
}

// Server nickname (or display name if none). Members in voice channels are normally cached already;
// fall back to the API, then to the raw ID.
async function displayName(guildId, userId) {
  const guild = client.guilds.cache.get(guildId);
  const member = guild?.members.cache.get(userId) ?? (await guild?.members.fetch(userId).catch(() => null));
  return member?.displayName ?? userId;
}

function playRandomClip(guildId) {
  const state = guilds.get(guildId);
  if (!state) return;
  const now = Date.now();
  if (now < state.cooldownUntil) return;
  if (state.player.state.status !== AudioPlayerStatus.Idle) return;

  const clip = randomClip();
  if (!clip) return console.warn(`No audio files found in ${CLIPS_DIR}`);
  const cooldown = nextCooldown(state, now);
  state.lastPlayed = now;
  state.cooldownUntil = now + cooldown;
  state.player.play(createAudioResource(clip));
  console.log(`▶ ${path.basename(clip)} (next cooldown ${Math.round(cooldown / 1000)}s)`);
}

function startListening(connection, guildId) {
  const player = createAudioPlayer();
  connection.subscribe(player);
  player.on('error', (e) => console.error('Player error:', e.message));

  const state = { player, lastPlayed: 0, cooldownUntil: 0, heat: 0, capturing: new Set() };
  guilds.set(guildId, state);

  const { receiver } = connection;
  receiver.speaking.on('start', (userId) => {
    if (state.capturing.has(userId)) return;
    state.capturing.add(userId);

    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
    });
    // Decode packet-by-packet instead of piping into prism's Decoder: a single undecodable packet
    // (e.g. still E2EE-encrypted while the DAVE session is settling) would destroy that stream,
    // 'end' would never fire, and this user would stay stuck in `capturing` forever.
    const decoder = new OpusScript(48000, 1, OpusScript.Application.VOIP);
    const chunks = [];
    let size = 0;
    let badPackets = 0;
    let finished = false;

    const done = async () => {
      if (finished) return;
      finished = true;
      decoder.delete();
      state.capturing.delete(userId);
      const name = await displayName(guildId, userId);
      if (badPackets) console.warn(`[${name}] skipped ${badPackets} undecodable packet(s)`);
      if (size < MIN_BYTES) return;
      let pcm = Buffer.concat(chunks);
      if (pcm.length > MAX_BYTES) pcm = pcm.subarray(pcm.length - MAX_BYTES);
      try {
        const text = await transcribe(pcm);
        if (text) console.log(`[${name}] ${text}`);
        if (TRIGGER.test(text)) playRandomClip(guildId);
      } catch (e) {
        console.error('Transcription failed:', e.message);
      }
    };

    opusStream.on('data', (packet) => {
      if (finished) return;
      try {
        const pcm = decoder.decode(packet);
        chunks.push(pcm);
        size += pcm.length;
      } catch {
        badPackets++;
      }
    });
    opusStream.once('end', done);
    opusStream.once('close', done); // stream destroyed without ending (e.g. /leave mid-sentence)
    opusStream.on('error', (e) => console.error('Receive error:', e.message));
  });
}

client.once(Events.ClientReady, async (c) => {
  const commands = [
    { name: 'join', description: 'Join your voice channel and listen for "trob"' },
    { name: 'leave', description: 'Leave the voice channel' },
  ];
  for (const guild of c.guilds.cache.values()) await guild.commands.set(commands);
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;
  const guildId = interaction.guild.id;

  if (interaction.commandName === 'join') {
    const channel = interaction.member?.voice?.channel;
    if (!channel) {
      return interaction.reply({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply();
    getVoiceConnection(guildId)?.destroy();

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: false, // must be false or the bot receives no audio
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      connection.destroy();
      return interaction.editReply('Could not connect to voice.');
    }
    startListening(connection, guildId);
    return interaction.editReply(`Listening in **${channel.name}** 👂`);
  }

  if (interaction.commandName === 'leave') {
    getVoiceConnection(guildId)?.destroy();
    guilds.delete(guildId);
    return interaction.reply('Bye 👋');
  }
});

client.login(TOKEN);
