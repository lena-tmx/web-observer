import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_SCREENSHOT_BUCKET =
  process.env.SUPABASE_SCREENSHOT_BUCKET ?? "web-observer-screenshots";

const DAYS_TO_KEEP = Number(process.env.SCREENSHOT_DAYS_TO_KEEP ?? "30");

function requireEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing env variable: ${name}`);
  return value;
}

function isOlderThan(dateString: string, days: number): boolean {
  const updatedAt = new Date(dateString).getTime();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  return updatedAt < cutoff;
}

async function listFilesRecursively(
  supabase: ReturnType<typeof createClient>,
  prefix = "",
): Promise<string[]> {
  const { data, error } = await supabase.storage
    .from(SUPABASE_SCREENSHOT_BUCKET)
    .list(prefix, {
      limit: 1000,
      offset: 0,
    });

  if (error) {
    throw new Error(`Storage list error: ${error.message}`);
  }

  const filesToDelete: string[] = [];

  for (const item of data ?? []) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;

    if (item.metadata === null) {
      const nestedFiles = await listFilesRecursively(supabase, path);
      filesToDelete.push(...nestedFiles);
      continue;
    }

    if (item.updated_at && isOlderThan(item.updated_at, DAYS_TO_KEEP)) {
      filesToDelete.push(path);
    }
  }

  return filesToDelete;
}

async function removeInBatches(
  supabase: ReturnType<typeof createClient>,
  paths: string[],
): Promise<void> {
  const batchSize = 1000;

  for (let i = 0; i < paths.length; i += batchSize) {
    const batch = paths.slice(i, i + batchSize);

    const { error } = await supabase.storage
      .from(SUPABASE_SCREENSHOT_BUCKET)
      .remove(batch);

    if (error) {
      throw new Error(`Storage remove error: ${error.message}`);
    }

    console.log(`Deleted ${batch.length} screenshots.`);
  }
}

async function main(): Promise<void> {
  const supabaseUrl = requireEnv("SUPABASE_URL", SUPABASE_URL);
  const supabaseKey = requireEnv(
    "SUPABASE_SERVICE_ROLE_KEY",
    SUPABASE_SERVICE_ROLE_KEY,
  );

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const filesToDelete = await listFilesRecursively(supabase);

  console.log(`Found ${filesToDelete.length} old screenshots to delete.`);

  if (filesToDelete.length === 0) {
    return;
  }

  await removeInBatches(supabase, filesToDelete);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
