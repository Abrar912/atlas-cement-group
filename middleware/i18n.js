const fs = require('fs');
const path = require('path');

// Load translation dictionaries
const translations = {
  en: JSON.parse(fs.readFileSync(path.join(__dirname, '../locales/en.json'), 'utf8')),
  da: JSON.parse(fs.readFileSync(path.join(__dirname, '../locales/da.json'), 'utf8')),
  ps: JSON.parse(fs.readFileSync(path.join(__dirname, '../locales/ps.json'), 'utf8'))
};

// Language metadata
const languageMetadata = {
  en: { name: 'English', dir: 'ltr', locale: 'en-US' },
  da: { name: 'دری', dir: 'rtl', locale: 'fa-AF' },
  ps: { name: 'پښتو', dir: 'rtl', locale: 'ps-AF' }
};

// Default language
const DEFAULT_LANGUAGE = 'en';

// Supported languages
const SUPPORTED_LANGUAGES = ['en', 'da', 'ps'];

/**
 * Get translation by key with fallback
 * @param {string} lang - Language code
 * @param {string} key - Translation key (e.g., 'nav.dashboard')
 * @param {object} params - Parameters for interpolation
 * @returns {string} Translated text
 */
function t(lang, key, params = {}) {
  const keys = key.split('.');
  let value = translations[lang];
  let missingInCurrentLang = false;
  
  for (const k of keys) {
    if (value && value[k] !== undefined) {
      value = value[k];
    } else {
      // Fallback to English if translation not found
      missingInCurrentLang = true;
      value = translations['en'];
      for (const k2 of keys) {
        if (value && value[k2] !== undefined) {
          value = value[k2];
        } else {
          // Log missing translation for developers
          if (process.env.NODE_ENV !== 'production') {
            console.warn(`[I18N MISSING] key="${key}" lang="${lang}" - Translation not found in any language`);
          }
          // Return a clean fallback: extract last part of key and capitalize
          const lastPart = key.split('.').pop();
          return lastPart.charAt(0).toUpperCase() + lastPart.slice(1).replace(/_/g, ' ');
        }
      }
      break;
    }
  }
  
  // Log fallback to English for developers
  if (missingInCurrentLang && process.env.NODE_ENV !== 'production') {
    console.warn(`[I18N FALLBACK] key="${key}" lang="${lang}" - Using English fallback`);
  }
  
  // Parameter interpolation
  if (typeof value === 'string' && Object.keys(params).length > 0) {
    value = value.replace(/\{\{(\w+)\}\}/g, (match, param) => params[param] || match);
  }
  
  return value;
}

/**
 * Get language metadata
 * @param {string} lang - Language code
 * @returns {object} Language metadata
 */
function getLanguageMetadata(lang) {
  return languageMetadata[lang] || languageMetadata[DEFAULT_LANGUAGE];
}

/**
 * Detect user's preferred language
 * Priority: Cookie > Session > Accept-Language header > Default
 * @param {object} req - Express request object
 * @returns {string} Language code
 */
function detectLanguage(req) {
  // Check cookie first
  if (req.cookies && req.cookies.lang && SUPPORTED_LANGUAGES.includes(req.cookies.lang)) {
    return req.cookies.lang;
  }
  
  // Check session
  if (req.session && req.session.lang && SUPPORTED_LANGUAGES.includes(req.session.lang)) {
    return req.session.lang;
  }
  
  // Check Accept-Language header
  const acceptLanguage = req.headers['accept-language'];
  if (acceptLanguage) {
    const preferredLang = acceptLanguage.split(',')[0].split('-')[0];
    if (SUPPORTED_LANGUAGES.includes(preferredLang)) {
      return preferredLang;
    }
  }
  
  return DEFAULT_LANGUAGE;
}

/**
 * Format number according to locale
 * @param {number} num - Number to format
 * @param {string} lang - Language code
 * @param {object} options - Intl.NumberFormat options
 * @returns {string} Formatted number
 */
function formatNumber(num, lang = DEFAULT_LANGUAGE, options = {}) {
  const metadata = getLanguageMetadata(lang);
  const defaultOptions = {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  };
  return new Intl.NumberFormat(metadata.locale, { ...defaultOptions, ...options }).format(num);
}

/**
 * Format currency according to locale
 * @param {number} amount - Amount to format
 * @param {string} lang - Language code
 * @param {string} currency - Currency code (default: AFS)
 * @returns {string} Formatted currency
 */
function formatCurrency(amount, lang = DEFAULT_LANGUAGE, currency = 'AFN') {
  const metadata = getLanguageMetadata(lang);
  return new Intl.NumberFormat(metadata.locale, {
    style: 'currency',
    currency: currency
  }).format(amount);
}

/**
 * Format date according to locale
 * @param {Date|string} date - Date to format
 * @param {string} lang - Language code
 * @param {object} options - Intl.DateTimeFormat options
 * @returns {string} Formatted date
 */
function formatDate(date, lang = DEFAULT_LANGUAGE, options = {}) {
  const metadata = getLanguageMetadata(lang);
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  
  const defaultOptions = {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  };
  
  return new Intl.DateTimeFormat(metadata.locale, { ...defaultOptions, ...options }).format(dateObj);
}

/**
 * Format date to Jalali (Solar Hijri) for Dari/Pashto
 * @param {Date|string} date - Date to format
 * @param {string} lang - Language code
 * @returns {string} Formatted Jalali date
 */
function formatJalaliDate(date, lang = DEFAULT_LANGUAGE) {
  // Only convert to Jalali for Dari and Pashto
  if (lang !== 'da' && lang !== 'ps') {
    return formatDate(date, lang);
  }
  
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  
  // Simple Jalali conversion (approximate - for production use a library like jalaali-js)
  // This is a basic implementation for demonstration
  const gregorianDate = new Date(dateObj);
  const jalaliDate = gregorianToJalali(gregorianDate);
  
  const monthNames = lang === 'da' 
    ? ['حوت', 'اسفند', 'فروردین', 'ثور', 'جوزا', 'سرطان', 'اسد', 'سنبله', 'میزان', 'عقرب', 'قوس', 'جدی']
    : ['وری', 'غويی', 'وږی', 'غبرګولی', 'چنګاښ', 'زمری', 'وږی', 'تله', 'میزان', 'وږی', 'لړم', 'ليندۍ'];
  
  return `${jalaliDate.day} ${monthNames[jalaliDate.month - 1]} ${jalaliDate.year}`;
}

/**
 * Gregorian to Jalali conversion
 * Using Intl.DateTimeFormat with Persian calendar for accurate conversion
 * This is a platform-supported approach that uses Node.js built-in ICU library
 * @param {Date} gregorianDate - Gregorian date
 * @returns {object} Jalali date {year, month, day}
 */
function gregorianToJalali(gregorianDate) {
  try {
    // Use Intl.DateTimeFormat with Persian calendar (u-ca-persian)
    // This is built into Node.js via ICU library
    const formatter = new Intl.DateTimeFormat('fa-AF-u-ca-persian', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      calendar: 'persian'
    });
    
    const parts = formatter.formatToParts(gregorianDate);
    
    let year, month, day;
    parts.forEach(part => {
      if (part.type === 'year') {
        // Convert Persian numerals to ASCII
        year = parseInt(part.value.replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
      } else if (part.type === 'month') {
        month = parseInt(part.value.replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
      } else if (part.type === 'day') {
        day = parseInt(part.value.replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
      }
    });
    
    return { year, month, day };
  } catch (e) {
    // Fallback to approximate algorithm if Intl not available
    console.warn('Intl Persian calendar not available, using fallback algorithm');
    return gregorianToJalaliFallback(gregorianDate);
  }
}

/**
 * Fallback Gregorian to Jalali conversion
 * Used only if Intl Persian calendar is not available
 * @param {Date} gregorianDate - Gregorian date
 * @returns {object} Jalali date {year, month, day}
 */
function gregorianToJalaliFallback(gregorianDate) {
  const originalGy = gregorianDate.getFullYear();
  let gy = originalGy;
  const gm = gregorianDate.getMonth() + 1;
  const gd = gregorianDate.getDate();
  
  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  
  let jy = (gy <= 1600) ? 0 : 979;
  gy -= (gy <= 1600) ? 621 : 1600;
  const gy2 = (gm > 2) ? (gy + 1) : gy;
  let days = (365 * gy) + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) - 80 + gd + g_d_m[gm - 1];
  
  jy += 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  jy += Math.floor((days - 1) / 365);
  
  if (days > 365) days = (days - 1) % 365;
  
  const jm = (days < 186) ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + ((days < 186) ? (days % 31) : ((days - 186) % 30));
  
  return { year: jy, month: jm, day: jd };
}

/**
 * Get current Solar Hijri year/month in YYYY/MM format
 * @returns {string} Current Jalali year/month (e.g., "1405/06")
 */
function getCurrentJalaliMonth() {
  const today = new Date();
  const jalaliDate = gregorianToJalali(today);
  const year = jalaliDate.year.toString();
  const month = jalaliDate.month.toString().padStart(2, '0');
  return `${year}/${month}`;
}

/**
 * Get current Solar Hijri date in YYYY/MM/DD format
 * @returns {string} Current Jalali date (e.g., "1405/06/19")
 */
function getCurrentJalaliDate() {
  const today = new Date();
  const jalaliDate = gregorianToJalali(today);
  const year = jalaliDate.year.toString();
  const month = jalaliDate.month.toString().padStart(2, '0');
  const day = jalaliDate.day.toString().padStart(2, '0');
  return `${year}/${month}/${day}`;
}

/**
 * Check if a Solar Hijri year is a leap year
 * Uses the 33-year cycle (Borkowski algorithm)
 * Leap years in the 33-year cycle: 1, 5, 9, 13, 17, 22, 26, 30
 * @param {number} year - Solar Hijri year
 * @returns {boolean} True if leap year
 */
function isJalaliLeapYear(year) {
  const yearInCycle = year % 33;
  return [1, 5, 9, 13, 17, 22, 26, 30].includes(yearInCycle);
}

/**
 * Get the number of days in a Solar Hijri month
 * @param {number} year - Solar Hijri year
 * @param {number} month - Solar Hijri month (1-12)
 * @returns {number} Number of days in the month
 */
function getDaysInJalaliMonth(year, month) {
  if (month < 1 || month > 12) return 0;
  if (month <= 6) return 31;
  if (month <= 11) return 30;
  return isJalaliLeapYear(year) ? 30 : 29;
}

/**
 * Validate a Solar Hijri date
 * @param {number} year - Solar Hijri year
 * @param {number} month - Solar Hijri month (1-12)
 * @param {number} day - Solar Hijri day
 * @returns {boolean} True if date is valid
 */
function validateJalaliDate(year, month, day) {
  if (typeof year !== 'number' || typeof month !== 'number' || typeof day !== 'number') {
    return false;
  }
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  if (day > getDaysInJalaliMonth(year, month)) return false;
  return true;
}

/**
 * Compare two Solar Hijri dates
 * @param {object} date1 - First date {year, month, day}
 * @param {object} date2 - Second date {year, month, day}
 * @returns {number} -1 if date1 < date2, 0 if equal, 1 if date1 > date2
 */
function compareJalaliDates(date1, date2) {
  if (date1.year !== date2.year) return date1.year < date2.year ? -1 : 1;
  if (date1.month !== date2.month) return date1.month < date2.month ? -1 : 1;
  if (date1.day !== date2.day) return date1.day < date2.day ? -1 : 1;
  return 0;
}

/**
 * Subtract exactly one day from a Solar Hijri date
 * @param {number} year - Solar Hijri year
 * @param {number} month - Solar Hijri month (1-12)
 * @param {number} day - Solar Hijri day
 * @returns {object} Previous day {year, month, day}
 */
function subtractOneJalaliDay(year, month, day) {
  let newDay = day - 1;
  let newMonth = month;
  let newYear = year;

  if (newDay < 1) {
    newMonth--;
    if (newMonth < 1) {
      newMonth = 12;
      newYear--;
    }
    newDay = getDaysInJalaliMonth(newYear, newMonth);
  }

  return { year: newYear, month: newMonth, day: newDay };
}

/**
 * Add exactly one day to a Solar Hijri date
 * @param {number} year - Solar Hijri year
 * @param {number} month - Solar Hijri month (1-12)
 * @param {number} day - Solar Hijri day
 * @returns {object} Next day {year, month, day}
 */
function addOneJalaliDay(year, month, day) {
  let newDay = day + 1;
  let newMonth = month;
  let newYear = year;
  const daysInMonth = getDaysInJalaliMonth(year, month);

  if (newDay > daysInMonth) {
    newDay = 1;
    newMonth++;
    if (newMonth > 12) {
      newMonth = 1;
      newYear++;
    }
  }

  return { year: newYear, month: newMonth, day: newDay };
}

/**
 * Calculate elapsed days between two Solar Hijri dates
 * @param {object} startDate - Start date {year, month, day}
 * @param {object} endDate - End date {year, month, day}
 * @returns {number} Number of elapsed days (0 if end <= start)
 */
function calculateJalaliDaysBetween(startDate, endDate) {
  // If end date is before or equal to start date, return 0
  if (compareJalaliDates(endDate, startDate) <= 0) {
    return 0;
  }
  
  let days = 0;
  // Start from the day after startDate
  let currentDate = addOneJalaliDay(startDate.year, startDate.month, startDate.day);
  
  while (compareJalaliDates(currentDate, endDate) <= 0) {
    days++;
    currentDate = addOneJalaliDay(currentDate.year, currentDate.month, currentDate.day);
  }
  
  return days;
}

/**
 * Express middleware for i18n
 */
function i18nMiddleware(req, res, next) {
  const lang = detectLanguage(req);
  const metadata = getLanguageMetadata(lang);
  
  // Store language in session for persistence
  req.session.lang = lang;
  
  // Make translation functions available in templates
  res.locals.t = (key, params) => t(lang, key, params);
  res.locals.lang = lang;
  res.locals.dir = metadata.dir;
  res.locals.locale = metadata.locale;
  res.locals.languageName = metadata.name;
  
  // Make localization helpers available
  res.locals.formatNumber = (num, options) => formatNumber(num, lang, options);
  res.locals.formatCurrency = (amount, currency) => formatCurrency(amount, lang, currency);
  res.locals.formatDate = (date, options) => formatDate(date, lang, options);
  res.locals.formatJalaliDate = (date) => formatJalaliDate(date, lang);
  res.locals.getCurrentJalaliDate = getCurrentJalaliDate;
  
  // Make translation object available for client-side use
  res.locals.translations = JSON.stringify(translations[lang]);
  res.locals.currentLanguage = lang;
  
  next();
}

/**
 * Set language preference
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @param {string} lang - Language code
 */
function setLanguage(req, res, lang) {
  if (!SUPPORTED_LANGUAGES.includes(lang)) {
    lang = DEFAULT_LANGUAGE;
  }
  
  // Set in session
  req.session.lang = lang;
  
  // Set in cookie (1 year expiration)
  res.cookie('lang', lang, {
    maxAge: 365 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production'
  });
  
  return lang;
}

module.exports = {
  i18nMiddleware,
  t,
  getLanguageMetadata,
  detectLanguage,
  formatNumber,
  formatCurrency,
  formatDate,
  formatJalaliDate,
  getCurrentJalaliMonth,
  getCurrentJalaliDate,
  isJalaliLeapYear,
  getDaysInJalaliMonth,
  validateJalaliDate,
  compareJalaliDates,
  subtractOneJalaliDay,
  formatDate,
  formatJalaliDate,
  getCurrentJalaliMonth,
  getCurrentJalaliDate,
  isJalaliLeapYear,
  getDaysInJalaliMonth,
  validateJalaliDate,
  compareJalaliDates,
  subtractOneJalaliDay,
  addOneJalaliDay,
  calculateJalaliDaysBetween,
  setLanguage,
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE
};
