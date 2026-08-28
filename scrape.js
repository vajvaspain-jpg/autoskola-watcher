// scrape.js
// Sleduje kalendar rezervacii na rezervacie.autoskoladt.sk (Reservio) pre
// sluzbu "Jazda v cestnej premavke" (vsetky vozidla spolu - "Ktokolvek
// dostupny"). Porovna s predchadzajucim stavom ulozenym v state.json a ak
// pribudnu nove volne terminy, posle spravu na Discord webhook.
//
// POUZITIE:
//   node scrape.js            -> bezny beh (pouziva sa v GitHub Actions)
//   node scrape.js --debug    -> ulozi debug-screenshot.png, debug-html.txt
//                                 a debug-log.txt (na doladovanie)

import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const BASE_URL = "https://rezervacie.autoskoladt.sk";

// Sledujeme LEN sluzbu "Jazda v cestnej premavke (pre skupinu B)" - to je tá,
// ktoru chces. Ostatne 2 sluzby (Kondicna jazda, 1. jazda na autocviciska)
// sa ignoruju. Ak by si chcel sledovat aj ine sluzby, pridaj dalsie ID sem.
const SERVICE_ID = "ff8aebf8-f721-4fdf-a97d-2ac6bb2bcd49";
const SERVICE_NAME = "Jazda v cestnej premavke";

// Kolko dni dopredu kontrolovat
const DAYS_AHEAD = 21;

const STATE_FILE = path.join(process.cwd(), "state.json");
const DEBUG = process.argv.includes("--debug");

async function loadPreviousState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

async function saveState(slotKeys) {
  await fs.writeFile(STATE_FILE, JSON.stringify([...slotKeys].sort(), null, 2));
}

// Precita volne terminy pre sledovanu sluzbu (SERVICE_ID) - ukazuje
// spolocny kalendar za vsetky vozidla ("Ktokolvek dostupny").
// VRACIA pole objektov { date, time }.
async function waitForSpinnerGone(page, totalTimeoutMs = 30000) {
  const start = Date.now();
  let stableCount = 0;
  while (Date.now() - start < totalTimeoutMs) {
    const present = await page
      .locator("[class*='loadingContent']")
      .count()
      .then((c) => c > 0)
      .catch(() => false);
    if (!present) {
      stableCount++;
      if (stableCount >= 3) return true; // spinner chyba 3x za sebou (900ms) - povazujeme za stabilne prec
    } else {
      stableCount = 0;
    }
    await page.waitForTimeout(300);
  }
  return false;
}

async function scrapeService(page) {
  const debugLog = [];
  if (DEBUG) {
    page.on("console", (msg) => debugLog.push(`[console:${msg.type()}] ${msg.text()}`));
    page.on("pageerror", (err) => debugLog.push(`[pageerror] ${err.message}`));
    page.on("requestfailed", (req) =>
      debugLog.push(`[requestfailed] ${req.method()} ${req.url()} - ${req.failure()?.errorText}`)
    );
    page.on("response", (res) => {
      if (res.status() >= 400) {
        debugLog.push(`[response ${res.status()}] ${res.url()}`);
      }
    });
  }

  const url = `${BASE_URL}/services/${SERVICE_ID}`;
  await page.goto(url, { waitUntil: "load", timeout: 45000 });

  const results = [];

  // Tato stranka (na rozdiel od stranky vozidla) najprv chvilu zobrazuje
  // celoplosny loading spinner, kym nacita dostupnost. Pockaj, kym zmizne.
  const spinnerGoneAfterLoad = await waitForSpinnerGone(page, 30000);
  if (DEBUG) debugLog.push(`spinner gone after initial load: ${spinnerGoneAfterLoad}`);

  // Pockaj, kym sa naozaj objavi tlacidlo "Rezervovat" na stranke (nie len
  // "networkidle" - React appka moze este chvilu vykreslovat po nacitani).
  let bookButton;
  try {
    bookButton = page.getByRole("button", { name: /rezervova/i }).first();
    await bookButton.waitFor({ state: "attached", timeout: 30000 });
  } catch {
    if (DEBUG) {
      await page.screenshot({ path: "debug-screenshot.png", fullPage: true });
      await fs.writeFile("debug-html.txt", await page.content());
      await fs.writeFile("debug-log.txt", debugLog.join("\n"));
      console.log("[debug] tlacidlo Rezervovat sa vobec neobjavilo - ulozeny debug vystup");
    }
    return results;
  }

  // Pockaj, kym tlacidlo prestane byt disabled (nacitava sa dostupnost)
  try {
    await page.waitForFunction(
      () => {
        const btns = Array.from(document.querySelectorAll("button"));
        const btn = btns.find((b) => /rezervova/i.test(b.textContent || ""));
        return btn && !btn.disabled;
      },
      { timeout: 25000 }
    );
  } catch {
    if (DEBUG) {
      await page.screenshot({ path: "debug-screenshot.png", fullPage: true });
      await fs.writeFile("debug-html.txt", await page.content());
      await fs.writeFile("debug-log.txt", debugLog.join("\n"));
      console.log("[debug] tlacidlo Rezervovat ostalo disabled - ulozeny debug vystup");
    }
    return results;
  }

  await bookButton.click();

  // Klik prepne na novu podstranku (napr. /order?what=time), ktora znova
  // na chvilu zobrazi ten isty loading spinner. Pockaj, kym zmizne.
  const spinnerGoneAfterClick = await waitForSpinnerGone(page, 30000);
  if (DEBUG) debugLog.push(`spinner gone after click: ${spinnerGoneAfterClick}`);
  await page.waitForTimeout(1500);

  if (DEBUG) {
    // ochranna poistka - ak sa spinner medzitym znova objavil, este raz pockaj
    await waitForSpinnerGone(page, 10000);
    await page.screenshot({ path: "debug-screenshot.png", fullPage: true });
    await fs.writeFile("debug-html.txt", await page.content());
    console.log("[debug] ulozeny debug-screenshot.png a debug-html.txt po kliknuti na Rezervovat");
  }

  // Precitaj aktualny mesiac/rok (napr. "september 2026") - text sa
  // nachadza niekde blizko sipok pre zmenu mesiaca.
  async function readMonthYearLabel() {
    return page.evaluate(() => {
      const monthNames = [
        "januar", "februar", "marec", "april", "maj", "jun", "jul",
        "august", "september", "oktober", "november", "december",
      ];
      const all = Array.from(document.querySelectorAll("span, h1, h2, h3, div"));
      for (const el of all) {
        const t = (el.textContent || "").trim().toLowerCase();
        for (const m of monthNames) {
          if (t.startsWith(m) && /\d{4}/.test(t) && t.length < 20) {
            return el.textContent.trim();
          }
        }
      }
      return "";
    });
  }

  // Precitaj cisla dni, ktore su dostupne na klikanie (nie su disabled)
  // v aktualne zobrazenom mesiaci, spolu s ich data-test atributom.
  async function readAvailableDayHandles() {
    const dayBtns = page.locator("button[data-test^='btn-events-page-header-calendar-day-']");
    const count = await dayBtns.count();
    const out = [];
    for (let i = 0; i < count; i++) {
      const btn = dayBtns.nth(i);
      const isDisabled = await btn.getAttribute("disabled");
      if (isDisabled !== null) continue; // preskoc minule/nedostupne dni
      const dayNumText = (await btn.locator("[class*='dayNumber']").textContent().catch(() => ""))?.trim();
      if (dayNumText) out.push({ index: i, dayNum: dayNumText });
    }
    return out;
  }

  // Precitaj casove "chipy" pre aktualne vybrany den
  async function readTimeChips() {
    const chips = page.locator("[data-test*='booking-slots-chip']");
    const count = await chips.count();
    const times = [];
    for (let i = 0; i < count; i++) {
      const t = (await chips.nth(i).textContent())?.trim();
      if (t && /\d{1,2}:\d{2}/.test(t)) times.push(t);
    }
    return times;
  }

  const nextMonthArrow = page.locator(
    "[data-test='btn-booking-flow-service-choose-term-calendar-header-arrow-next-month']"
  );

  let monthsChecked = 0;
  const maxMonths = 2; // aktualny + 1 dalsi mesiac pokryje ~DAYS_AHEAD dni

  while (monthsChecked < maxMonths) {
    const monthLabel = await readMonthYearLabel();
    const availableDays = await readAvailableDayHandles();
    console.log(`Mesiac "${monthLabel}": najdenych ${availableDays.length} klikatelnych dni.`);

    if (DEBUG && monthsChecked === 0) {
      await page.screenshot({ path: "debug-screenshot-calendar.png", fullPage: true });
      await fs.writeFile("debug-html-calendar.txt", await page.content());
      await fs.writeFile("debug-log.txt", debugLog.join("\n"));
      console.log("[debug] ulozeny debug-screenshot-calendar.png a debug-html-calendar.txt (moment citania kalendara)");
    }

    for (const day of availableDays) {
      const dayBtns = page.locator("button[data-test^='btn-events-page-header-calendar-day-']");
      await dayBtns.nth(day.index).click().catch(() => {});
      await page.waitForTimeout(600);

      const times = await readTimeChips();
      console.log(`  ${day.dayNum}. ${monthLabel}: ${times.length} volnych casov (${times.join(", ")})`);
      for (const time of times) {
        results.push({
          staff: SERVICE_NAME,
          date: `${day.dayNum}. ${monthLabel}`,
          time,
        });
      }
    }

    monthsChecked++;
    if (monthsChecked < maxMonths) {
      const arrowVisible = await nextMonthArrow.isVisible().catch(() => false);
      if (!arrowVisible) break;
      await nextMonthArrow.click().catch(() => {});
      await page.waitForTimeout(800);
    }
  }

  return results;
}

async function sendDiscord(message) {
  const { DISCORD_WEBHOOK_URL } = process.env;
  if (!DISCORD_WEBHOOK_URL) {
    console.warn("DISCORD_WEBHOOK_URL chyba - sprava sa neposlala. Vypisujem sprava:");
    console.warn(message);
    return;
  }
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message }),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook zlyhal: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  // Vzdy headless (aj v debug rezime) - GitHub Actions nema obrazovku.
  // Lokalne, ak chces vidiet prehliadac naozaj, zmen na headless: false.
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const previous = await loadPreviousState();
  const current = new Set();

  console.log(`Kontrolujem sluzbu: ${SERVICE_NAME}...`);
  try {
    const slots = await scrapeService(page);
    console.log(`Spolu najdenych ${slots.length} volnych terminov na stranke.`);
    for (const slot of slots) {
      const key = `${slot.date}|${slot.time}`;
      current.add(key);
    }
  } catch (err) {
    console.error("Chyba pri kontrole:", err.message);
  }

  await browser.close();

  const newKeys = [...current].filter((k) => !previous.has(k));

  if (newKeys.length > 0) {
    console.log(`Najdenych ${newKeys.length} novych terminov.`);
    const lines = newKeys.slice(0, 10).map((k) => {
      const [date, time] = k.split("|");
      return `${date} o ${time}`;
    });
    const extra = newKeys.length > 10 ? `\n(+${newKeys.length - 10} dalsich)` : "";
    const message =
      `🚗 **Autoskola DT - nove volne jazdy!**\n${lines.join("\n")}${extra}\nRezervuj: ${BASE_URL}/services/${SERVICE_ID}`;
    await sendDiscord(message);
  } else {
    console.log("Ziadne nove terminy.");
  }

  await saveState(current);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
