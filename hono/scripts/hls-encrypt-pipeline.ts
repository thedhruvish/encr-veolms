#!/usr/bin/env bun
/**
 * Local HLS -> Encrypted Multi-Period, Multi-Bitrate DASH Pipeline
 *
 * Takes an already-downloaded HLS ABR ladder (master.m3u8 + numbered .ts
 * segments per rendition, e.g. hono/segments/) and packages ALL selected
 * renditions into one CENC-AES-CTR encrypted multi-Period DASH manifest -
 * no download step, no ffmpeg re-encode, and no ffmpeg re-mux either:
 * consecutive .ts segments are grouped into periods by raw byte
 * concatenation (valid for MPEG-TS, which is designed to be concatenable)
 * and handed directly to shaka-packager, which does the one unavoidable
 * pass (demux TS -> encrypt -> remux to fMP4) per period.
 *
 * Every quality Representation within a period shares the SAME key (keys
 * rotate per time period, not per quality - this matches how the DB schema
 * already models one key_id per period, and how CENC/DASH ABR normally
 * works: the CDM just picks whichever Representation to decode, and they
 * all need the same key to switch between seamlessly).
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

interface Variant {
  bandwidth: number;
  resolution: string;
  uri: string;
}

interface Segment {
  file: string;
  duration: number;
}

interface VariantData {
  variant: Variant;
  renditionDir: string;
  segments: Segment[];
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options: {
    segmentsDir: string;
    renditions: string;
    id: string;
    title: string;
    out: string;
    segDuration: number;
    keyPeriodSeconds: number;
    maxDuration: number;
    full: boolean;
    local: boolean;
  } = {
    segmentsDir: "",
    renditions: "", // "" = all variants found in the master playlist
    id: "",
    title: "Local HLS Import",
    out: "",
    segDuration: 4,
    keyPeriodSeconds: 8,
    maxDuration: 180, // Default 180s for fast testing, like the other pipelines
    full: false,
    local: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--segments-dir" && args[i + 1]) options.segmentsDir = args[++i];
    else if (arg === "--renditions" && args[i + 1]) options.renditions = args[++i];
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

/** Parses #EXT-X-STREAM-INF variants out of a master playlist (regex-based, matching this repo's existing manifest-parsing style). */
function parseMasterPlaylist(masterPath: string): Variant[] {
  const lines = fs.readFileSync(masterPath, "utf-8").split("\n").map((l) => l.trim());
  const variants: Variant[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
    const attrs = lines[i];
    const uri = lines[i + 1];
    if (!uri || uri.startsWith("#")) continue;
    const bandwidthMatch = attrs.match(/BANDWIDTH=(\d+)/);
    const resolutionMatch = attrs.match(/RESOLUTION=(\d+x\d+)/);
    variants.push({
      bandwidth: bandwidthMatch ? Number(bandwidthMatch[1]) : 0,
      resolution: resolutionMatch ? resolutionMatch[1] : "",
      uri,
    });
  }
  if (variants.length === 0) throw new Error(`No #EXT-X-STREAM-INF variants found in ${masterPath}`);
  return variants;
}

/** Parses segment filenames + durations out of a rendition playlist, in playback order. */
function parseRenditionPlaylist(playlistPath: string): { targetDuration: number; segments: Segment[] } {
  const lines = fs.readFileSync(playlistPath, "utf-8").split("\n").map((l) => l.trim());
  let targetDuration = 6;
  const segments: Segment[] = [];
  let pendingDuration: number | null = null;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = Number(line.slice("#EXT-X-TARGETDURATION:".length)) || targetDuration;
    } else if (line.startsWith("#EXTINF:")) {
      const m = line.match(/#EXTINF:([\d.]+)/);
      pendingDuration = m ? Number(m[1]) : targetDuration;
    } else if (line && !line.startsWith("#")) {
      segments.push({ file: line, duration: pendingDuration ?? targetDuration });
      pendingDuration = null;
    }
  }
  if (segments.length === 0) throw new Error(`No segments found in ${playlistPath}`);
  return { targetDuration, segments };
}

/** "" = every variant in the master playlist; otherwise a comma-separated list matched by folder/uri prefix or resolution. */
function selectVariants(variants: Variant[], requested: string): Variant[] {
  const sorted = [...variants].sort((a, b) => a.bandwidth - b.bandwidth);
  if (!requested) return sorted;

  const tokens = requested.split(",").map((t) => t.trim()).filter(Boolean);
  const selected = tokens.map((token) => {
    const found = sorted.find((v) => v.uri.startsWith(token) || v.resolution === token);
    if (!found) {
      const available = sorted.map((v) => `${v.uri} (${v.resolution})`).join(", ");
      throw new Error(`Rendition "${token}" not found. Available: ${available}`);
    }
    return found;
  });
  return selected;
}

/** Drops trailing segments once cumulative duration reaches maxDuration (0/omitted = keep all). Returns how many to keep. */
function countSegmentsWithinMaxDuration(segments: Segment[], maxDuration: number): number {
  if (!maxDuration || maxDuration <= 0) return segments.length;
  let total = 0;
  let count = 0;
  for (const s of segments) {
    if (total >= maxDuration) break;
    count++;
    total += s.duration;
  }
  return Math.max(count, 1);
}

/** [start, end) segment-index ranges, one per period, applied identically across every variant so they stay aligned. */
function computePeriodRanges(segmentCount: number, groupSize: number): [number, number][] {
  const ranges: [number, number][] = [];
  for (let i = 0; i < segmentCount; i += groupSize) {
    ranges.push([i, Math.min(i + groupSize, segmentCount)]);
  }
  return ranges;
}

/** Byte-level concatenation - valid for MPEG-TS, and needs no ffmpeg pass at all. */
function concatSegments(renditionDir: string, files: string[], outPath: string) {
  const buffers = files.map((f) => fs.readFileSync(path.join(renditionDir, f)));
  fs.writeFileSync(outPath, Buffer.concat(buffers));
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

  const currentDir = (import.meta as any).dir || path.dirname(new URL(import.meta.url).pathname);
  const projectRoot = path.resolve(currentDir, "..");
  const segmentsDir = path.resolve(options.segmentsDir || path.join(projectRoot, "segments"));
  const id = options.id || `local-${crypto.randomBytes(4).toString("hex")}`;

  console.log("=================================================");
  console.log("  LOCAL HLS -> ENCRYPTED DASH PIPELINE (no re-mux) ");
  console.log("  Engine: byte-concat + Shaka Packager (multi-ABR) ");
  console.log("=================================================");
  console.log(`Segments Dir:      ${segmentsDir}`);
  console.log(`Video ID:          ${id}`);
  console.log(`Title:             ${options.title}`);
  console.log(`Key Period:        ${options.keyPeriodSeconds}s`);
  console.log(`Segment Duration:  ${options.segDuration}s`);
  console.log(`Max Duration:      ${options.maxDuration > 0 ? `${options.maxDuration}s` : "Full video"}`);
  console.log("=================================================\n");

  const packagerBin = path.join(projectRoot, "node_modules", "shaka-packager", "bin", "packager-linux-x64");
  if (!fs.existsSync(packagerBin)) {
    throw new Error(`shaka-packager binary not found at ${packagerBin}`);
  }

  const masterPath = path.join(segmentsDir, "master.m3u8");
  if (!fs.existsSync(masterPath)) {
    throw new Error(`No master.m3u8 found in ${segmentsDir}`);
  }

  // Step 1: Pick every requested rendition and read each one's already-cut segment list.
  console.log("[Step 1/4] Reading master playlist & selecting renditions...");
  const allVariants = parseMasterPlaylist(masterPath);
  const selectedVariants = selectVariants(allVariants, options.renditions);
  console.log(
    `✓ Using ${selectedVariants.length} rendition(s): ${selectedVariants
      .map((v) => `${v.resolution || v.uri} (${v.bandwidth}bps)`)
      .join(", ")}`
  );

  const variantsData: VariantData[] = selectedVariants.map((variant) => {
    const renditionDir = path.dirname(path.join(segmentsDir, variant.uri));
    const { segments } = parseRenditionPlaylist(path.join(segmentsDir, variant.uri));
    return { variant, renditionDir, segments };
  });

  // All renditions of one ABR ladder must share identical segment boundaries -
  // that's what lets us group them into the same periods without re-cutting anything.
  const referenceCount = variantsData[0].segments.length;
  for (const vd of variantsData) {
    if (vd.segments.length !== referenceCount) {
      throw new Error(
        `Rendition "${vd.variant.uri}" has ${vd.segments.length} segments, expected ${referenceCount} ` +
          `(all selected renditions must be a time-aligned ABR ladder cut from the same source).`
      );
    }
  }

  const referenceSegments = variantsData[0].segments;
  const targetDuration =
    referenceSegments.reduce((sum, s) => sum + s.duration, 0) / referenceSegments.length;
  const keepCount = countSegmentsWithinMaxDuration(referenceSegments, options.maxDuration);
  for (const vd of variantsData) {
    vd.segments = vd.segments.slice(0, keepCount);
  }
  console.log(`✓ ${keepCount}/${referenceCount} segments selected per rendition (~${targetDuration.toFixed(1)}s each).`);

  // Step 2: Group consecutive segments into key periods (segment-boundary aligned, no time-based cutting).
  const groupSize = Math.max(1, Math.round(options.keyPeriodSeconds / targetDuration));
  const periodRanges = computePeriodRanges(keepCount, groupSize);
  console.log(
    `\n[Step 2/4] Grouping ${keepCount} segments into ${periodRanges.length} period(s) of ${groupSize} segment(s) each...`
  );

  const workDir = options.out || path.join(projectRoot, `work-${id}`);
  fs.mkdirSync(workDir, { recursive: true });

  // Step 3: Concatenate (byte-level, no ffmpeg) & encrypt each period with shaka-packager.
  // Every quality Representation in a period is encrypted with the SAME key - only
  // the audio comes from a single (lowest-bandwidth) rendition, since it's identical
  // across the ladder and there's no reason to carry it once per quality.
  console.log("\n[Step 3/4] Concatenating & encrypting periods with shaka-packager (CENC CommonSystem)...");
  const periods: PeriodKeyInfo[] = [];
  const periodBlocks: string[] = [];
  let accumulatedStart = 0;

  for (let i = 0; i < periodRanges.length; i++) {
    const [rangeStart, rangeEnd] = periodRanges[i];
    const periodDuration = referenceSegments.slice(rangeStart, rangeEnd).reduce((sum, s) => sum + s.duration, 0);
    const periodDir = path.join(workDir, `period-${i}`);
    fs.mkdirSync(periodDir, { recursive: true });

    const rawVariantPaths = variantsData.map((vd, vIdx) => {
      const rawPath = path.join(periodDir, `raw-v${vIdx}.ts`);
      concatSegments(vd.renditionDir, vd.segments.slice(rangeStart, rangeEnd).map((s) => s.file), rawPath);
      return rawPath;
    });

    const keyBytes = crypto.randomBytes(16);
    const kidBytes = crypto.randomBytes(16);
    const keyHex = keyBytes.toString("hex");
    const kidHex = kidBytes.toString("hex");
    const keyB64Url = keyBytes.toString("base64url");
    const kidB64Url = kidBytes.toString("base64url");
    const kidUuid = formatUuid(kidHex);

    console.log(
      `\n--- Period ${i} [${accumulatedStart.toFixed(1)}s -> ${(accumulatedStart + periodDuration).toFixed(1)}s] (${rangeEnd - rangeStart} segments x ${variantsData.length} qualities) ---`
    );
    console.log(`  KID (hex):       ${kidHex}`);
    console.log(`  KEY (hex):       ${keyHex}`);

    const videoInputArgs = rawVariantPaths.map(
      (rawPath, vIdx) =>
        `in=${rawPath},stream=video,drm_label=HD,init_segment=${path.join(periodDir, `init-video-${vIdx}.m4s`)},segment_template=${path.join(periodDir, `chunk-video-${vIdx}-$Number%05d$.m4s`)}`
    );
    // Audio is shared across all qualities - sourced from the lowest-bandwidth rendition (index 0).
    const audioInputArg = `in=${rawVariantPaths[0]},stream=audio,drm_label=AUDIO,init_segment=${path.join(periodDir, "init-audio.m4s")},segment_template=${path.join(periodDir, "chunk-audio-$Number%05d$.m4s")}`;

    const packagerArgs = [
      ...videoInputArgs,
      audioInputArg,
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
    for (const rawPath of rawVariantPaths) fs.unlinkSync(rawPath);

    periods.push({
      index: i,
      duration: periodDuration,
      start: accumulatedStart,
      keyId: { hex: kidHex, base64url: kidB64Url, uuid: kidUuid },
      key: { hex: keyHex, base64url: keyB64Url },
    });

    accumulatedStart += periodDuration;
  }

  // Step 4: Write manifest.mpd and publish.
  console.log("\n[Step 4/4] Generating multi-Period, multi-bitrate DASH manifest (manifest.mpd)...");
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

  // NOTE: like encrypt-video.ts / youtube-pipeline.ts, this overwrites
  // registry.local.json and registry.generated.ts with only THIS video.
  const registryLocal = {
    id,
    title: options.title,
    manifestPath: `${id}/manifest.mpd`,
    createdAt: new Date().toISOString(),
    periods: periods.map((p) => ({ index: p.index, duration: p.duration, start: p.start, keyId: p.keyId, key: p.key })),
  };

  const localJsonPath = path.join(projectRoot, "scripts", "registry.local.json");
  fs.writeFileSync(localJsonPath, JSON.stringify(registryLocal, null, 2));
  console.log(`✓ Wrote local key store: ${localJsonPath}`);

  const generatedTsContent = `// Auto-generated by scripts/hls-encrypt-pipeline.ts. Do not edit manually.
export interface VideoRecord {
  id: string;
  title: string;
  manifestPath: string;
  periods: { index: number; keyId: string /* hex */ }[];
}

export const GENERATED_VIDEOS: Record<string, VideoRecord> = {
  ${JSON.stringify(id)}: {
    id: ${JSON.stringify(id)},
    title: ${JSON.stringify(options.title)},
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
  console.log(`Qualities:       ${variantsData.length} (${selectedVariants.map((v) => v.resolution).join(", ")})`);
  console.log(`Key Periods:     ${periods.length} periods generated`);
  console.log(`R2 Delivery:     ${uploadedToR2 ? "Uploaded to R2" : "Skipped/Failed"}`);
  console.log(`Local Delivery:  Updated ${publicAssetsDir}`);
  console.log("=================================================\n");
}

main().catch((err) => {
  console.error("\n[FATAL PIPELINE ERROR]:", err);
  process.exit(1);
});
