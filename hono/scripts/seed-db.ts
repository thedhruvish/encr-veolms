import { createDb } from "../src/db";
import { GENERATED_VIDEOS, GENERATED_KEY_STORE } from "../src/registry.generated";

async function seed() {
  console.log("Seeding Neon database from registry.generated.ts...");
  const sql = createDb();

  // 1. Ensure default admin user exists
  await sql`
    INSERT INTO users (email, name, role)
    VALUES ('dhruvish@gmail.com', 'Dhruvish', 'admin')
    ON CONFLICT (email) DO NOTHING
  `;
  console.log("✓ Seeded admin user: dhruvish@gmail.com");

  // 2. Seed videos and key periods
  for (const [id, video] of Object.entries(GENERATED_VIDEOS)) {
    await sql`
      INSERT INTO videos (id, title, manifest_path)
      VALUES (${video.id}, ${video.title}, ${video.manifestPath})
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        manifest_path = EXCLUDED.manifest_path
    `;

    for (const period of video.periods) {
      await sql`
        INSERT INTO video_key_periods (video_id, period_idx, key_id)
        VALUES (${video.id}, ${period.index}, ${period.keyId})
        ON CONFLICT (video_id, period_idx) DO UPDATE SET
          key_id = EXCLUDED.key_id
      `;
    }
    console.log(`✓ Seeded video: ${video.id} with ${video.periods.length} key periods`);
  }

  // 3. Seed DRM key store
  for (const [keyId, keyVal] of Object.entries(GENERATED_KEY_STORE)) {
    await sql`
      INSERT INTO drm_keys (key_id, key_val)
      VALUES (${keyId}, ${keyVal})
      ON CONFLICT (key_id) DO UPDATE SET
        key_val = EXCLUDED.key_val
    `;
  }
  console.log(`✓ Seeded ${Object.keys(GENERATED_KEY_STORE).length} DRM keys`);

  const [usersCount] = await sql`SELECT COUNT(*) FROM users`;
  const [videosCount] = await sql`SELECT COUNT(*) FROM videos`;
  const [keysCount] = await sql`SELECT COUNT(*) FROM drm_keys`;

  console.log("\n--- Neon DB Stats ---");
  console.log(`Users:   ${usersCount.count}`);
  console.log(`Videos:  ${videosCount.count}`);
  console.log(`Keys:    ${keysCount.count}`);
  console.log("---------------------\n");
}

seed().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
