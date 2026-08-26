# Autoskola DT – hlidac volnych jazd

Skript kazdych 15 minut skontroluje kalendar rezervacii na
`rezervacie.autoskoladt.sk` pre vsetky vozidla/instruktorov, a ked pribudne
novy volny termin (ktory tam predtym nebol), posle ti SMS s konkretnym
vozidlom, datumom a casom.

Bezi zadarmo cez **GitHub Actions** – netreba nechavat zapnuty pocitac.

---

## 1. Priprava (jednorazovo)

### a) Twilio ucet (na posielanie SMS)
1. Zaregistruj sa na https://www.twilio.com/try-twilio
2. V konzole najdes **Account SID** a **Auth Token**.
3. Kup/aktivuj Twilio telefonne cislo (aj skusobny kredit staci na testovanie),
   to bude `TWILIO_FROM`.
4. `TWILIO_TO` je tvoje osobne cislo v tvare `+421...`.

> Pozn.: Ak by si chcel lacnejsiu SK-specificku alternativu (napr. smsbrana.sk),
> daj vediet – uprava `sendSms()` funkcie v `scrape.js` je jednoduchá.

### b) Vytvor si GitHub repozitar
1. Na https://github.com vytvor novy **privatny** repozitar (napr. `autoskola-watcher`).
2. Nahraj don vsetky subory z tohto priecinka.

### c) Nastav Secrets (aby sa Twilio udaje nedostali do kodu)
V repozitari: **Settings → Secrets and variables → Actions → New repository secret**
Pridaj 4 secrets:
- `TWILIO_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM`
- `TWILIO_TO`

### d) Povol Actions
**Settings → Actions → General → Allow all actions** (ak nie je uz povolene).
Workflow (`.github/workflows/watch.yml`) sa potom spusti automaticky kazdych
15 minut, alebo hned rucne cez **Actions → Sleduj volne jazdy → Run workflow**.

---

## 2. Dolezity krok pred prvym ostrym behom: kalibracia selektorov

Stranka je moderna JS aplikacia (Reservio) a presna struktura kalendara
(nazvy CSS tried) sa moze mierne lisit od toho, co je v skripte odhadnute.
Preto pred spustenim v GitHub Actions over lokalne:

```bash
npm install
npx playwright install chromium
npm run debug
```

Toto otvori prehliadac naozaj viditelne a ulozi:
- `debug-screenshot.png` – ako presne kalendar vyzera
- `debug-html.txt` – cely HTML kod stranky v danej chvili

Ak `npm run check` nenajde ziadne terminy, hoci vies, ze volne su, posli mi
(alebo si sam over v `debug-html.txt`) ako presne vyzeraju:
- tlacidla/bunky jednotlivych dni v kalendari
- tlacidla jednotlivych casovych slotov po kliknuti na den

a uprav miesta oznacene `// PRISPOSOB TU` v `scrape.js`. Rad ti selektory
doladim, ak mi sem prilepis obsah `debug-html.txt` (staci cast s kalendarom).

---

## 3. Bezny beh

- Automaticky: kazdych 15 min cez GitHub Actions.
- Rucne: `npm run check` (bez viditelneho okna prehliadaca).

Stav najdenych terminov sa uklada do `state.json` (a po kazdom behu v Actions
sa commitne spat do repozitara), takze SMS pride vzdy len na **nove**
pribudnute terminy, nie opakovane na to iste.

---

## 4. Zmena poctu dni dopredu / intervalu kontroly

- Pocet dni dopredu: premenna `DAYS_AHEAD` v `scrape.js`.
- Interval kontroly: `cron: "*/15 * * * *"` v `.github/workflows/watch.yml`
  (napr. `*/5 * * * *` pre kazdych 5 minut – odporucane minimum kvoli
  zataziu GitHub Actions).
