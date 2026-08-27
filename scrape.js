// scrape.js
// Sleduje kalendar rezervacii na rezervacie.autoskoladt.sk (Reservio) pre
// sluzbu "Jazda v cestnej premavke". Porovna s predchadzajucim stavom
// ulozenym v state.json a ak pribudnu nove volne terminy, posle spravu
// na Discord webhook.
//
// POUZITIE:
//   node scrape.js            -> bezny beh (pouziva sa v GitHub Actions)
//   node scrape.js --debug    -> otvori prehliadac viditelne, ulozi
//                                 debug-screenshot.png a debug-html.txt
//                                 aby sa dali doladit selektory nizsie

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

// Precita volne terminy pre jedneho "staff" clena.
// VRACIA pole objektov { staff, date, time }.
//
// POZOR: presne selektory (data-testid / triedy) zavisia od aktualnej
// verzie Reservio widgetu. Nizsie su najbeznejsie pouzivane vzory pre
// Reservio rezervacny kalendar. Ak skript nenajde ziadne terminy aj ked
// vies, ze volne su, spusti `npm run debug`, pozri si debug-html.txt
// a uprav selektory oznacene komentarom "PRISPOSOB TU".
// Precita volne terminy pre sledovanu sluzbu (SERVICE_ID).
// VRACIA pole objektov { staff, date, time }.
async function scrapeService(page) {
  const url = `${BASE_URL}/services/${SERVICE_ID}`;
  await page.goto(url, { waitUntil: "networkidle" });

  const results = [];

  // Pockaj, kym sa naozaj objavi tlacidlo "Rezervovat" na stranke (nie len
  // "networkidle" - React appka moze este chvilu vykreslovat po nacitani).
  let bookButton;
  try {
    bookButton = page.getByRole("button", { name: /rezervova/i }).first();
    await bookButton.waitFor({ state: "attached", timeout: 20000 });
  } catch {
    if (DEBUG) {
      await page.screenshot({ path: "debug-screenshot.png", fullPage: true });
      await fs.writeFile("debug-html.txt", await page.content());
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
      { timeout: 20000 }
    );
  } catch {
    if (DEBUG) {
      await page.screenshot({ path: "debug-screenshot.png", fullPage: true });
      await fs.writeFile("debug-html.txt", await page.content());
      console.log("[debug] tlacidlo Rezervovat ostalo disabled - ulozeny debug vystup");
    }
    return results;
  }

  await bookButton.click();
  await page.waitForTimeout(2000);

  if (DEBUG) {
    await page.screenshot({ path: "debug-screenshot.png", fullPage: true });
    await fs.writeFile("debug-html.txt", await page.content());
    console.log("[debug] ulozeny debug-screenshot.png a debug-html.txt po kliknuti na Rezervovat");
    return results;
  }

  // PRISPOSOB TU: az uvidime skutocny HTML kalendara/panelu (napr. vyber
  // vozidla, potom kalendar), doplnime presne selektory namiesto tohto odhadu.
  const dayButtons = page.locator(
    "[class*='calendar'] button:not([disabled]):not([class*='disabled'])"
  );
  const dayCount = await dayButtons.count();

  for (let i = 0; i < Math.min(dayCount, DAYS_AHEAD); i++) {
    const dayBtn = dayButtons.nth(i);
    const dayLabel = (await dayBtn.textContent())?.trim() ?? `den-${i}`;
    await dayBtn.click().catch(() => {});
    await page.waitForTimeout(500);

    const timeSlots = page.locator("[class*='time-slot'], [class*='slot']:not([class*='calendar'])");
    const slotCount = await timeSlots.count();
    for (let s = 0; s < slotCount; s++) {
      const timeText = (await timeSlots.nth(s).textContent())?.trim();
      if (timeText && /\d{1,2}:\d{2}/.test(timeText)) {
        results.push({ staff: SERVICE_NAME, date: dayLabel, time: timeText });
      }
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
    for (const slot of slots) {
      const key = `${slot.staff}|${slot.date}|${slot.time}`;
      current.add(key);
    }
  } catch (err) {
    console.error("Chyba pri kontrole:", err.message);
  }

  await browser.close();

  const newKeys = [...current].filter((k) => !previous.has(k));

  if (newKeys.length > 0) {
    console.log(`Najdenych ${newKeys.length} novych terminov.`);
    const lines = newKeys.slice(0, 8).map((k) => {
      const [staff, date, time] = k.split("|");
      return `${staff}: ${date} ${time}`;
    });
    const extra = newKeys.length > 8 ? `\n(+${newKeys.length - 8} dalsich)` : "";
    const message =
      `🚗 **Autoskola DT - nove volne jazdy!**\n${lines.join("\n")}${extra}\nRezervuj: ${BASE_URL}`;
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
