import i18n from "i18next";
import { initReactI18next } from "react-i18next";

// Import all JSON files from the languages directory
function importAllLanguages(): Record<string, { translation: any }> {
  const resources: Record<string, { translation: any }> = {};
  // @ts-ignore
  const context = require.context("../languages", false, /\.json$/);
  context.keys().forEach((key: string) => {
    // Get the file name without extension
    const langCode = key.replace("./", "").replace(".json", "");
    resources[langCode] = context(key);
  });
  return resources;
}

const resources = importAllLanguages();

// Function to initialize i18n with language from settings
export function initI18nWithLanguage(settings) {
    console.log("[i18n] Initializing i18n with settings:", settings);
  const initialLanguage = settings?.language || "en-US";
  console.log("[i18n] Initializing i18n with language:", initialLanguage);
  i18n.use(initReactI18next).init({
    resources,
    lng: initialLanguage,
    fallbackLng: initialLanguage,
    interpolation: {
      escapeValue: false,
    },
  }).then(() => {
    console.log("[i18n] i18n initialized. Current language:", i18n.language);
  }).catch((err) => {
    console.error("[i18n] i18n initialization error:", err);
  });
}

export default i18n;
