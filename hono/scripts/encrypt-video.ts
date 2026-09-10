#!/usr/bin/env bun
/**
 * Encrypted Video Playback Pipeline (EME + Clear Key over DASH)
 * Multi-Period Key Rotation with CENC-AES-CTR encryption using shaka-packager.
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
    source: string;
    id: string;
    title: string;
    out: string;
    segDuration: number;
    keyPeriodSeconds: number;
    videoBitrate: number;
    audioBitrate: number;
    maxDuration: number;
    full: boolean;
    local: boolean;
  } = {
    source: "https://protech-assets.dhruvish.in/videos/58fce6ff-a200-4f81-8d3c-79e1b521acbb/master.m3u8",
    id: "58fce6ff-a200-4f81-8d3c-79e1b521acbb",
    title: "Protected Stream (Encrypted DASH)",
    out: "",
    segDuration: 4,
    keyPeriodSeconds: 8,
    videoBitrate: 1500,
    audioBitrate: 128,
    maxDuration: 180, // Default 180s (3 periods) for fast testing
    full: false,
    local: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--source" && args[i + 1]) options.source = args[++i];
    else if (arg === "--id" && args[i + 1]) options.id = args[++i];
    else if (arg === "--title" && args[i + 1]) options.title = args[++i];
    else if (arg === "--out" && args[i + 1]) options.out = args[++i];
    else if (arg === "--seg-duration" && args[i + 1]) options.segDuration = Number(args[++i]);
    else if (arg === "--key-period-seconds" && args[i + 1]) options.keyPeriodSeconds = Number(args[++i]);
    else if (arg === "--video-bitrate" && args[i + 1]) options.videoBitrate = Number(args[++i]);
    else if (arg === "--audio-bitrate" && args[i + 1]) options.audioBitrate = Number(args[++i]);
    else if (arg === "--max-duration" && args[i + 1]) options.maxDuration = Number(args[++i]);
    else if (arg === "--full") {
      options.full = true;
      options.maxDuration = 0;
    } else if (arg === "--local") {
      options.local = true;
    }
  }

  if (options.full) {
    options.maxDuration = 0;
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
  const s3 = new Bun.S3Client({
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    region,
  });

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
        filesToUpload.push({
          localPath: fullPath,
          s3Key: `${id}/${relKey}`,
          contentType,
        });
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
  console.log("  ENCRYPTED VIDEO PIPELINE (EME + Clear Key DASH)");
  console.log("  Engine: Google Shaka Packager (CENC-AES-CTR)   ");
  console.log("=================================================");
  console.log(`Source:            ${options.source}`);
  console.log(`Video ID:          ${options.id}`);
  console.log(`Title:             ${options.title}`);
  console.log(`Key Period:        ${options.keyPeriodSeconds}s`);
  console.log(`Segment Duration:  ${options.segDuration}s`);
  console.log(`Max Duration:      ${options.maxDuration > 0 ? `${options.maxDuration}s` : "Full video"}`);
  console.log(`Local Storage:     ${options.local ? "Enforced" : "Auto"}`);
  console.log("=================================================\n");

  const currentDir = (import.meta as any).dir || path.dirname(new URL(import.meta.url).pathname);
  const projectRoot = path.resolve(currentDir, "..");
  const packagerBin = path.join(projectRoot, "node_modules", "shaka-packager", "bin", "packager-linux-x64");
  if (!fs.existsSync(packagerBin)) {
    throw new Error(`shaka-packager binary not found at ${packagerBin}`);
  }

  const workDir = options.out || path.join(projectRoot, `work-${options.id}`);
  fs.mkdirSync(workDir, { recursive: true });

  const stagedSource = path.join(workDir, "source.mp4");

  // Step 1: Download & normalize
  console.log("\n[Step 1/5] Downloading and normalizing source stream...");
  if (options.source.startsWith("http://") || options.source.startsWith("https://")) {
    const ffmpegArgs = ["-y"];
    if (options.maxDuration > 0) {
      ffmpegArgs.push("-t", String(options.maxDuration));
    }
    ffmpegArgs.push("-i", options.source, "-c", "copy", stagedSource);
    runCmd("ffmpeg", ffmpegArgs);
  } else {
    fs.copyFileSync(options.source, stagedSource);
  }

  // Step 2: Probe source metadata
  console.log("\n[Step 2/5] Probing source stream metadata...");
  const probeProc = spawnSync("ffprobe", [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    stagedSource,
  ]);
  if (probeProc.status !== 0) {
    throw new Error("ffprobe failed on source.mp4");
  }
  const probeData = JSON.parse(probeProc.stdout.toString());
  const videoStream = probeData.streams.find((s: any) => s.codec_type === "video");
  const audioStream = probeData.streams.find((s: any) => s.codec_type === "audio");

  if (!videoStream) {
    throw new Error("No video stream found in source media");
  }

  const videoWidth = videoStream.width || 1920;
  const videoHeight = videoStream.height || 1080;
  let videoFps = 30;
  if (videoStream.r_frame_rate) {
    const [num, den] = videoStream.r_frame_rate.split("/").map(Number);
    if (num && den) videoFps = Math.round(num / den);
  }
  const audioSampleRate = audioStream?.sample_rate ? Number(audioStream.sample_rate) : 48000;
  const rawDuration = Number(probeData.format?.duration || 0);
  const totalDuration = options.maxDuration > 0 ? Math.min(rawDuration, options.maxDuration) : rawDuration;

  console.log(
    `Source: ${videoWidth}x${videoHeight} @ ${videoFps}fps, audio: ${audioSampleRate}Hz, duration: ${totalDuration.toFixed(
      2
    )}s`
  );

  // Step 3: Split into key periods
  console.log(`\n[Step 3/5] Splitting into ${options.keyPeriodSeconds}s key periods...`);
  const periodPattern = path.join(workDir, "raw-period-%03d.mp4");
  runCmd("ffmpeg", [
    "-y",
    "-i",
    stagedSource,
    "-f",
    "segment",
    "-segment_time",
    String(options.keyPeriodSeconds),
    "-reset_timestamps",
    "1",
    "-c",
    "copy",
    periodPattern,
  ]);

  // Find all generated period files
  const periodFiles = fs
    .readdirSync(workDir)
    .filter((f) => f.startsWith("raw-period-") && f.endsWith(".mp4"))
    .sort();

  console.log(`Found ${periodFiles.length} period segments.`);
  const periods: PeriodKeyInfo[] = [];
  const periodBlocks: string[] = [];
  let accumulatedStart = 0;

  // Step 4: Encrypt each period with its own KID and Key using shaka-packager
  console.log("\n[Step 4/5] Packaging & encrypting periods with shaka-packager (CENC CommonSystem)...");
  for (let i = 0; i < periodFiles.length; i++) {
    const rawPeriodPath = path.join(workDir, periodFiles[i]);
    const periodDir = path.join(workDir, `period-${i}`);
    fs.mkdirSync(periodDir, { recursive: true });

    // Probe period duration
    const pProbe = spawnSync("ffprobe", [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      rawPeriodPath,
    ]);
    const pData = JSON.parse(pProbe.stdout.toString());
    const periodDuration = Number(pData.format?.duration || options.keyPeriodSeconds);

    // Generate random 16-byte key & kid
    const keyBytes = crypto.randomBytes(16);
    const kidBytes = crypto.randomBytes(16);
    const keyHex = keyBytes.toString("hex");
    const kidHex = kidBytes.toString("hex");
    const keyB64Url = keyBytes.toString("base64url");
    const kidB64Url = kidBytes.toString("base64url");
    const kidUuid = formatUuid(kidHex);

    console.log(`\n--- Period ${i} [${accumulatedStart.toFixed(1)}s -> ${(accumulatedStart + periodDuration).toFixed(1)}s] ---`);
    console.log(`  KID (hex):       ${kidHex}`);
    console.log(`  KID (base64url): ${kidB64Url}`);
    console.log(`  KEY (hex):       ${keyHex}`);
    console.log(`  KEY (base64url): ${keyB64Url}`);

    const packagerArgs = [
      `in=${rawPeriodPath},stream=video,drm_label=HD,init_segment=${path.join(periodDir, "init-video.m4s")},segment_template=${path.join(periodDir, "chunk-video-$Number%05d$.m4s")}`,
      `in=${rawPeriodPath},stream=audio,drm_label=AUDIO,init_segment=${path.join(periodDir, "init-audio.m4s")},segment_template=${path.join(periodDir, "chunk-audio-$Number%05d$.m4s")}`,
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

    // Read period.mpd to extract Period XML block
    const periodMpdPath = path.join(periodDir, "period.mpd");
    const periodMpdText = fs.readFileSync(periodMpdPath, "utf-8");
    const periodMatch = periodMpdText.match(/<Period[\s\S]*?<\/Period>/);
    if (!periodMatch) {
      throw new Error(`Failed to extract <Period> from ${periodMpdPath}`);
    }

    let periodXml = periodMatch[0];
    periodXml = periodXml.replace(
      /<Period[^>]*>/,
      `<Period id="period-${i}" start="PT${accumulatedStart.toFixed(3)}S" duration="PT${periodDuration.toFixed(3)}S">`
    );
    periodXml = periodXml.replace(/initialization="init-/g, `initialization="period-${i}/init-`);
    periodXml = periodXml.replace(/media="chunk-/g, `media="period-${i}/chunk-`);
    periodBlocks.push(periodXml);

    // Clean up temporary period.mpd and raw period MP4
    fs.unlinkSync(periodMpdPath);
    fs.unlinkSync(rawPeriodPath);

    periods.push({
      index: i,
      duration: periodDuration,
      start: accumulatedStart,
      keyId: {
        hex: kidHex,
        base64url: kidB64Url,
        uuid: kidUuid,
      },
      key: {
        hex: keyHex,
        base64url: keyB64Url,
      },
    });

    accumulatedStart += periodDuration;
  }

  // Clean up staged source
  if (fs.existsSync(stagedSource)) {
    fs.unlinkSync(stagedSource);
  }

  // Step 5: Write manifest.mpd
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

  // Storage & Delivery: Upload to R2 and Local
  let uploadedToR2 = false;
  try {
    uploadedToR2 = await uploadToR2(workDir, options.id);
  } catch (err: any) {
    console.warn(`R2 upload skipped or failed (${err?.message}).`);
  }

  // Always copy to local assets so local dev & test suites have matching files
  const publicAssetsDir = path.join(projectRoot, "public", "assets");
  copyToLocalAssets(workDir, options.id, publicAssetsDir);

  // Export local registry JSON
  const registryLocal = {
    id: options.id,
    title: options.title,
    manifestPath: `${options.id}/manifest.mpd`,
    createdAt: new Date().toISOString(),
    periods: periods.map((p) => ({
      index: p.index,
      duration: p.duration,
      start: p.start,
      keyId: p.keyId,
      key: p.key,
    })),
  };

  const localJsonPath = path.join(projectRoot, "scripts", "registry.local.json");
  fs.writeFileSync(localJsonPath, JSON.stringify(registryLocal, null, 2));
  console.log(`✓ Wrote local key store: ${localJsonPath}`);

  // Export generated TypeScript registry for Hono
  const generatedTsContent = `// Auto-generated by scripts/encrypt-video.ts. Do not edit manually.
export interface VideoRecord {
  id: string;
  title: string;
  manifestPath: string;
  periods: { index: number; keyId: string /* hex */ }[];
}

export const GENERATED_VIDEOS: Record<string, VideoRecord> = {
  ${JSON.stringify(options.id)}: {
    id: ${JSON.stringify(options.id)},
    title: ${JSON.stringify(options.title)},
    manifestPath: ${JSON.stringify(`${options.id}/manifest.mpd`)},
    periods: ${JSON.stringify(
      periods.map((p) => ({ index: p.index, keyId: p.keyId.hex })),
      null,
      4
    )},
  },
};

export const GENERATED_KEY_STORE: Record<string, string> = {
${periods.map((p) => `  ${JSON.stringify(p.keyId.hex)}: ${JSON.stringify(p.key.hex)},`).join("\n")}
};

export const GENERATED_DEFAULT_VIDEO_ID = ${JSON.stringify(options.id)};
`;

  const generatedTsPath = path.join(projectRoot, "src", "registry.generated.ts");
  fs.writeFileSync(generatedTsPath, generatedTsContent, "utf-8");
  console.log(`✓ Wrote TypeScript registry: ${generatedTsPath}`);

  console.log("\n=================================================");
  console.log("  PIPELINE COMPLETE SUCCESS!");
  console.log("=================================================");
  console.log(`Video ID:        ${options.id}`);
  console.log(`Manifest:        /assets/${options.id}/manifest.mpd`);
  console.log(`Key Periods:     ${periods.length} periods generated`);
  console.log(`R2 Delivery:     ${uploadedToR2 ? "Uploaded to R2" : "Skipped/Failed"}`);
  console.log(`Local Delivery:  Updated ${publicAssetsDir}`);
  console.log("=================================================\n");
}

main().catch((err) => {
  console.error("\n[FATAL PIPELINE ERROR]:", err);
  process.exit(1);
});
