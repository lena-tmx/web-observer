import { chromium } from "playwright";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const TARGET_URL = process.env.TARGET_URL ?? "https://math-genius-woad.vercel.app/lang";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

type PageState = {
  page_url: string;
  page_hash: string;
  page_text: string | null;
  updated_at?: string;
};

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing env variable: ${name}`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function normalizeText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\d{1,2}:\d{2}(:\d{2})?/g, "[time]")
    .trim();
}

async function sendSlackAlert(message: string): Promise<void> {
  if (!SLACK_WEBHOOK_URL) {
    console.log("SLACK_WEBHOOK_URL is missing. Alert not sent.");
    return;
  }

  const response = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ text: message })
  });

  if (!response.ok) {
    throw new Error(`Slack alert failed: ${response.status} ${await response.text()}`);
  }
}

function makeShortDiff(oldText: string | null, newText: string): string {
  if (!oldText) return "First snapshot saved.";

  const oldWords = new Set(oldText.split(" "));
  const newWords = newText.split(" ");

  const addedWords = newWords.filter((word) => word && !oldWords.has(word));
  const preview = addedWords.slice(0, 80).join(" ");

  return preview || "Page changed, but exact text difference is small or structural.";
}

async function getPageText(): Promise<string> {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 PageMonitor/1.0 (+personal availability notification; no automated application submission)"
    });

    await page.goto(TARGET_URL, {
      waitUntil: "networkidle",
      timeout: 45000
    });

    const text = await page.locator("body").innerText();

    return normalizeText(text);
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const supabaseUrl = requireEnv("SUPABASE_URL", SUPABASE_URL);
  const supabaseKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY);
  requireEnv("TARGET_URL", TARGET_URL);
  requireEnv("SLACK_WEBHOOK_URL", SLACK_WEBHOOK_URL);

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  const jitterMs = Math.floor(Math.random() * 30000);
  await sleep(jitterMs);

  const currentText = await getPageText();
  const currentHash = hashText(currentText);

  const { data: previousState, error: selectError } = await supabase
    .from("page_state")
    .select("page_url,page_hash,page_text,updated_at")
    .eq("page_url", TARGET_URL)
    .maybeSingle<PageState>();

  if (selectError) {
    throw new Error(`Supabase select error: ${selectError.message}`);
  }

  if (!previousState) {
    const { error: insertError } = await supabase.from("page_state").insert({
      page_url: TARGET_URL,
      page_hash: currentHash,
      page_text: currentText,
      updated_at: new Date().toISOString()
    });

    if (insertError) {
      throw new Error(`Supabase insert error: ${insertError.message}`);
    }

    await sendSlackAlert(`✅ Web Observer started. First snapshot saved.\n${TARGET_URL}`);
    console.log("Initial snapshot saved.");
    return;
  }

  if (previousState.page_hash !== currentHash) {
    const diffPreview = makeShortDiff(previousState.page_text, currentText);

    const message = [
      "🚨 Page changed!",
      `URL: ${TARGET_URL}`,
      "",
      "Possible new content:",
      diffPreview.slice(0, 1000)
    ].join("\n");

    await sendSlackAlert(message);

    const { error: updateError } = await supabase
      .from("page_state")
      .update({
        page_hash: currentHash,
        page_text: currentText,
        updated_at: new Date().toISOString()
      })
      .eq("page_url", TARGET_URL);

    if (updateError) {
      throw new Error(`Supabase update error: ${updateError.message}`);
    }

    console.log("Change detected and alert sent.");
  } else {
    console.log("No change detected.");
  }
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error);

  try {
    await sendSlackAlert(`⚠️ Web Observer error:\n${message}`);
  } catch {}

  process.exit(1);
});