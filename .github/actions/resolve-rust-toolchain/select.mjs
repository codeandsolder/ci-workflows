import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY = 86_400_000;
const QUARANTINE = 3 * DAY;

export function nightlyDate(channel) {
  if (!/^nightly-\d{4}-\d{2}-\d{2}$/.test(channel)) throw Error('expected a dated nightly: ' + channel);
  const day = channel.slice(8);
  const date = Date.parse(day + 'T00:00:00Z');
  if (!Number.isFinite(date) || new Date(date).toISOString().slice(0,10) !== day) {
    throw Error('invalid nightly date: ' + channel);
  }
  return date;
}

export function readPin(text) {
  // This is the rustup [toolchain] table, not a general TOML parser.
  const table = text.match(/^\[toolchain\][ \t]*(?:#.*)?\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m);
  const pins = table?.[1].match(/^[ \t]*channel[ \t]*=[ \t]*["'][^"'\r\n]+["'][ \t]*(?:#.*)?$/gm) ?? [];
  if (pins.length !== 1) throw Error('expected exactly one literal [toolchain].channel');
  return pins[0].match(/=[ \t]*["']([^"']+)["']/)[1];
}

export function chooseToolchain({ tier, requested, caller, fleet }) {
  nightlyDate(fleet);
  if (tier === 'release') {
    // Explicit external compatibility contracts may still be tested at release.
    const selected = requested || caller;
    if (!selected) throw Error('release CI requires an explicit compatibility compiler or a native repository pin');
    return selected;
  }
  if (tier !== 'routine') throw Error('unknown validation tier: ' + tier);
  if (!caller) throw Error('routine CI requires a root rust-toolchain.toml');
  const selected = caller;
  nightlyDate(selected);
  if (requested && requested !== selected) throw Error('routine CI compiler must match the repository pin: ' + selected);
  return selected;
}

export function publicationTime(channel, lastModified, now) {
  const date = nightlyDate(channel);
  const published = Date.parse(lastModified ?? '');
  if (!Number.isFinite(published) || published < date || published > now) {
    throw Error('missing or invalid nightly manifest publication timestamp: ' + channel);
  }
  return published;
}

export async function publication(channel, now = Date.now(), request = fetch) {
  nightlyDate(channel);
  const response = await request('https://static.rust-lang.org/dist/' + channel.slice(8) +
    '/channel-rust-nightly.toml', { method: 'HEAD', signal: AbortSignal.timeout(20_000) });
  if (response.status === 404 || response.status === 403) return null;
  if (!response.ok) throw Error('nightly manifest lookup returned HTTP ' + response.status);
  return publicationTime(channel, response.headers.get('last-modified'), now);
}

export async function requireAge(channel, now = Date.now(), lookup = publication) {
  const published = await lookup(channel, now);
  if (published === null || now - published < QUARANTINE) {
    throw Error('nightly unavailable or below 72-hour quarantine: ' + channel);
  }
  return published;
}

export async function latestCandidate(current, now = Date.now(), lookup = publication) {
  const currentDate = nightlyDate(current);
  // A compiler change invalidates cache entries. Do not rotate more often than weekly.
  // The selected date must itself be at least seven days newer than the approved pin.
  for (let date = Math.floor((now - QUARANTINE) / DAY) * DAY;
    date >= currentDate + 7 * DAY; date -= DAY) {
    const channel = 'nightly-' + new Date(date).toISOString().slice(0,10);
    const published = await lookup(channel, now);
    if (published !== null && now - published >= QUARANTINE) return channel;
  }
  return null;
}

export function loadCaller(path) {
  const manifest = join(path, 'rust-toolchain.toml');
  const legacy = join(path, 'rust-toolchain');
  if (existsSync(legacy)) throw Error('use a native rust-toolchain.toml rather than rust-toolchain');
  return existsSync(manifest) ? readPin(readFileSync(manifest, 'utf8')) : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    if (mode === 'age' && args.length === 1) {
      console.log(new Date(await requireAge(args[0])).toISOString());
    } else if (mode === 'candidate' && args.length === 1) {
      console.log(await latestCandidate(args[0]) || '');
    } else if (mode === 'resolve' && args.length === 4) {
      const [tier, requested, callerDir, fleetManifest] = args;
      const channel = chooseToolchain({ tier, requested, caller: loadCaller(callerDir),
        fleet: readPin(readFileSync(fleetManifest, 'utf8')) });
      if (channel.startsWith('nightly')) await requireAge(channel);
      console.log(channel);
    } else {
      throw Error('usage: select.mjs age CHANNEL | candidate CURRENT | resolve TIER REQUESTED CALLER_DIR FLEET_MANIFEST');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
