// scrape.js
// Sleduje kalendar rezervacii na rezervacie.autoskoladt.sk (Reservio) pre
// sluzbu "Jazda v cestnej premavke", samostatne pre kazde vozidlo (VOZIDLO
// 1-5, VOZIDLO 6 tuto sluzbu neponuka). Porovna s predchadzajucim stavom
// ulozenym v state.json a ak pribudnu nove volne terminy (na ktoromkolvek
// vozidle), posle spravu na Discord webhook.
//
// POUZITIE:
//   node scrape.js            -> bezny beh (pouziva sa v GitHub Actions)
//   node scrape.js --debug    -> uklada aj debug-*.png/txt (na doladovanie),
//                                 skontroluje LEN prve vozidlo zo zoznamu

import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const BASE_URL = "https://rezervacie.autoskoladt.sk";

// Sledujeme LEN sluzbu "Jazda v cestnej premavke (pre skupinu B)".
const SERVICE_ID = "ff8aebf8-f721-4fdf-a97d-2ac6bb2bcd49";
const SERVICE_NAME = "Jazda v cestnej premavke";

// Vozidla, ktore tuto sluzbu ponukaju (VOZIDLO 6 ju neponuka - ma len
// Kondicnu jazdu, preto tu nie je).
const STAFF = [
  { id: "7efe91bb-35e4-40e1-8951-72498420af18", name: "VOZIDLO 1" },
  { id: "7499fbe9-7ed2-4bfb-8fa8-6c09308f877e", name: "VOZIDLO 2" },
  { id: "d03bafd1-25c8-4088-a356-f32feb14182f", name: "VOZIDLO 3" },
  { id: "eb809e1b-0ade-43bc-b1b9-28fb73450493", name: "VOZIDLO 4" },
  { id: "3144d483-d631-477b-9f74-d44793c93963", name: "VOZIDLO 5" },
];

// Ak pribudne menej novych terminov ako toto cislo, Discord sprava sa
// NEPOSLE (typicky ide len o 1-2 vratene/zrusene rezervacie, nie o
// hromadny refresh celeho rozvrhu). Uprav podla potreby.
const MIN_NEW_SLOTS_TO_NOTIFY = 5;

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
      if (stableCount >= 3) return true;
    } else {
      stableCount = 0;
    }
    await page.waitForTimeout(300);
  }
  return false;
}

async function readMonthYearLabel(page) {
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

async function readAvailableDayHandles(page) {
  const dayBtns = page.locator("button[data-test^='btn-events-page-header-calendar-day-']");
  const count = await dayBtns.count();
  const out = [];
  for (let i = 0; i < count; i++) {
    const btn = dayBtns.nth(i);
    const isDisabled = await btn.getAttribute("disabled");
    if (isDisabled !== null) continue;
    const dayNumText = (await btn.locator("[class*='dayNumber']").textContent().catch(() => ""))?.trim();
    if (dayNumText) out.push({ index: i, dayNum: dayNumText });
  }
  return out;
}

async function readTimeChips(page) {
  const chips = page.locator("[data-test*='booking-slots-chip']");
  const count = await chips.count();
  const times = [];
  for (let i = 0; i < count; i++) {
    const t = (await chips.nth(i).textContent())?.trim();
    if (t && /\d{1,2}:\d{2}/.test(t)) times.push(t);
  }
  return times;
}

// Po kliknuti na den sa casy nacitavaju asynchronne. Namiesto spoliehania sa
// na sietove udalosti (nespolahlive v headless CI) najprv pockame, kym sa
// obsah ZMENI oproti stavu pred kliknutim (co znamena, ze nova odpoved
// prisla), a potom este overime, ze sa obsah "ustali" (2x rovnaky vysledok
// za sebou) - aby sme nezachytili medzistav pri postupnom vykreslovani.
async function waitForStableTimeChips(page, beforeClickChips, maxWaitMs = 9000) {
  const beforeKey = JSON.stringify(beforeClickChips);
  const start = Date.now();
  let changed = false;
  let prev = null;

  while (Date.now() - start < maxWaitMs) {
    const current = await readTimeChips(page);
    const currentKey = JSON.stringify(current);

    if (!changed && currentKey !== beforeKey) {
      changed = true; // obsah sa uz zmenil oproti predchadzajucemu dnu
    }

    if (changed) {
      if (prev !== null && currentKey === prev) {
        return current; // dve rovnake citania za sebou po zmene = stabilne
      }
      prev = currentKey;
    }

    await page.waitForTimeout(500);
  }
  return readTimeChips(page);
}

// Precita volne terminy pre sluzbu "Jazda v cestnej premavke" u jedneho
// konkretneho vozidla. VRACIA pole { date, time }.
async function scrapeStaff(page, staff, debugLog) {
  const results = [];
  const url = `${BASE_URL}/staff/${staff.id}`;
  await page.goto(url, { waitUntil: "load", timeout: 45000 });

  const spinnerGoneAfterLoad = await waitForSpinnerGone(page, 30000);
  if (DEBUG) debugLog.push(`[${staff.name}] spinner gone after load: ${spinnerGoneAfterLoad}`);

  // Najdi riadok sluzby "Jazda v cestnej premavke" podla odkazu na jej
  // detail (/services/{SERVICE_ID}) a v jeho najblizsom <li> najdi
  // tlacidlo "Rezervovat".
  const serviceLink = page.locator(`a[href='/services/${SERVICE_ID}']`).first();
  const linkExists = await serviceLink.count().then((c) => c > 0).catch(() => false);
  if (!linkExists) {
    if (DEBUG) debugLog.push(`[${staff.name}] sluzba sa na tejto stranke vobec nenasla`);
    return results;
  }

  const row = serviceLink.locator("xpath=ancestor::li[1]");
  const bookButton = row.getByRole("button", { name: /rezervova/i }).first();

  try {
    await bookButton.waitFor({ state: "attached", timeout: 20000 });
    await page.waitForFunction(
      (el) => el && !el.disabled,
      await bookButton.elementHandle(),
      { timeout: 25000 }
    );
  } catch {
    if (DEBUG) debugLog.push(`[${staff.name}] tlacidlo Rezervovat sa neobjavilo/ostalo disabled`);
    return results;
  }

  await bookButton.click();

  const spinnerGoneAfterClick = await waitForSpinnerGone(page, 30000);
  if (DEBUG) debugLog.push(`[${staff.name}] spinner gone after click: ${spinnerGoneAfterClick}`);
  await page.waitForTimeout(1500);

  await page
    .waitForSelector("button[data-test^='btn-events-page-header-calendar-day-']", { timeout: 20000 })
    .catch(() => {});

  const nextMonthArrow = page.locator(
    "[data-test='btn-booking-flow-service-choose-term-calendar-header-arrow-next-month']"
  );

  let monthsChecked = 0;
  const maxMonths = 2;

  while (monthsChecked < maxMonths) {
    await page.waitForTimeout(500);
    const monthLabel = await readMonthYearLabel(page);
    const availableDays = await readAvailableDayHandles(page);
    console.log(`  [${staff.name}] mesiac "${monthLabel}": ${availableDays.length} klikatelnych dni.`);

    if (DEBUG && monthsChecked === 0) {
      await page.screenshot({ path: `debug-screenshot-${staff.name}.png`, fullPage: true });
      await fs.writeFile(`debug-html-${staff.name}.txt`, await page.content());
    }

    for (const day of availableDays) {
      const dayBtns = page.locator("button[data-test^='btn-events-page-header-calendar-day-']");
      const beforeClickChips = await readTimeChips(page);
      await dayBtns.nth(day.index).click().catch(() => {});

      const times = await waitForStableTimeChips(page, beforeClickChips, 9000);
      console.log(`    ${day.dayNum}. ${monthLabel}: ${times.length} volnych casov (${times.join(", ")})`);
      for (const time of times) {
        results.push({ staff: staff.name, date: `${day.dayNum}. ${monthLabel}`, time });
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
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const debugLog = [];

  if (DEBUG) {
    page.on("console", (msg) => debugLog.push(`[console:${msg.type()}] ${msg.text()}`));
    page.on("pageerror", (err) => debugLog.push(`[pageerror] ${err.message}`));
    page.on("requestfailed", (req) =>
      debugLog.push(`[requestfailed] ${req.method()} ${req.url()} - ${req.failure()?.errorText}`)
    );
  }

  const previous = await loadPreviousState();
  const current = new Set();

  const staffToCheck = DEBUG ? STAFF.slice(0, 1) : STAFF;

  for (const staff of staffToCheck) {
    console.log(`Kontrolujem ${staff.name}...`);
    try {
      const slots = await scrapeStaff(page, staff, debugLog);
      console.log(`  -> ${staff.name}: najdenych ${slots.length} volnych terminov.`);
      for (const slot of slots) {
        current.add(`${slot.staff}|${slot.date}|${slot.time}`);
      }
    } catch (err) {
      console.error(`Chyba pri ${staff.name}:`, err.message);
      if (DEBUG) debugLog.push(`[${staff.name}] CHYBA: ${err.message}`);
    }
  }

  if (DEBUG) {
    await fs.writeFile("debug-log.txt", debugLog.join("\n"));
  }

  await browser.close();

  console.log(`Spolu najdenych ${current.size} volnych terminov na vsetkych vozidlach.`);

  const newKeys = [...current].filter((k) => !previous.has(k));

  if (newKeys.length >= MIN_NEW_SLOTS_TO_NOTIFY) {
    console.log(`Najdenych ${newKeys.length} novych terminov - posielam Discord spravu.`);
    const lines = newKeys.slice(0, 10).map((k) => {
      const [staffName, date, time] = k.split("|");
      return `${staffName}: ${date} o ${time}`;
    });
    const extra = newKeys.length > 10 ? `\n(+${newKeys.length - 10} dalsich)` : "";
    const message =
      `🚗 **Autoskola DT - nove volne jazdy!**\n${lines.join("\n")}${extra}\nRezervuj: ${BASE_URL}/services/${SERVICE_ID}`;
    await sendDiscord(message);
  } else if (newKeys.length > 0) {
    console.log(
      `Najdenych len ${newKeys.length} novych terminov (pod prahom ${MIN_NEW_SLOTS_TO_NOTIFY}) - Discord sprava sa neposiela, len sa zaznamena stav.`
    );
  } else {
    console.log("Ziadne nove terminy.");
  }

  await saveState(current);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
