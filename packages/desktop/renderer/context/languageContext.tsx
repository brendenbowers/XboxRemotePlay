import React, { createContext, useContext, useState, useEffect } from 'react';
import { useSettings } from './userContext';
import { initI18nWithLanguage } from '../lib/i18n';

// Language context for instant switching
export const LanguageContext = createContext({
  language: 'en-US',
  setLanguage: (lang: string) => {},
});

export const LanguageProvider = ({ children }) => {
  const { settings, setSettings } = useSettings();
  const [language, setLanguageState] = useState<string | undefined>();

  // Update language in settings and state
  const setLanguage = (lang: string) => {
    setLanguageState(lang);
    setSettings({ ...settings, language: lang }); // Save to global settings
  };

  // Sync language from settings on mount/settings change
  useEffect(() => {
    if (settings.language && settings.language !== language) {
      setLanguageState(settings.language);
    }
    // Always re-init i18n when settings.language changes
    initI18nWithLanguage(settings);
  }, [settings.language]);

  return (
    <LanguageContext.Provider value={{ language, setLanguage }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = () => useContext(LanguageContext);
