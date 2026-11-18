// ------------------------------------------------------------
// i18next setup. Import this module once, for its side effect
// (main.jsx does this for the real app; tests/setup.js does it for
// every test file), before any component calls useTranslation().
//
// Adding a language later is two steps: drop a new locales/<code>.json
// with the same keys as en.json, then add one entry to
// SUPPORTED_LANGUAGES below — nothing else in the app needs to change,
// the switcher and RTL handling both read from that list.
// ------------------------------------------------------------
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import en from './locales/en.json';

// nativeName is what's shown in the switcher — always in that
// language's own script/spelling, not translated into the current UI
// language (this is standard practice: a French speaker should see
// "Français" in the list even while the UI is in English).
export const SUPPORTED_LANGUAGES = [
  { code: 'en', nativeName: 'English', rtl: false },
  { code: 'fr', nativeName: 'Français', rtl: false },
  { code: 'ha', nativeName: 'Hausa', rtl: false },
  { code: 'yo', nativeName: 'Yorùbá', rtl: false },
  { code: 'ig', nativeName: 'Igbo', rtl: false },
  { code: 'sw', nativeName: 'Kiswahili', rtl: false },
  { code: 'ar', nativeName: 'العربية', rtl: true },
  { code: 'zh', nativeName: '中文', rtl: false },
];

export function isRtl(code) {
  return SUPPORTED_LANGUAGES.some((l) => l.code === code && l.rtl);
}

// Applies <html dir="rtl"|"ltr"> and lang="xx" — called on init below
// and by the language switcher on every change. This is the one piece
// that CSS can't do on its own: Arabic needs the whole layout mirrored
// (sidebar to the right, text flow reversed), not just the text itself.
export function applyDocumentDirection(code) {
  if (typeof document === 'undefined') return; // no-op under non-DOM test environments
  document.documentElement.lang = code;
  document.documentElement.dir = isRtl(code) ? 'rtl' : 'ltr';
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    // Each locale file's top-level keys (common/nav/login/...) become
    // nested paths under i18next's default "translation" namespace, so
    // t('login.password') resolves via keySeparator '.' without any
    // extra namespace config or a ':' prefix on every call site.
    // English ships in the main bundle; every other language is a
    // separate file fetched only when someone picks it (see
    // ensureLanguage below) — ~50 KB each that most users never need.
    resources: { en: { translation: en } },
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGUAGES.map((l) => l.code),
    // Only checks localStorage + the ss_lang key — deliberately NOT
    // detecting from the browser/OS language automatically, since a
    // shared shop terminal shouldn't silently switch away from
    // whatever the last cashier picked based on browser defaults.
    detection: { order: ['localStorage'], lookupLocalStorage: 'ss_lang', caches: ['localStorage'] },
    interpolation: { escapeValue: false }, // React already escapes
    // bindI18nStore: re-render when a lazily loaded language arrives.
    react: { useSuspense: false, bindI18nStore: 'added' },
  });

const LOADERS = {
  fr: () => import('./locales/fr.json'), ha: () => import('./locales/ha.json'), yo: () => import('./locales/yo.json'),
  ig: () => import('./locales/ig.json'), sw: () => import('./locales/sw.json'), ar: () => import('./locales/ar.json'),
  zh: () => import('./locales/zh.json'),
};

export async function ensureLanguage(code) {
  if (!code || code === 'en' || !LOADERS[code] || i18n.hasResourceBundle(code, 'translation')) return;
  const mod = await LOADERS[code]();
  i18n.addResourceBundle(code, 'translation', mod.default || mod, true, true);
}

applyDocumentDirection(i18n.resolvedLanguage || 'en');
ensureLanguage(i18n.resolvedLanguage).catch(() => {});
i18n.on('languageChanged', (code) => {
  applyDocumentDirection(code);
  ensureLanguage(code).catch(() => {}); // offline + never loaded: English stays as the fallback
});

export default i18n;
