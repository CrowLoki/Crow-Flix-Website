import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

// Entirely synthetic, silent testsrc2 video. No provider media is downloaded.
export const MAX_FIXTURE_BYTES = 2 * 1024 * 1024;
export const FIXTURE_HOSTS = new Set([
  "direct.playback.test", "redirect.playback.test", "cdn.playback.test",
  "fallback.playback.test", "headers.playback.test",
]);
export const PROVIDER_HEADERS = {
  "User-Agent": "CrowFlix acceptance fixture",
  Referer: "https://headers.playback.test/watch",
};

async function encode(ffmpeg, args, signal, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
      stdio: ["ignore", "ignore", "pipe"], windowsHide: true, signal, cwd,
    });
    let diagnostic = "";
    const timeout = setTimeout(() => child.kill(), 30_000);
    child.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk).slice(-4_000); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code, exitSignal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Fixture encoder failed (${code ?? exitSignal}): ${diagnostic}`));
    });
  });
}

export async function generateMediaFixtures(directory, { ffmpeg = "ffmpeg", signal } = {}) {
  // mkdir must create a new directory: never overwrite an existing fixture set.
  await mkdir(directory);
  await mkdir(path.join(directory, "hls"));
  await mkdir(path.join(directory, "dash"));
  const progressive = path.join(directory, "progressive.mp4");
  await encode(ffmpeg, [
    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=12", "-t", "12", "-an",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "32", "-pix_fmt", "yuv420p",
    "-g", "24", "-keyint_min", "24", "-sc_threshold", "0", "-threads", "1",
    "-movflags", "+faststart", progressive,
  ], signal, directory);
  await encode(ffmpeg, [
    "-i", progressive, "-c", "copy", "-hls_time", "2", "-hls_list_size", "0",
    "-hls_playlist_type", "vod", "-hls_segment_filename", path.join(directory, "hls", "seg-%03d.ts"),
    "manifest.m3u8",
  ], signal, path.join(directory, "hls"));
  await encode(ffmpeg, [
    "-i", progressive, "-c", "copy", "-f", "dash", "-seg_duration", "2",
    "-use_template", "1", "-use_timeline", "1", "-init_seg_name", "init-$RepresentationID$.m4s",
    "-media_seg_name", "seg-$RepresentationID$-$Number%05d$.m4s", "manifest.mpd",
  ], signal, path.join(directory, "dash"));
  const files = [];
  async function inventory(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await inventory(absolute);
      else {
        assert.ok(entry.isFile(), "Fixtures must contain regular files only");
        const { size } = await stat(absolute);
        assert.ok(size > 0 && size <= MAX_FIXTURE_BYTES, "Each fixture must be nonempty and bounded");
        files.push({ name: path.relative(directory, absolute).replaceAll(path.sep, "/"), size });
      }
    }
  }
  await inventory(directory);
  assert.ok(files.some((file) => file.name === "dash/init-0.m4s")
    && files.filter((file) => /^dash\/seg-/.test(file.name)).length === 6,
  "The owned DASH directory must contain its initialization and six media segments");
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  assert.ok(bytes <= MAX_FIXTURE_BYTES, "The entire generated fixture set must stay under 2 MiB");
  return { durationSeconds: 12, width: 160, height: 90, fps: 12, bytes, files };
}

export function fixtureUrl(raw) {
  const url = new URL(raw);
  assert.ok(url.protocol === "https:" && FIXTURE_HOSTS.has(url.hostname)
    && !url.port && !url.username && !url.password, "Only owned synthetic fixture URLs are allowed");
  return url;
}

export function byteRange(value, length) {
  if (value === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new Error("Invalid fixture byte range");
  let start = match[1] ? Number(match[1]) : Math.max(0, length - Number(match[2]));
  let end = match[1] && match[2] ? Number(match[2]) : length - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start >= length || start > end || (!match[1] && Number(match[2]) === 0)) {
    throw new Error("Unsatisfiable fixture byte range");
  }
  return { start, end: Math.min(end, length - 1) };
}

const TYPES = {
  ".mp4": "video/mp4", ".m4s": "video/mp4", ".ts": "video/mp2t",
  ".m3u8": "application/vnd.apple.mpegurl", ".mpd": "application/dash+xml",
};

export async function fixtureResponse(directory, raw, init = {}, { throughRelay = false } = {}) {
  const url = fixtureUrl(raw);
  if (url.hostname === "redirect.playback.test") {
    assert.ok(["/hls.m3u8", "/dash.mpd"].includes(url.pathname), "Unexpected redirect fixture path");
    const destination = url.pathname.endsWith("mpd") ? "dash/manifest.mpd" : "hls/manifest.m3u8";
    return new Response(null, {
      status: 302,
      headers: { Location: `https://cdn.playback.test/${destination}`, "Access-Control-Allow-Origin": "*" },
    });
  }
  if (url.hostname === "headers.playback.test") {
    const headers = new Headers(init.headers);
    if (!throughRelay || Object.entries(PROVIDER_HEADERS).some(([name, value]) => headers.get(name) !== value)) {
      return new Response("Fixture requires its provider headers", { status: 403 });
    }
  }
  if (url.hostname === "fallback.playback.test" && !throughRelay) {
    return new Response("Intentional direct-route failure", {
      status: 403, headers: { "Access-Control-Allow-Origin": "*" },
    });
  }
  // Exact pathname allowlist prevents URL decoding/path traversal outside the owned set.
  assert.match(url.pathname, /^\/(?:progressive\.mp4|hls\/(?:manifest\.m3u8|seg-\d{3}\.ts)|dash\/(?:manifest\.mpd|init-\d+\.m4s|seg-\d+-\d{5}\.m4s))$/);
  const absolute = path.resolve(directory, url.pathname.slice(1));
  assert.ok(absolute.startsWith(path.resolve(directory) + path.sep), "Fixture path must stay inside its directory");
  const data = await readFile(absolute);
  assert.ok(data.byteLength <= MAX_FIXTURE_BYTES, "Fixture response exceeds its bound");
  const headers = new Headers({
    "Content-Type": TYPES[path.extname(absolute)], "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    "Accept-Ranges": "bytes", "Cache-Control": "no-store",
  });
  let range;
  try { range = byteRange(new Headers(init.headers).get("Range"), data.byteLength); }
  catch {
    headers.set("Content-Range", `bytes */${data.byteLength}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${data.byteLength}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
    return new Response(data.subarray(range.start, range.end + 1), { status: 206, headers });
  }
  headers.set("Content-Length", String(data.byteLength));
  return new Response(data, { headers });
}
