import { chromium } from "playwright";
import crypto from "crypto";

const TARGET_URL =
  process.env.TARGET_URL || "https://math-genius-woad.vercel.app/lang";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const STATE_KEY = `page-monitor:${TARGET_URL}:hash`;
const TEXT_KEY = `page-monitor:${TARGET_URL}:text`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashText(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function normalizeText(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/\d{1,2}:\d{2}(:\d{2})?/g, "[time]")
    .trim();
}

async function redisGet(key) {
  const res = await fetch(
    `${UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`,
    {
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      },
    },
  );

  const data = await res.json();
  return data.result;
}

async function redisSet(key, value) {
  await fetch(`${UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(value),
  });
}

async function sendSlackAlert(message) {
  if (!SLACK_WEBHOOK_URL) {
    console.log("SLACK_WEBHOOK_URL is missing. Alert not sent.");
    return;
  }

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: message }),
  });

  if (!res.ok) {
    throw new Error(`Slack alert failed: ${res.status} ${await res.text()}`);
  }
}

function makeShortDiff(oldText, newText) {
  if (!oldText) return "First snapshot saved.";

  const oldWords = new Set(oldText.split(" "));
  const newWords = newText.split(" ");

  const addedWords = newWords.filter((word) => !oldWords.has(word));
  const preview = addedWords.slice(0, 80).join(" ");

  return (
    preview || "Page changed, but exact text difference is small or structural."
  );
}

async function getPageText() {
  const browser = await chromium.launch({
    headless: true,
  });

  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 PageMonitor/1.0 (+personal availability notification; no automated application submission)",
  });

  await page.goto(TARGET_URL, {
    waitUntil: "networkidle",
    timeout: 45000,
  });

  const text = await page.locator("body").innerText();

  await browser.close();

  return normalizeText(text);
}

async function main() {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    throw new Error("Upstash Redis env variables are missing.");
  }

  const jitterMs = Math.floor(Math.random() * 30000);
  await sleep(jitterMs);

  const currentText = await getPageText();
  const currentHash = hashText(currentText);

  const previousHash = await redisGet(STATE_KEY);
  const previousText = await redisGet(TEXT_KEY);

  if (!previousHash) {
    await redisSet(STATE_KEY, currentHash);
    await redisSet(TEXT_KEY, currentText);
    console.log("Initial snapshot saved.");
    return;
  }

  if (previousHash !== currentHash) {
    const diffPreview = makeShortDiff(previousText, currentText);

    const message = [
      "🚨 Page changed!",
      `URL: ${TARGET_URL}`,
      "",
      "Possible new content:",
      diffPreview.slice(0, 1000),
    ].join("\n");

    await sendSlackAlert(message);

    await redisSet(STATE_KEY, currentHash);
    await redisSet(TEXT_KEY, currentText);

    console.log("Change detected and alert sent.");
  } else {
    console.log("No change detected.");
  }
}

main().catch(async (error) => {
  console.error(error);

  try {
    await sendSlackAlert(`⚠️ Page monitor error:\n${error.message}`);
  } catch {}

  process.exit(1);
});
