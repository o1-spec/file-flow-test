import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

function getSslConfig(dbUrl) {
  if (!dbUrl) return false;
  if (
    dbUrl.includes("localhost") ||
    dbUrl.includes("127.0.0.1") ||
    dbUrl.includes("@postgres:5432")
  ) {
    return false;
  }
  try {
    const parsed = new URL(dbUrl);
    if (parsed.hostname.startsWith("dpg-") && !parsed.hostname.includes(".")) {
      return false;
    }
  } catch (e) {
    if (dbUrl.includes("@dpg-") && !dbUrl.includes(".render.com")) {
      return false;
    }
  }
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: getSslConfig(process.env.DATABASE_URL),
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle PostgreSQL client", err);
});

async function initDb() {
  console.log("Connecting to database:", process.env.DATABASE_URL.split("@")[1]);
  
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log("✅ Created users table");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS uploads (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        original_filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes BIGINT,
        status TEXT NOT NULL,
        raw_key TEXT,
        processed_key TEXT,
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log("✅ Created uploads table");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        environment TEXT NOT NULL,
        region TEXT NOT NULL,
        worker_concurrency INT NOT NULL DEFAULT 4,
        transaction_id TEXT,
        status TEXT NOT NULL DEFAULT 'PENDING',
        console_url TEXT,
        mcpx_state JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log("✅ Created workspaces table");
    
    console.log("🎉 Database initialized successfully!");
  } catch (err) {
    console.error("❌ Failed to initialize database:", err);
  } finally {
    await pool.end();
  }
}

initDb();
