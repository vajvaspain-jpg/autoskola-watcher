// test-discord.js
// Samostatny test - posle jednu testovaciu spravu na Discord webhook,
// bez ohladu na to, ci su nejake terminy volne. Sluzi len na overenie,
// ze DISCORD_WEBHOOK_URL je spravne nastaveny.

const { DISCORD_WEBHOOK_URL } = process.env;

if (!DISCORD_WEBHOOK_URL) {
  console.error("DISCORD_WEBHOOK_URL chyba (skontroluj Secret v repozitari).");
  process.exit(1);
}

const message = "✅ Testovacia sprava z autoskola-watcher - ak toto vidis na Discorde, webhook funguje spravne!";

fetch(DISCORD_WEBHOOK_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ content: message }),
})
  .then(async (res) => {
    if (!res.ok) {
      console.error(`Discord webhook zlyhal: ${res.status} ${await res.text()}`);
      process.exit(1);
    }
    console.log("Testovacia sprava uspesne poslana na Discord.");
  })
  .catch((err) => {
    console.error("Chyba pri odosielani:", err.message);
    process.exit(1);
  });
