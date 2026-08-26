// scrape.js
// Sleduje kalendar rezervacii na rezervacie.autoskoladt.sk (Reservio).
// Precita volne terminy pre kazde "VOZIDLO" (=instruktor/auto), porovna
// s predchadzajucim stavom ulozenym v state.json a ak pribudlo nieco nove,
// posle SMS cez Twilio.
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

// Zoznam "zamestnancov" (v tomto pripade vozidiel/instruktorov) z hlavnej stranky.
// Ak si autoskola prida/zmeni vozidla, uprav tento zoznam.
const STAFF = [
  { id: "7efe91bb-35e4-40e1-8951-72498420af18", name: "VOZIDLO 1" },
  { id: "7499fbe9-7ed2-4bfb-8fa8-6c09308f877e", name: "VOZIDLO 2" },
  { id: "d03bafd1-25c8-4088-a356-f32feb14182f", name: "VOZIDLO 3" },
  { id: "eb809e1b-0ade-43bc-b1b9-28fb73450493", name: "VOZIDLO 4" },
  { id: "3144d483-d631-477b-9f74-d44793c93963", name: "VOZIDLO 5" },
  { id: "8793ba61-b641-4c7b-8d7b-11b381a03380", name: "VOZIDLO 6" },
];

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
async function scrapeStaff(page, staff) {
  const url = `${BASE_URL}/staff/${staff.id}`;
  await page.goto(url, { waitUntil: "networkidle" });

  // Widget potrebuje chvilu na nacitanie JS aplikacie
  await page.waitForTimeout(1500);

  // Klikni na tlacidlo "Rezervovat teraz", ak este nie je otvoreny kalendar
  const bookButton = page.getByRole("button", { name: /rezervova/i }).first();
  if (await bookButton.isVisible().catch(() => false)) {
    await bookButton.click();
    await page.waitForTimeout(1000);
  }

  const results = [];

  for (let i = 0; i < DAYS_AHEAD; i++) {
    // PRISPOSOB TU: selektor pre "aktivny" (klikatelny) den v kalendari,
    // ktory nie je zasednuty ani v minulosti. Reservio zvykne pouzivat
    // <button> alebo <td> s triedou obsahujucou "available"/"active"
    // a bez triedy "disabled".
    const dayButtons = page.locator(
      "[class*='calendar'] button:not([disabled]):not([class*='disabled'])"
    );

    const count = await dayButtons.count();
    if (count === 0) break;

    // Zoberieme prvy dostupny den, klikneme, precitame casy, potom
    // presunieme kalendar na dalsi tyzden/den (sipka "dalej").
    // Kedze presna logika navigacie zavisi od widgetu, tento cyklus
    // je zamerne jednoduchy - over a doladen podla debug vystupu.
    const dayBtn = dayButtons.nth(i % count);
    const dayLabel = (await dayBtn.textContent())?.trim() ?? `den-${i}`;

    await dayBtn.click().catch(() => {});
    await page.waitForTimeout(500);

    // PRISPOSOB TU: selektor pre jednotlive casove sloty po vybrani dna.
    const timeSlots = page.locator("[class*='time-slot'], [class*='slot']:not([class*='calendar'])");
    const slotCount = await timeSlots.count();

    for (let s = 0; s < slotCount; s++) {
      const timeText = (await timeSlots.nth(s).textContent())?.trim();
      if (timeText && /\d{1,2}:\d{2}/.test(timeText)) {
        results.push({ staff: staff.name, date: dayLabel, time: timeText });
      }
    }

    if (count <= 1) break; // nema zmysel opakovat rovnaky jediny den
  }

  if (DEBUG) {
    await page.screenshot({ path: "debug-screenshot.png", fullPage: true });
    const html = await page.content();
    await fs.writeFile("debug-html.txt", html);
    console.log(`[debug] ulozeny debug-screenshot.png a debug-html.txt pre ${staff.name}`);
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
  const browser = await chromium.launch({ headless: !DEBUG });
  const page = await browser.newPage();

  const previous = await loadPreviousState();
  const current = new Set();
  const allSlots = [];

  for (const staff of STAFF) {
    console.log(`Kontrolujem ${staff.name}...`);
    try {
      const slots = await scrapeStaff(page, staff);
      for (const slot of slots) {
        const key = `${slot.staff}|${slot.date}|${slot.time}`;
        current.add(key);
        allSlots.push(slot);
      }
    } catch (err) {
      console.error(`Chyba pri ${staff.name}:`, err.message);
    }
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
