#!/usr/bin/env bun
/**
 * Automated Video Downloader & ClearKey Decryptor
 * Authenticates, fetches all rotation keys, downloads DASH segments from R2,
 * decrypts them with shaka-packager, and muxes into a single MP4 with ffmpeg.
 */

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    api: "https://encr-veolms-hono.dhruvish.in",
    email: "dhruvish@gmail.com",
    out: "downloaded_video.mp4",
    workDir: "temp_download",
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--api" && args[i + 1]) options.api = args[++i];
    else if (args[i] === "--email" && args[i + 1]) options.email = args[++i];
    else if (args[i] === "--out" && args[i + 1]) options.out = args[++i];
    else if (args[i] === "--work-dir" && args[i + 1]) options.workDir = args[++i];
  }

  return options;
}

function base64UrlToHex(str: string): string {
  if (/^[0-9a-fA-F]{32}$/.test(str)) return str.toLowerCase();
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  const bin = atob(b64);
  let hex = "";
  for (let i = 0; i < bin.length; i++) {
    hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return hex.toLowerCase();
}

function runCmd(cmd: string, args: string[], cwd?: string) {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Command failed with code ${result.status}: ${cmd} ${args.join(" ")}`);
  }
}

async function main() {
  const opts = parseArgs();
  console.log("=================================================");
  console.log("  ENCRYPTED VIDEO DOWNLOADER & DECRYPTOR");
  console.log("=================================================");
  console.log(`Backend API:  ${opts.api}`);
  console.log(`User Email:   ${opts.email}`);
  console.log(`Output File:  ${opts.out}`);
  console.log("=================================================\n");

  const currentDir = (import.meta as any).dir || path.dirname(new URL(import.meta.url).pathname);
  const projectRoot = path.resolve(currentDir, "..");
  const packagerBin = path.join(projectRoot, "node_modules", "shaka-packager", "bin", "packager-linux-x64");
  if (!fs.existsSync(packagerBin)) {
    throw new Error(`shaka-packager binary not found at ${packagerBin}`);
  }

  const workDir = path.resolve(process.cwd(), opts.workDir);
  fs.mkdirSync(workDir, { recursive: true });

  // 1. Authenticate with backend
  console.log("[1/6] Logging in to backend API...");
  const loginRes = await fetch(`${opts.api}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify({ email: opts.email }),
  });
  if (!loginRes.ok) throw new Error(`Login failed with status ${loginRes.status}`);
  const { token } = (await loginRes.json()) as any;
  console.log(`✓ Authenticated successfully.`);

  // 2. Authorize video stream
  console.log("\n[2/6] Requesting video stream authorization...");
  const videoRes = await fetch(`${opts.api}/video`, {
    headers: { Authorization: `Bearer ${token}`, Origin: "http://localhost:3000" },
  });
  if (!videoRes.ok) throw new Error(`Failed to get video: ${videoRes.status}`);
  const { video } = (await videoRes.json()) as any;
  console.log(`✓ Video authorized: ${video.title} (ID: ${video.id})`);
  console.log(`  Stream Source: ${video.src}`);
  console.log(`  Key Periods:   ${video.periodCount}`);

  // 3. Retrieve all ClearKey decryption keys
  console.log("\n[3/6] Fetching all ClearKey rotation keys from license server...");
  const licenseUrl = new URL(video.encryption.licenseUrl, `${opts.api}/`);
  if (video.st) licenseUrl.searchParams.set("st", video.st);

  const licenseRes = await fetch(licenseUrl.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify({ all: true, type: "temporary" }),
  });
  if (!licenseRes.ok) throw new Error(`License fetch failed: ${licenseRes.status}`);
  const licenseData = (await licenseRes.json()) as any;
  console.log(`✓ Retrieved ${licenseData.keys?.length || 0} period keys.`);

  const keyMap = new Map<string, string>();
  for (const k of licenseData.keys) {
    const kidHex = base64UrlToHex(k.kid);
    const keyHex = base64UrlToHex(k.k);
    keyMap.set(kidHex, keyHex);
  }

  // 4. Download and parse manifest.mpd
  console.log("\n[4/6] Downloading DASH manifest from R2...");
  const manifestRes = await fetch(video.src);
  if (!manifestRes.ok) throw new Error(`Manifest download failed: ${manifestRes.status}`);
  const manifestXml = await manifestRes.text();
  const baseUrl = video.src.substring(0, video.src.lastIndexOf("/") + 1);

  // Extract periods from XML
  const periodMatches = Array.from(manifestXml.matchAll(/<Period[\s\S]*?<\/Period>/g));
  console.log(`✓ Found ${periodMatches.length} periods in manifest.`);

  const decryptedPeriods: string[] = [];

  // 5. Download and decrypt each period
  console.log("\n[5/6] Downloading & decrypting segments period by period...");
  for (let i = 0; i < periodMatches.length; i++) {
    const periodXml = periodMatches[i][0];
    const periodDir = path.join(workDir, `period-${i}`);
    fs.mkdirSync(periodDir, { recursive: true });

    // Extract default_KID
    const kidMatch = periodXml.match(/cenc:default_KID="([^"]+)"/);
    if (!kidMatch) throw new Error(`No default_KID found for period ${i}`);
    const kidUuid = kidMatch[1];
    const kidHex = kidUuid.replace(/-/g, "").toLowerCase();
    const keyHex = keyMap.get(kidHex);
    if (!keyHex) throw new Error(`Missing key for KID ${kidHex} in period ${i}`);

    console.log(`\n  Period ${i}/${periodMatches.length - 1} (KID: ${kidHex.slice(0, 8)}...)`);

    // Helper to download segment files
    const downloadFile = async (relPath: string, destPath: string) => {
      const fileUrl = new URL(relPath, baseUrl).toString();
      const res = await fetch(fileUrl);
      if (!res.ok) throw new Error(`Failed to download ${fileUrl}: ${res.status}`);
      fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
    };

    // Determine exact chunk counts from SegmentTimeline in the XML
    const videoAdapt = periodXml.match(/<AdaptationSet[^>]*contentType="video"[\s\S]*?<\/AdaptationSet>/)?.[0] || "";
    const videoChunkCount = (videoAdapt.match(/<S\b/g) || []).length || 1;

    const audioAdapt = periodXml.match(/<AdaptationSet[^>]*contentType="audio"[\s\S]*?<\/AdaptationSet>/)?.[0] || "";
    const audioChunkCount = (audioAdapt.match(/<S\b/g) || []).length || 2;

    // Download Video init and media chunks
    const vInitRel = `period-${i}/init-video.m4s`;
    const vInitPath = path.join(periodDir, "init-video.m4s");
    await downloadFile(vInitRel, vInitPath);

    const vChunkBuffers = await Promise.all(
      Array.from({ length: videoChunkCount }, async (_, idx) => {
        const chunkNum = idx + 1;
        const chunkName = `chunk-video-${String(chunkNum).padStart(5, "0")}.m4s`;
        const fileUrl = new URL(`period-${i}/${chunkName}`, baseUrl).toString();
        const res = await fetch(fileUrl);
        if (!res.ok) throw new Error(`Failed to download ${fileUrl}: ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      })
    );
    const encVideoPath = path.join(periodDir, "enc-video.mp4");
    fs.writeFileSync(encVideoPath, Buffer.concat([fs.readFileSync(vInitPath), ...vChunkBuffers]));

    // Download Audio init and media chunks
    const aInitRel = `period-${i}/init-audio.m4s`;
    const aInitPath = path.join(periodDir, "init-audio.m4s");
    await downloadFile(aInitRel, aInitPath);

    const aChunkBuffers = await Promise.all(
      Array.from({ length: audioChunkCount }, async (_, idx) => {
        const chunkNum = idx + 1;
        const chunkName = `chunk-audio-${String(chunkNum).padStart(5, "0")}.m4s`;
        const fileUrl = new URL(`period-${i}/${chunkName}`, baseUrl).toString();
        const res = await fetch(fileUrl);
        if (!res.ok) throw new Error(`Failed to download ${fileUrl}: ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      })
    );
    const encAudioPath = path.join(periodDir, "enc-audio.mp4");
    fs.writeFileSync(encAudioPath, Buffer.concat([fs.readFileSync(aInitPath), ...aChunkBuffers]));

    // Decrypt period with shaka-packager
    const decVideoPath = path.join(periodDir, "dec-video.mp4");
    const decAudioPath = path.join(periodDir, "dec-audio.mp4");
    runCmd(packagerBin, [
      `in=${encVideoPath},stream=video,output=${decVideoPath}`,
      `in=${encAudioPath},stream=audio,output=${decAudioPath}`,
      "--enable_raw_key_decryption",
      "--keys",
      `label=video:key_id=${kidHex}:key=${keyHex},label=audio:key_id=${kidHex}:key=${keyHex}`,
    ]);

    // Mux decrypted video and audio into period MP4
    const periodMuxPath = path.join(periodDir, `period-${i}.mp4`);
    runCmd("ffmpeg", ["-y", "-i", decVideoPath, "-i", decAudioPath, "-c", "copy", periodMuxPath]);
    decryptedPeriods.push(periodMuxPath);
  }

  // 6. Concatenate all periods into the final MP4
  console.log("\n[6/6] Concatenating all periods into final MP4...");
  const concatListPath = path.join(workDir, "concat_list.txt");
  const listContent = decryptedPeriods.map((f) => `file '${f}'`).join("\n");
  fs.writeFileSync(concatListPath, listContent);

  const finalOutputPath = path.resolve(process.cwd(), opts.out);
  runCmd("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatListPath, "-c", "copy", finalOutputPath]);

  // Clean up temporary download directory
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {}

  console.log("\n=================================================");
  console.log(`✓ COMPLETED SUCCESSFULLY!`);
  console.log(`  Saved decrypted video to: ${finalOutputPath}`);
  console.log("=================================================");
}

main().catch((err) => {
  console.error("\n✗ Download failed:", err);
  process.exit(1);
});
