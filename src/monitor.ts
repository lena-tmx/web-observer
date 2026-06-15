import "dotenv/config";
import { chromium, type Page } from "playwright";
import crypto from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Buffer } from "node:buffer";

type ChromiumLaunchOptions = NonNullable<Parameters<typeof chromium.launch>[0]>;

const TARGET_URLS =
  process.env.TARGET_URLS?.split(",")
    .map((url) => url.trim())
    .filter(Boolean) ?? [];

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CHROMIUM_EXECUTABLE_PATH = process.env.CHROMIUM_EXECUTABLE_PATH?.trim();
const SUPABASE_SCREENSHOT_BUCKET =
  process.env.SUPABASE_SCREENSHOT_BUCKET ?? "web-observer-screenshots";

type PageState = {
  page_url: string;
  page_hash: string;
  page_text: string | null;
  updated_at?: string;
};

type PageSnapshot = {
  text: string;
  screenshot: Buffer;
};

function requireEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing env variable: ${name}`);
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

function getChromiumLaunchOptions(): ChromiumLaunchOptions {
  return {
    headless: true,
    ...(CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: CHROMIUM_EXECUTABLE_PATH }
      : {}),
  };
}

async function getPageSnapshot(targetUrl: string): Promise<PageSnapshot> {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1200 },
      userAgent:
        "Mozilla/5.0 PageMonitor/1.0 (+personal availability notification; no automated application submission)",
    });

    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    await acceptCookiesIfVisible(page);
    await openHousingSectionIfNeeded(page, targetUrl);

    await page.waitForTimeout(3000);

    const text = await page.locator("body").innerText();

    const screenshot = await page.screenshot({
      fullPage: true,
      type: "png",
    });

    return {
      text: normalizeText(text),
      screenshot,
    };
  } finally {
    await browser.close();
  }
}

async function uploadScreenshot(
  supabase: SupabaseClient,
  targetUrl: string,
  screenshot: Buffer,
): Promise<string> {
  const safeUrl = targetUrl
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9.-]/g, "_");

  const filePath = `${safeUrl}/${Date.now()}.png`;

  const { error } = await supabase.storage
    .from(SUPABASE_SCREENSHOT_BUCKET)
    .upload(filePath, screenshot, {
      contentType: "image/png",
      upsert: false,
    });

  if (error) {
    throw new Error(`Supabase screenshot upload error: ${error.message}`);
  }

  const { data } = supabase.storage
    .from(SUPABASE_SCREENSHOT_BUCKET)
    .getPublicUrl(filePath);

  return data.publicUrl;
}

function isMissingPlaywrightBrowser(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Executable doesn't exist") &&
    error.message.includes("playwright install")
  );
}

async function launchChromium() {
  try {
    return await chromium.launch(getChromiumLaunchOptions());
  } catch (error: unknown) {
    if (isMissingPlaywrightBrowser(error)) {
      throw new Error(
        "Playwright Chromium is not installed. Run `npx playwright install chromium` or set CHROMIUM_EXECUTABLE_PATH.",
      );
    }

    throw error;
  }
}

async function sendSlackAlert(message: string): Promise<void> {
  if (!SLACK_WEBHOOK_URL) {
    console.log("SLACK_WEBHOOK_URL is missing. Alert not sent.");
    return;
  }

  const response = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: message }),
  });

  if (!response.ok) {
    throw new Error(
      `Slack alert failed: ${response.status} ${await response.text()}`,
    );
  }
}

function makeShortDiff(oldText: string | null, newText: string): string {
  if (!oldText) return "First snapshot saved.";

  const oldWords = new Set(oldText.split(" "));
  const newWords = newText.split(" ");

  const addedWords = newWords.filter((word) => word && !oldWords.has(word));
  const preview = addedWords.slice(0, 80).join(" ");

  return (
    preview || "Page changed, but exact text difference is small or structural."
  );
}

async function acceptCookiesIfVisible(page: Page): Promise<void> {
  const cookieButtons = [
    "button:has-text('Alle akzeptieren')",
    "button:has-text('Alle auswählen')",
    "button:has-text('Akzeptieren')",
    "button:has-text('Accept all')",
    "button:has-text('Accept')",
    "text=Alle akzeptieren",
    "text=Alle auswählen",
    "text=Akzeptieren",
  ];

  for (const selector of cookieButtons) {
    try {
      const button = page.locator(selector).first();

      if (await button.isVisible({ timeout: 3000 })) {
        await button.click();
        await page.waitForTimeout(1000);
        console.log(`Accepted cookies using selector: ${selector}`);
        return;
      }
    } catch {
      // ignore and try next selector
    }
  }

  console.log("Cookie banner not found.");
}

async function openHousingSectionIfNeeded(
  page: Page,
  targetUrl: string,
): Promise<void> {
  if (!targetUrl.includes("birch-seebach.ch")) {
    return;
  }

  const expectedText = "Freie Objekte werden hier befristet ausgeschrieben.";

  if (
    await page
      .getByText(expectedText)
      .isVisible({ timeout: 3000 })
      .catch(() => false)
  ) {
    console.log("Housing section is already visible.");
    return;
  }

  const possibleArrowSelectors = [
    "#arrowdown",
    "lottie-player#arrowdown",
    '[aria-label="Lottie animation"]',
    "svg",
    "[class*='arrow']",
    "[aria-label*='down' i]",
    "[aria-label*='scroll' i]",
    "button:has(svg)",
    "a:has(svg)",
  ];

  for (const selector of possibleArrowSelectors) {
    try {
      const elements = page.locator(selector);
      const count = await elements.count();

      for (let i = 0; i < Math.min(count, 10); i++) {
        const element = elements.nth(i);

        if (await element.isVisible({ timeout: 1000 })) {
          await element.click({ timeout: 3000, force: true });
          await page.waitForTimeout(3000);

          const appeared = await page
            .getByText(expectedText)
            .isVisible({ timeout: 3000 })
            .catch(() => false);

          if (appeared) {
            console.log(`Housing section opened using selector: ${selector}`);
            return;
          }
        }
      }
    } catch {
      // ignore and try next selector
    }
  }

  console.log("Housing section text did not appear after arrow click.");
}

async function getPageText(targetUrl: string): Promise<string> {
  const browser = await launchChromium();

  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 PageMonitor/1.0 (+personal availability notification; no automated application submission)",
    });

    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    await acceptCookiesIfVisible(page);

    await openHousingSectionIfNeeded(page, targetUrl);

    await page.waitForTimeout(3000);

    const text = await page.locator("body").innerText();

    return normalizeText(text);
  } finally {
    await browser.close();
  }
}

async function checkPage(
  targetUrl: string,
  supabase: SupabaseClient,
): Promise<void> {
  console.log(`Checking: ${targetUrl}`);

  const snapshot = await getPageSnapshot(targetUrl);
  const currentText = snapshot.text;
  const currentHash = hashText(currentText);

  const { data: previousState, error: selectError } = await supabase
    .from("page_state")
    .select("page_url,page_hash,page_text,updated_at")
    .eq("page_url", targetUrl)
    .maybeSingle<PageState>();

  if (selectError) {
    throw new Error(
      `Supabase select error for ${targetUrl}: ${selectError.message}`,
    );
  }

  if (!previousState) {
    const { error: insertError } = await supabase.from("page_state").insert({
      page_url: targetUrl,
      page_hash: currentHash,
      page_text: currentText,
      updated_at: new Date().toISOString(),
    });

    if (insertError) {
      throw new Error(
        `Supabase insert error for ${targetUrl}: ${insertError.message}`,
      );
    }

    await sendSlackAlert(
      `✅ Web Observer started. First snapshot saved.\n${targetUrl}`,
    );
    console.log(`Initial snapshot saved: ${targetUrl}`);
    return;
  }

  if (previousState.page_hash !== currentHash) {
    const diffPreview = makeShortDiff(previousState.page_text, currentText);

    const screenshotUrl = await uploadScreenshot(
      supabase,
      targetUrl,
      snapshot.screenshot,
    );

    const message = [
      "🚨 Page changed!",
      `URL: ${targetUrl}`,
      "",
      `Screenshot: ${screenshotUrl}`,
      "",
      "Possible new content:",
      diffPreview.slice(0, 1000),
    ].join("\n");

    await sendSlackAlert(message);

    const { error: updateError } = await supabase
      .from("page_state")
      .update({
        page_hash: currentHash,
        page_text: currentText,
        updated_at: new Date().toISOString(),
      })
      .eq("page_url", targetUrl);

    if (updateError) {
      throw new Error(
        `Supabase update error for ${targetUrl}: ${updateError.message}`,
      );
    }

    console.log(`Change detected and alert sent: ${targetUrl}`);
  } else {
    console.log(`No change detected: ${targetUrl}`);
  }
}

async function main(): Promise<void> {
  if (TARGET_URLS.length === 0) {
    throw new Error("Missing env variable: TARGET_URLS");
  }

  const supabaseUrl = requireEnv("SUPABASE_URL", SUPABASE_URL);
  const supabaseKey = requireEnv(
    "SUPABASE_SERVICE_ROLE_KEY",
    SUPABASE_SERVICE_ROLE_KEY,
  );
  requireEnv("SLACK_WEBHOOK_URL", SLACK_WEBHOOK_URL);

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const jitterMs = Math.floor(Math.random() * 30000);
  await sleep(jitterMs);

  for (const targetUrl of TARGET_URLS) {
    try {
      await checkPage(targetUrl, supabase);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      await sendSlackAlert(`⚠️ Web Observer error:\n${message}`);
    }
  }
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error);

  try {
    await sendSlackAlert(`⚠️ Web Observer fatal error:\n${message}`);
  } catch {}

  process.exit(1);
});
