#!/usr/bin/env bun
/**
 * YouTube -> Encrypted Multi-Period DASH Pipeline
 *
 * Downloads the best video-only and audio-only streams directly via yt-dlp
 * (comma-free, one stream per call - never triggers yt-dlp's ffmpeg merge
 * postprocessor), splits both independently at a shared set of keyframe-
 * aligned boundaries, and feeds each period's raw video/audio straight into
 * shaka-packager as two separate `in=` sources. The muxed intermediate file
 * that encrypt-video.ts's single-source pipeline relies on is never created -
 * this saves one full-file ffmpeg mux pass (yt-dlp's merge) and reuses the
 * exact same boundaries for both streams so periods don't drift out of sync.
 */

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";

interface PeriodKeyInfo {
  index: number;
  duration: number;
  start: number;
  keyId: {
    hex: string;
    base64url: string;
    uuid: string;
  };
  key: {
    hex: string;
    base64url: string;
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options: {
    url: string;
    id: string;
    title: string;
    out: string;
    segDuration: number;
    keyPeriodSeconds: number;
    maxDuration: number;
    full: boolean;
    local: boolean;
    videoFormat: string;
    audioFormat: string;
    cookies: string;
  } = {
    url: "",
    id: "",
    title: "",
    out: "",
    segDuration: 4,
    keyPeriodSeconds: 8,
    maxDuration: 180, // Default 180s for fast testing, like encrypt-video.ts
    full: false,
    local: false,
    // Prefer native mp4/m4a (h264+aac) so no container remux is ever needed;
    // falls back to whatever's best if mp4/m4a isn't available for this video.
    videoFormat: "bestvideo[ext=mp4]/bestvideo",
    audioFormat: "bestaudio[ext=m4a]/bestaudio",
    cookies: "",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--url" && args[i + 1]) options.url = args[++i];
    else if (arg === "--id" && args[i + 1]) options.id = args[++i];
    else if (arg === "--title" && args[i + 1]) options.title = args[++i];
    else if (arg === "--out" && args[i + 1]) options.out = args[++i];
    else if (arg === "--seg-duration" && args[i + 1]) options.segDuration = Number(args[++i]);
    else if (arg === "--key-period-seconds" && args[i + 1]) options.keyPeriodSeconds = Number(args[++i]);
    else if (arg === "--max-duration" && args[i + 1]) options.maxDuration = Number(args[++i]);
    else if (arg === "--full") {
      options.full = true;
      options.maxDuration = 0;
    } else if (arg === "--local") options.local = true;
    else if (arg === "--video-format" && args[i + 1]) options.videoFormat = args[++i];
    else if (arg === "--audio-format" && args[i + 1]) options.audioFormat = args[++i];
    else if (arg === "--cookies" && args[i + 1]) options.cookies = args[++i];
  }

  if (!options.url) {
    throw new Error("Missing required --url <youtube-video-url>");
  }

  return options;
}

function runCmd(cmd: string, args: string[], cwd?: string) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Command failed with code ${result.status}: ${cmd} ${args.join(" ")}`);
  }
}

function formatUuid(hex: string): string {
  return hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}

/** Metadata-only lookup (no media bytes) to fill in defaults for --id/--title. */
function fetchYoutubeMeta(url: string, cookies: string): { id: string; title: string; duration: number } {
  const args = ["--skip-download", "--print", "%(id)s\t%(title)s\t%(duration)s"];
  if (cookies) args.push("--cookies", cookies);
  args.push(url);
  const result = spawnSync("yt-dlp", args, { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`yt-dlp metadata lookup failed: ${result.stderr || result.stdout}`);
  }
  const line = result.stdout.trim().split("\n").filter(Boolean).pop() || "";
  const [id, title, durationStr] = line.split("\t");
  if (!id) throw new Error(`Could not resolve a video id from ${url}`);
  return { id, title: title || id, duration: Number(durationStr) || 0 };
}

/** Downloads exactly one stream (video-only or audio-only) - never invokes yt-dlp's merge postprocessor. */
function downloadYoutubeStream(
  url: string,
  formatSelector: string,
  outTemplate: string,
  opts: { cookies?: string }
) {
  // Deliberately no --download-sections: that forces yt-dlp to hand the URL
  // to ffmpeg for time-range trimming instead of using its own downloader,
  // and fallback extraction clients (e.g. android_vr, used when no JS
  // runtime is available to solve YouTube's normal challenge) issue URLs
  // that ffmpeg gets 403'd on but yt-dlp's native downloader handles fine.
  // Trimming is done locally after a full download instead (trimToMaxDuration).
  const args = ["-f", formatSelector, "-o", outTemplate, "--no-playlist", "--no-part"];
  if (opts.cookies) args.push("--cookies", opts.cookies);
  args.push(url);
  runCmd("yt-dlp", args);
}

function findDownloadedFile(workDir: string, prefix: string): string {
  const match = fs.readdirSync(workDir).find((f) => f.startsWith(prefix));
  if (!match) throw new Error(`Could not locate downloaded file with prefix "${prefix}" in ${workDir}`);
  return path.join(workDir, match);
}

/** Trims an already-downloaded file to maxDuration seconds, in place, via stream copy. */
function trimToMaxDuration(filePath: string, maxDuration: number): void {
  const ext = path.extname(filePath);
  const trimmedPath = filePath.slice(0, -ext.length) + ".trimmed" + ext;
  runCmd("ffmpeg", ["-y", "-t", String(maxDuration), "-i", filePath, "-c", "copy", trimmedPath]);
  fs.unlinkSync(filePath);
  fs.renameSync(trimmedPath, filePath);
}

function probeDuration(filePath: string): number {
  const proc = spawnSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", filePath]);
  if (proc.status !== 0) throw new Error(`ffprobe failed on ${filePath}`);
  const data = JSON.parse(proc.stdout.toString());
  return Number(data.format?.duration || 0);
}

/** Keyframe (I-frame) PTS timestamps in the video stream, used to pick cut points that don't require re-encoding. */
function getKeyframeTimes(videoPath: string): number[] {
  const proc = spawnSync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-skip_frame", "nokey",
    "-show_entries", "frame=pts_time",
    "-of", "csv=p=0",
    videoPath,
  ]);
  if (proc.status !== 0) throw new Error(`ffprobe keyframe scan failed on ${videoPath}`);
  return proc.stdout
    .toString()
    .split("\n")
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n));
}

/**
 * Picks period boundaries every ~keyPeriodSeconds, snapped to the nearest
 * following keyframe. The same boundaries are then used to split BOTH the
 * video and audio streams, so periods stay aligned without ever muxing them.
 */
function computePeriodBoundaries(keyframeTimes: number[], totalDuration: number, keyPeriodSeconds: number): number[] {
  const sorted = [...keyframeTimes].sort((a, b) => a - b);
  const boundaries: number[] = [0];
  let target = keyPeriodSeconds;
  while (target < totalDuration - 0.05) {
    const candidate = sorted.find((t) => t >= target && t < totalDuration - 0.05);
    if (candidate === undefined) break;
    if (candidate > boundaries[boundaries.length - 1] + 0.05) {
      boundaries.push(candidate);
    }
    target = candidate + keyPeriodSeconds;
  }
  boundaries.push(totalDuration);
  return boundaries;
}

/** Splits `inputPath` at the interior boundary timestamps, always via stream copy (no re-encode). */
function splitAtBoundaries(inputPath: string, boundaries: number[], outDir: string, baseName: string, ext: string): string[] {
  const interior = boundaries.slice(1, -1);
  const outPattern = path.join(outDir, `${baseName}-%03d.${ext}`);

  if (interior.length === 0) {
    const single = path.join(outDir, `${baseName}-000.${ext}`);
    fs.copyFileSync(inputPath, single);
    return [single];
  }

  runCmd("ffmpeg", [
    "-y",
    "-i", inputPath,
    "-f", "segment",
    "-segment_times", interior.map((t) => t.toFixed(3)).join(","),
    "-reset_timestamps", "1",
    "-c", "copy",
    outPattern,
  ]);

  return fs
    .readdirSync(outDir)
    .filter((f) => f.startsWith(`${baseName}-`) && f.endsWith(`.${ext}`))
    .sort()
    .map((f) => path.join(outDir, f));
}

async function uploadToR2(workDir: string, id: string) {
  const endpoint = process.env.S3_ENDPOINT;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const bucket = process.env.S3_BUCKET;
  const region = process.env.S3_REGION || "auto";

  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    return false;
  }

  console.log(`\nUploading assets to Cloudflare R2 bucket "${bucket}" via Bun.S3Client...`);
  // @ts-ignore
  const s3 = new Bun.S3Client({ endpoint, accessKeyId, secretAccessKey, bucket, region });

  const filesToUpload: { localPath: string; s3Key: string; contentType: string }[] = [];

  function collectFiles(dir: string, prefix: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relKey = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        collectFiles(fullPath, relKey);
      } else {
        const contentType = entry.name.endsWith(".mpd") ? "application/dash+xml" : "video/mp4";
        filesToUpload.push({ localPath: fullPath, s3Key: `${id}/${relKey}`, contentType });
      }
    }
  }

  collectFiles(workDir, "");

  console.log(`Found ${filesToUpload.length} files to upload to R2.`);
  for (const item of filesToUpload) {
    const fileData = fs.readFileSync(item.localPath);
    await s3.write(item.s3Key, fileData, { type: item.contentType });
    console.log(`  Uploaded ${item.s3Key} (${(fileData.length / 1024).toFixed(1)} KB)`);
  }

  console.log(`✓ Successfully uploaded all ${filesToUpload.length} files to private R2 bucket.`);
  return true;
}

function copyToLocalAssets(workDir: string, id: string, targetRoot: string) {
  const destDir = path.join(targetRoot, id);
  console.log(`\nCopying segments to local storage: ${destDir}`);
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(workDir, destDir, { recursive: true });
  console.log(`✓ Successfully copied assets into ${destDir}`);
}

async function main() {
  const options = parseArgs();

  console.log("=================================================");
  console.log("  YOUTUBE -> ENCRYPTED DASH PIPELINE (no mux pass) ");
  console.log("  Engine: yt-dlp (dual-stream) + Shaka Packager     ");
  console.log("=================================================");
  console.log(`URL:               ${options.url}`);

  const meta = fetchYoutubeMeta(options.url, options.cookies);
  const id = options.id || meta.id;
  const title = options.title || meta.title;

  console.log(`Video ID:          ${id}`);
  console.log(`Title:             ${title}`);
  console.log(`Source Duration:   ${meta.duration}s`);
  console.log(`Key Period:        ${options.keyPeriodSeconds}s`);
  console.log(`Segment Duration:  ${options.segDuration}s`);
  console.log(`Max Duration:      ${options.maxDuration > 0 ? `${options.maxDuration}s` : "Full video"}`);
  console.log(`Video Format:      ${options.videoFormat}`);
  console.log(`Audio Format:      ${options.audioFormat}`);
  console.log("=================================================\n");

  const currentDir = (import.meta as any).dir || path.dirname(new URL(import.meta.url).pathname);
  const projectRoot = path.resolve(currentDir, "..");
  const packagerBin = path.join(projectRoot, "node_modules", "shaka-packager", "bin", "packager-linux-x64");
  if (!fs.existsSync(packagerBin)) {
    throw new Error(`shaka-packager binary not found at ${packagerBin}`);
  }

  const workDir = options.out || path.join(projectRoot, `work-${id}`);
  fs.mkdirSync(workDir, { recursive: true });

  const shouldTrim = !options.full && options.maxDuration > 0;

  // Step 1: Download video-only and audio-only streams as separate files.
  // Two single-stream yt-dlp calls - there's nothing to merge, so yt-dlp's
  // ffmpeg merge postprocessor never runs. Full streams are downloaded via
  // yt-dlp's own native downloader (reliable); trimming happens afterward
  // via a local ffmpeg stream-copy pass (see downloadYoutubeStream).
  console.log("[Step 1/5] Downloading video-only stream via yt-dlp (no merge)...");
  downloadYoutubeStream(options.url, options.videoFormat, path.join(workDir, "yt-video.%(ext)s"), {
    cookies: options.cookies,
  });
  const rawVideoPath = findDownloadedFile(workDir, "yt-video.");
  const videoExt = path.extname(rawVideoPath).slice(1);
  if (shouldTrim) trimToMaxDuration(rawVideoPath, options.maxDuration);

  console.log("\n[Step 1/5] Downloading audio-only stream via yt-dlp (no merge)...");
  downloadYoutubeStream(options.url, options.audioFormat, path.join(workDir, "yt-audio.%(ext)s"), {
    cookies: options.cookies,
  });
  const rawAudioPath = findDownloadedFile(workDir, "yt-audio.");
  if (shouldTrim) trimToMaxDuration(rawAudioPath, options.maxDuration);
  const audioExt = path.extname(rawAudioPath).slice(1);

  // Step 2: Determine real (post-trim) duration and shared cut points.
  console.log("\n[Step 2/5] Probing duration & locating keyframe-aligned cut points...");
  const totalDuration = probeDuration(rawVideoPath);
  const keyframeTimes = getKeyframeTimes(rawVideoPath);
  const boundaries = computePeriodBoundaries(keyframeTimes, totalDuration, options.keyPeriodSeconds);
  console.log(`Duration: ${totalDuration.toFixed(2)}s -> ${boundaries.length - 1} period(s)`);

  // Step 3: Split video and audio independently at the SAME boundaries
  // (stream copy only - no re-encode, no intermediate merged file).
  console.log("\n[Step 3/5] Splitting video & audio at shared boundaries (stream copy)...");
  const videoPeriodFiles = splitAtBoundaries(rawVideoPath, boundaries, workDir, "raw-video-period", videoExt);
  const audioPeriodFiles = splitAtBoundaries(rawAudioPath, boundaries, workDir, "raw-audio-period", audioExt);
  if (videoPeriodFiles.length !== audioPeriodFiles.length) {
    throw new Error(
      `Video/audio period count mismatch: ${videoPeriodFiles.length} video vs ${audioPeriodFiles.length} audio`
    );
  }
  fs.unlinkSync(rawVideoPath);
  fs.unlinkSync(rawAudioPath);

  // Step 4: Encrypt each period with its own KID/key using shaka-packager,
  // reading video and audio directly from their separate raw files.
  console.log("\n[Step 4/5] Packaging & encrypting periods with shaka-packager (CENC CommonSystem)...");
  const periods: PeriodKeyInfo[] = [];
  const periodBlocks: string[] = [];
  let accumulatedStart = 0;

  for (let i = 0; i < videoPeriodFiles.length; i++) {
    const rawVideoPeriodPath = videoPeriodFiles[i];
    const rawAudioPeriodPath = audioPeriodFiles[i];
    const periodDir = path.join(workDir, `period-${i}`);
    fs.mkdirSync(periodDir, { recursive: true });

    const pProbe = spawnSync("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      rawVideoPeriodPath,
    ]);
    const pData = JSON.parse(pProbe.stdout.toString());
    const periodDuration = Number(pData.format?.duration || options.keyPeriodSeconds);

    const keyBytes = crypto.randomBytes(16);
    const kidBytes = crypto.randomBytes(16);
    const keyHex = keyBytes.toString("hex");
    const kidHex = kidBytes.toString("hex");
    const keyB64Url = keyBytes.toString("base64url");
    const kidB64Url = kidBytes.toString("base64url");
    const kidUuid = formatUuid(kidHex);

    console.log(
      `\n--- Period ${i} [${accumulatedStart.toFixed(1)}s -> ${(accumulatedStart + periodDuration).toFixed(1)}s] ---`
    );
    console.log(`  KID (hex):       ${kidHex}`);
    console.log(`  KEY (hex):       ${keyHex}`);

    const packagerArgs = [
      `in=${rawVideoPeriodPath},stream=video,drm_label=HD,init_segment=${path.join(periodDir, "init-video.m4s")},segment_template=${path.join(periodDir, "chunk-video-$Number%05d$.m4s")}`,
      `in=${rawAudioPeriodPath},stream=audio,drm_label=AUDIO,init_segment=${path.join(periodDir, "init-audio.m4s")},segment_template=${path.join(periodDir, "chunk-audio-$Number%05d$.m4s")}`,
      "--enable_raw_key_encryption",
      "--keys", `label=HD:key_id=${kidHex}:key=${keyHex},label=AUDIO:key_id=${kidHex}:key=${keyHex}`,
      "--protection_scheme", "cenc",
      "--protection_systems", "CommonSystem",
      "--clear_lead", "0",
      "--segment_duration", String(options.segDuration),
      "--generate_static_live_mpd",
      "--mpd_output", path.join(periodDir, "period.mpd"),
    ];
    runCmd(packagerBin, packagerArgs);

    const periodMpdPath = path.join(periodDir, "period.mpd");
    const periodMpdText = fs.readFileSync(periodMpdPath, "utf-8");
    const periodMatch = periodMpdText.match(/<Period[\s\S]*?<\/Period>/);
    if (!periodMatch) throw new Error(`Failed to extract <Period> from ${periodMpdPath}`);

    let periodXml = periodMatch[0];
    periodXml = periodXml.replace(
      /<Period[^>]*>/,
      `<Period id="period-${i}" start="PT${accumulatedStart.toFixed(3)}S" duration="PT${periodDuration.toFixed(3)}S">`
    );
    periodXml = periodXml.replace(/initialization="init-/g, `initialization="period-${i}/init-`);
    periodXml = periodXml.replace(/media="chunk-/g, `media="period-${i}/chunk-`);
    periodBlocks.push(periodXml);

    fs.unlinkSync(periodMpdPath);
    fs.unlinkSync(rawVideoPeriodPath);
    fs.unlinkSync(rawAudioPeriodPath);

    periods.push({
      index: i,
      duration: periodDuration,
      start: accumulatedStart,
      keyId: { hex: kidHex, base64url: kidB64Url, uuid: kidUuid },
      key: { hex: keyHex, base64url: keyB64Url },
    });

    accumulatedStart += periodDuration;
  }

  // Step 5: Write manifest.mpd and publish.
  console.log("\n[Step 5/5] Generating multi-Period DASH manifest (manifest.mpd)...");
  const manifestXml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated with shaka-packager -->
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xmlns:cenc="urn:mpeg:cenc:2013"
     xsi:schemaLocation="urn:mpeg:dash:schema:mpd:2011 DASH-MPD.xsd"
     profiles="urn:mpeg:dash:profile:isoff-live:2011,urn:com:dashif:ingest:2014"
     type="static"
     mediaPresentationDuration="PT${accumulatedStart.toFixed(3)}S"
     minBufferTime="PT2.0S">
${periodBlocks.join("\n\n")}
</MPD>
`;

  const manifestPath = path.join(workDir, "manifest.mpd");
  fs.writeFileSync(manifestPath, manifestXml, "utf-8");
  console.log(`✓ Wrote ${manifestPath}`);

  let uploadedToR2 = false;
  try {
    uploadedToR2 = await uploadToR2(workDir, id);
  } catch (err: any) {
    console.warn(`R2 upload skipped or failed (${err?.message}).`);
  }

  const publicAssetsDir = path.join(projectRoot, "public", "assets");
  copyToLocalAssets(workDir, id, publicAssetsDir);

  // NOTE: like encrypt-video.ts, this overwrites registry.local.json and
  // registry.generated.ts with only THIS video - the pipeline is single
  // active-video MVP tooling, not a multi-video catalog generator.
  const registryLocal = {
    id,
    title,
    manifestPath: `${id}/manifest.mpd`,
    createdAt: new Date().toISOString(),
    periods: periods.map((p) => ({ index: p.index, duration: p.duration, start: p.start, keyId: p.keyId, key: p.key })),
  };

  const localJsonPath = path.join(projectRoot, "scripts", "registry.local.json");
  fs.writeFileSync(localJsonPath, JSON.stringify(registryLocal, null, 2));
  console.log(`✓ Wrote local key store: ${localJsonPath}`);

  const generatedTsContent = `// Auto-generated by scripts/youtube-pipeline.ts. Do not edit manually.
export interface VideoRecord {
  id: string;
  title: string;
  manifestPath: string;
  periods: { index: number; keyId: string /* hex */ }[];
}

export const GENERATED_VIDEOS: Record<string, VideoRecord> = {
  ${JSON.stringify(id)}: {
    id: ${JSON.stringify(id)},
    title: ${JSON.stringify(title)},
    manifestPath: ${JSON.stringify(`${id}/manifest.mpd`)},
    periods: ${JSON.stringify(periods.map((p) => ({ index: p.index, keyId: p.keyId.hex })), null, 4)},
  },
};

export const GENERATED_KEY_STORE: Record<string, string> = {
${periods.map((p) => `  ${JSON.stringify(p.keyId.hex)}: ${JSON.stringify(p.key.hex)},`).join("\n")}
};

export const GENERATED_DEFAULT_VIDEO_ID = ${JSON.stringify(id)};
`;

  const generatedTsPath = path.join(projectRoot, "src", "registry.generated.ts");
  fs.writeFileSync(generatedTsPath, generatedTsContent, "utf-8");
  console.log(`✓ Wrote TypeScript registry: ${generatedTsPath}`);

  console.log("\n=================================================");
  console.log("  PIPELINE COMPLETE SUCCESS!");
  console.log("=================================================");
  console.log(`Video ID:        ${id}`);
  console.log(`Manifest:        /assets/${id}/manifest.mpd`);
  console.log(`Key Periods:     ${periods.length} periods generated`);
  console.log(`R2 Delivery:     ${uploadedToR2 ? "Uploaded to R2" : "Skipped/Failed"}`);
  console.log(`Local Delivery:  Updated ${publicAssetsDir}`);
  console.log("=================================================\n");
}

main().catch((err) => {
  console.error("\n[FATAL PIPELINE ERROR]:", err);
  process.exit(1);
});
