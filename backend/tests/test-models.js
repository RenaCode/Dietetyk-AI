const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.join(__dirname, '../.env') });

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("Brak klucza GEMINI_API_KEY w pliku .env!");
  process.exit(1);
}

async function main() {
  console.log("Pobieranie listy modeli dla klucza API:", apiKey.substring(0, 6) + "..." + apiKey.substring(apiKey.length - 4));
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    
    if (data.error) {
      console.error("Google API error:", data.error);
      return;
    }

    console.log("\nModels that support generateContent:");
    if (data.models && data.models.length > 0) {
      data.models
        .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
        .forEach(m => {
          console.log(`  - ${m.name.replace('models/', '')} (${m.displayName})`);
        });
    } else {
      console.log("No models returned, or the response was an error:", data);
    }
  } catch (err) {
    console.error("The request failed:", err);
  }
}

main();
