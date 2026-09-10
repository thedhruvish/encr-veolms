/**
 * End-to-end integration verification for the hardened encrypted video playback pipeline.
 */

import app from "../src/index";
import fs from "fs";
import path from "path";

async function runTests() {
  console.log("=================================================");
  console.log("  RUNNING E2E INTEGRATION TESTS");
  console.log("=================================================\n");

  const origin = "http://localhost:3000";
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string) {
    if (condition) {
      console.log(`✓ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`✗ FAIL: ${testName}`);
      failed++;
    }
  }

  // 1. Test Login
  const loginRes = await app.request("/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({ email: "dhruvish@gmail.com" }),
  });
  assert(loginRes.status === 200, "POST /login returns 200");
  const loginData: any = await loginRes.json();
  const loginToken = loginData.token;
  assert(Boolean(loginToken), "Login returns valid JWT token");

  // 2. Test Origin Lock-Down
  const badOriginRes = await app.request("/video", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${loginToken}`,
      Origin: "https://malicious-site.com",
    },
  });
  assert(badOriginRes.status === 403, "GET /video with unauthorized Origin returns 403 Forbidden");

  // 3. Test GET /video (Stream authorization & session minting)
  const videoRes = await app.request("/video", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${loginToken}`,
      Origin: origin,
    },
  });
  assert(videoRes.status === 200, "GET /video returns 200 OK");
  const videoJson: any = await videoRes.json();
  assert(videoJson.authenticated === true, "Video response authenticated = true");
  assert(videoJson.video.type === "application/dash+xml", "Video response type is application/dash+xml");
  assert(Boolean(videoJson.video.st), "Video response contains signed playback token (st)");
  assert(videoJson.video.encryption?.scheme === "cenc-aes-ctr", "Encryption scheme is cenc-aes-ctr");
  assert(videoJson.video.encryption?.keySystem === "org.w3.clearkey", "Key system is org.w3.clearkey");
  assert(videoJson.video.periodCount === 3, "Contains 3 key rotation periods");

  const st1 = videoJson.video.st;
  const vid = videoJson.video.id;

  // 4. Test Asset Proxy (/assets/:id/manifest.mpd)
  // 4a. Missing st token
  const noTokenRes = await app.request(`/assets/${vid}/manifest.mpd`, {
    method: "GET",
    headers: { Origin: origin },
  });
  assert(noTokenRes.status === 401, "GET /assets/... without st token returns 401");

  // 4b. Bad st token
  const badTokenRes = await app.request(`/assets/${vid}/manifest.mpd?st=invalid_token`, {
    method: "GET",
    headers: { Origin: origin },
  });
  assert(badTokenRes.status === 401, "GET /assets/... with invalid st token returns 401");

  // 4c. Valid st token -> Fetch manifest.mpd
  const manifestRes = await app.request(`/assets/${vid}/manifest.mpd?st=${encodeURIComponent(st1)}`, {
    method: "GET",
    headers: { Origin: origin },
  });
  assert(manifestRes.status === 200, "GET /assets/:id/manifest.mpd with valid st returns 200 OK");
  assert(
    manifestRes.headers.get("access-control-allow-origin") === origin,
    "GET /assets/ manifest includes Access-Control-Allow-Origin: http://localhost:3000"
  );
  assert(
    manifestRes.headers.get("access-control-allow-credentials") === "true",
    "GET /assets/ manifest includes Access-Control-Allow-Credentials: true"
  );
  assert(
    manifestRes.headers.get("access-control-expose-headers")?.includes("Content-Length") || false,
    "GET /assets/ manifest exposes Content-Length and streaming headers"
  );
  assert(
    manifestRes.headers.get("content-type")?.includes("application/dash+xml") || false,
    "Manifest content-type is application/dash+xml"
  );
  const manifestText = await manifestRes.text();
  assert(manifestText.includes("<MPD") && manifestText.includes("period-0"), "Manifest XML contains valid multi-period DASH tags");

  // 4c-preflight: OPTIONS preflight with Range header
  const preflightRes = await app.request(`/assets/${vid}/manifest.mpd`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "range,content-type",
    },
  });
  assert(preflightRes.status === 204, "OPTIONS /assets/... preflight returns 204 No Content");
  assert(
    preflightRes.headers.get("access-control-allow-headers")?.toLowerCase().includes("range") || false,
    "OPTIONS preflight allows Range request header"
  );
  assert(
    preflightRes.headers.get("access-control-allow-origin") === origin,
    "OPTIONS preflight includes Access-Control-Allow-Origin"
  );

  // 4c-range: Fetch manifest with byte Range header
  const rangeRes = await app.request(`/assets/${vid}/manifest.mpd?st=${encodeURIComponent(st1)}`, {
    method: "GET",
    headers: { Origin: origin, Range: "bytes=0-100" },
  });
  assert(
    rangeRes.status === 200 || rangeRes.status === 206,
    "GET /assets/... with Range header returns 200/206"
  );
  assert(
    rangeRes.headers.get("access-control-allow-origin") === origin,
    "GET /assets/... with Range includes Access-Control-Allow-Origin"
  );

  // 4d. Fetch init-video.m4s and verify PSSH box
  const initRes = await app.request(`/assets/${vid}/period-0/init-video.m4s?st=${encodeURIComponent(st1)}`, {
    method: "GET",
    headers: { Origin: origin },
  });
  assert(initRes.status === 200, "GET /assets/:id/period-0/init-video.m4s returns 200 OK");
  const initBytes = Buffer.from(await initRes.arrayBuffer());
  assert(initBytes.includes(Buffer.from("pssh")), "Init segment contains injected PSSH box");
  // Check Clear Key system ID 1077efec-c0b2-4d02-ace3-3c1e52e2fb4b in init segment
  assert(
    initBytes.includes(Buffer.from("1077efecc0b24d02ace33c1e52e2fb4b", "hex")),
    "PSSH box has W3C Clear Key system ID"
  );

  // 5. Test Clear Key License Exchange (POST /license/clearkey)
  // Read local registry to get real KID
  const scriptsDir = (import.meta as any).dir || path.dirname(new URL(import.meta.url).pathname);
  const registryRaw = JSON.parse(fs.readFileSync(path.resolve(scriptsDir, "registry.local.json"), "utf-8"));
  const period0KidB64 = registryRaw.periods[0].keyId.base64url;
  const period0ExpectedKeyB64 = registryRaw.periods[0].key.base64url;
  const period1KidB64 = registryRaw.periods[1].keyId.base64url;
  const period1ExpectedKeyB64 = registryRaw.periods[1].key.base64url;

  // 5a. Valid license request for period 0
  const licenseRes = await app.request(`/license/clearkey?vid=${vid}&st=${encodeURIComponent(st1)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({
      kids: [period0KidB64],
      type: "temporary",
    }),
  });
  assert(licenseRes.status === 200, "POST /license/clearkey returns 200 OK");
  const licenseData: any = await licenseRes.json();
  assert(Array.isArray(licenseData.keys) && licenseData.keys.length === 1, "License response contains 1 key");
  assert(licenseData.keys[0].kid === period0KidB64, "Returned KID matches requested KID");
  assert(licenseData.keys[0].k === period0ExpectedKeyB64, "Returned Key matches expected raw period 0 key");
  assert(licenseData.keys[0].kty === "oct", "Key type is oct (symmetric AES)");

  // 5b. Key rotation: license request for period 1
  const licenseP1Res = await app.request(`/license/clearkey?vid=${vid}&st=${encodeURIComponent(st1)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({
      kids: [period1KidB64],
      type: "temporary",
    }),
  });
  assert(licenseP1Res.status === 200, "POST /license/clearkey for period 1 returns 200 OK");
  const licenseP1Data: any = await licenseP1Res.json();
  assert(licenseP1Data.keys[0].k === period1ExpectedKeyB64, "Period 1 key rotation yields distinct period 1 key");

  // 5c. Unauthorized KID (not part of this video)
  const bogusKid = Buffer.from("00000000000000000000000000000000", "hex").toString("base64url");
  const bogusLicenseRes = await app.request(`/license/clearkey?vid=${vid}&st=${encodeURIComponent(st1)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({
      kids: [bogusKid],
      type: "temporary",
    }),
  });
  assert(
    bogusLicenseRes.status === 403 || bogusLicenseRes.status === 404,
    "License request with foreign KID returns 403/404"
  );

  // 6. Test Single Active Session Enforcement
  console.log("\nSimulating user opening a 2nd device / tab...");
  const secondVideoRes = await app.request("/video", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${loginToken}`,
      Origin: origin,
    },
  });
  assert(secondVideoRes.status === 200, "2nd GET /video succeeds and mints new session");
  const secondVideoJson: any = await secondVideoRes.json();
  const st2 = secondVideoJson.video.st;
  assert(st1 !== st2, "New session receives fresh playback token st2");

  // Attempting to fetch assets with the 1st session token should fail with session_superseded!
  const supersededAssetRes = await app.request(`/assets/${vid}/manifest.mpd?st=${encodeURIComponent(st1)}`, {
    method: "GET",
    headers: { Origin: origin },
  });
  assert(supersededAssetRes.status === 401, "1st session asset fetch returns 401 Unauthorized");
  const supersededAssetJson: any = await supersededAssetRes.json();
  assert(
    supersededAssetJson.error === "session_superseded",
    "Asset fetch error code is 'session_superseded'"
  );

  // Attempting license request with 1st session token should also fail with session_superseded
  const supersededLicenseRes = await app.request(`/license/clearkey?vid=${vid}&st=${encodeURIComponent(st1)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({
      kids: [period0KidB64],
      type: "temporary",
    }),
  });
  assert(supersededLicenseRes.status === 401, "1st session license request returns 401");
  const supersededLicenseJson: any = await supersededLicenseRes.json();
  assert(
    supersededLicenseJson.error === "session_superseded",
    "License request error code is 'session_superseded'"
  );

  // 2nd session token should work flawlessly
  const activeSessionAssetRes = await app.request(`/assets/${vid}/manifest.mpd?st=${encodeURIComponent(st2)}`, {
    method: "GET",
    headers: { Origin: origin },
  });
  assert(activeSessionAssetRes.status === 200, "2nd active session asset fetch returns 200 OK");

  // 7. Edge Cases Testing
  console.log("\nTesting edge cases...");
  // 7a. Expired playback token
  const { sign: signJwt, verify: verifyJwt } = await import("hono/jwt");
  const st2Payload: any = await verifyJwt(st2, "veolms-playback-clearkey-secret-2026", "HS256");

  const expiredSt = await signJwt(
    {
      email: "dhruvish@gmail.com",
      vid,
      sid: st2Payload.sid,
      iat: Math.floor(Date.now() / 1000) - 3600,
      exp: Math.floor(Date.now() / 1000) - 60, // expired 60s ago
    },
    "veolms-playback-clearkey-secret-2026",
    "HS256"
  );
  const expiredRes = await app.request(`/assets/${vid}/manifest.mpd?st=${encodeURIComponent(expiredSt)}`, {
    method: "GET",
    headers: { Origin: origin },
  });
  assert(expiredRes.status === 401, "Expired playback token returns 401");
  const expiredJson: any = await expiredRes.json();
  assert(expiredJson.error === "token_expired", "Expired token returns error 'token_expired'");

  // 7b. Video ID mismatch
  const mismatchedSt = await signJwt(
    {
      email: "dhruvish@gmail.com",
      vid: "other-video-id",
      sid: st2Payload.sid,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 1800,
    },
    "veolms-playback-clearkey-secret-2026",
    "HS256"
  );
  const mismatchRes = await app.request(`/assets/${vid}/manifest.mpd?st=${encodeURIComponent(mismatchedSt)}`, {
    method: "GET",
    headers: { Origin: origin },
  });
  assert(mismatchRes.status === 403, "Playback token for wrong video ID returns 403 Forbidden");

  // 7c. Missing/Non-existent asset file
  const missingAssetRes = await app.request(`/assets/${vid}/nonexistent-file.m4s?st=${encodeURIComponent(st2)}`, {
    method: "GET",
    headers: { Origin: origin },
  });
  assert(missingAssetRes.status === 404, "Requesting non-existent asset chunk returns 404 Not Found");

  // 7d. Malformed JSON on license endpoint
  const malformedLicenseRes = await app.request(`/license/clearkey?vid=${vid}&st=${encodeURIComponent(st2)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: "not-a-valid-json",
  });
  assert(malformedLicenseRes.status === 400, "Malformed JSON body to /license/clearkey returns 400 Bad Request");

  // 7e. Unauthenticated GET /video call
  const unauthVideoRes = await app.request("/video", {
    method: "GET",
    headers: { Origin: origin },
  });
  assert(unauthVideoRes.status === 401, "Unauthenticated GET /video call returns 401 Unauthorized");

  // 8. Shaka Player Engine & Error Parsing Verification
  const shaka = await import("../../react/node_modules/shaka-player/dist/shaka-player.compiled-es2021.js");
  assert(Boolean((shaka as any).default.Player), "Shaka player engine successfully loaded in test runner");

  // 8a. Verify Shaka BAD_HTTP_STATUS error payload extraction for session_superseded
  const supersededError = new (shaka as any).default.util.Error(
    (shaka as any).default.util.Error.Severity.RECOVERABLE,
    (shaka as any).default.util.Error.Category.NETWORK,
    (shaka as any).default.util.Error.Code.BAD_HTTP_STATUS,
    `http://localhost:8787/assets/${vid}/period-0/chunk-video-00001.m4s`,
    401,
    JSON.stringify({ error: "session_superseded", message: "Playback session superseded." }),
    {},
    0
  );
  const dataStr1 = JSON.stringify(supersededError.data);
  assert(
    dataStr1.includes("session_superseded"),
    "Shaka BAD_HTTP_STATUS network error cleanly embeds 'session_superseded' payload"
  );

  // 8b. Verify Shaka LICENSE_REQUEST_FAILED error payload extraction
  const licenseFailError = new (shaka as any).default.util.Error(
    (shaka as any).default.util.Error.Severity.CRITICAL,
    (shaka as any).default.util.Error.Category.DRM,
    (shaka as any).default.util.Error.Code.LICENSE_REQUEST_FAILED,
    supersededError,
    { sessionId: "test-session" }
  );
  const dataStr2 = JSON.stringify(licenseFailError.data);
  assert(
    dataStr2.includes("session_superseded"),
    "Shaka LICENSE_REQUEST_FAILED wrapping error cleanly preserves 'session_superseded'"
  );

  // 8c. Verify license exchange accepts body without application/json header
  const rawLicenseRes = await app.request(`/license/clearkey?vid=${vid}&st=${encodeURIComponent(st2)}`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "text/plain",
    },
    body: JSON.stringify({
      kids: [period0KidB64],
      type: "temporary",
    }),
  });
  assert(rawLicenseRes.status === 200, "POST /license/clearkey accepts raw text JSON payload");

  // 8d. Verify live HTTP server with run_worker_first blocks unauthenticated asset requests with 401
  try {
    const liveServerAssetRes = await fetch(`http://localhost:8787/assets/${vid}/manifest.mpd`, {
      headers: { Origin: origin },
    });
    assert(
      liveServerAssetRes.status === 401,
      "Live Cloudflare Workers server blocks unauthenticated /assets request with 401 (run_worker_first enforced)"
    );
  } catch {
    console.log("ℹ Live server check skipped (server not responding on port 8787)");
  }

  console.log("\n=================================================");
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("=================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
