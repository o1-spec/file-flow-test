import dotenv from "dotenv";
dotenv.config();

import { Pool } from "pg";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { PutObjectCommand, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { s3 } from "../src/s3.js";
import { v4 as uuidv4 } from "uuid";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:password@localhost:5433/filepipeline",
});

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
const connection = { url: process.env.REDIS_URL || "redis://localhost:6379" };

const dlqQueue = new Queue("dlq", { connection });
const imageQueue = new Queue("image-processing", { connection });
const pdfQueue = new Queue("pdf-processing", { connection });

async function ensureBucket() {
  const bucket = process.env.S3_BUCKET || "filepipeline";
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`[Setup] Created S3 bucket: ${bucket}`);
  }
}

async function getOrCreateUser() {
  const res = await pool.query(`SELECT id FROM users LIMIT 1`);
  if (res.rowCount > 0) return res.rows[0].id;

  const id = uuidv4();
  await pool.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
    [id, "demo@fileflow.internal", "mock_password_hash"]
  );
  return id;
}

// ── Scenario 1: Seed a failed DLQ job ────────────────────────────────────────
export async function seedDLQScenario() {
  await ensureBucket();
  const userId = await getOrCreateUser();
  const uploadId = uuidv4();
  const rawKey = `raw/${uploadId}-invoice-august.png`;

  // 1x1 valid PNG buffer
  const pngBuffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET || "filepipeline",
      Key: rawKey,
      Body: pngBuffer,
      ContentType: "image/png",
    })
  );

  await pool.query(
    `INSERT INTO uploads (id, user_id, original_filename, mime_type, size_bytes, raw_key, status, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, 'FAILED', 'Transient worker socket timeout during image rasterization')`,
    [uploadId, userId, "invoice-august.png", "image/png", pngBuffer.length, rawKey]
  );

  // Set fresh worker heartbeat so worker is detected as online
  await redis.set("worker:heartbeat", Date.now(), "EX", 30);

  // Add to DLQ
  const job = await dlqQueue.add("dlq-job", {
    originalQueue: "image-processing",
    originalJobId: `job-${uploadId}`,
    failedAt: new Date().toISOString(),
    errorMessage: "Transient worker socket timeout during image rasterization",
    attemptsMade: 3,
    payload: {
      uploadId,
      rawKey,
      mimeType: "image/png",
      originalFilename: "invoice-august.png",
    },
  });

  console.log("\n=======================================================");
  console.log("✅ SCENARIO SEEDED: Transient DLQ Failure");
  console.log("=======================================================");
  console.log(`• File: invoice-august.png (Upload ID: ${uploadId})`);
  console.log(`• DLQ Job ID: ${job.id}`);
  console.log(`• Worker Status: ONLINE (heartbeat refreshed)`);
  console.log(`\n👉 Open http://localhost:3005/operator and click "Run Evaluation"`);
  console.log(`   Watch the agent autonomously recover the job to PROCESSED!\n`);
}

// ── Scenario 2: Simulate Worker Offline ──────────────────────────────────────
export async function seedWorkerOfflineScenario() {
  await redis.del("worker:heartbeat");

  console.log("\n=======================================================");
  console.log("⚠️ SCENARIO SEEDED: Worker Offline");
  console.log("=======================================================");
  console.log(`• Removed Redis key: worker:heartbeat`);
  console.log(`\n👉 Open http://localhost:3005/operator and click "Run Evaluation"`);
  console.log(`   Watch the agent report BLOCKED and refuse blind mutations!\n`);
}

// ── Scenario 3: Clean Reset ──────────────────────────────────────────────────
export async function resetAll() {
  await dlqQueue.drain();
  await imageQueue.drain();
  await pdfQueue.drain();
  await redis.set("worker:heartbeat", Date.now(), "EX", 30);

  console.log("\n=======================================================");
  console.log("🧹 CLEAN RESET COMPLETED");
  console.log("=======================================================");
  console.log(`• Queues drained (DLQ, image, pdf)`);
  console.log(`• Worker heartbeat set to ONLINE\n`);
}

// CLI runner
const cmd = process.argv[2] || "dlq";

async function main() {
  try {
    if (cmd === "dlq") await seedDLQScenario();
    else if (cmd === "offline") await seedWorkerOfflineScenario();
    else if (cmd === "reset") await resetAll();
    else {
      console.log("Usage: node scripts/seed-simulation.js [dlq | offline | reset]");
    }
  } catch (err) {
    console.error("Simulation error:", err);
  } finally {
    await pool.end();
    await dlqQueue.close();
    await imageQueue.close();
    await pdfQueue.close();
    await redis.quit();
    process.exit(0);
  }
}

main();
