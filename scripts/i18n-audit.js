/**
 * I18N Translation Audit Script
 * 
 * This script audits the three language files (en.json, da.json, ps.json)
 * to identify missing keys, inconsistencies, and potential issues.
 * 
 * Usage: node scripts/i18n-audit.js
 */

const fs = require('fs');
const path = require('path');

// Load translation files
const translationsDir = path.join(__dirname, '../locales');
const en = JSON.parse(fs.readFileSync(path.join(translationsDir, 'en.json'), 'utf8'));
const da = JSON.parse(fs.readFileSync(path.join(translationsDir, 'da.json'), 'utf8'));
const ps = JSON.parse(fs.readFileSync(path.join(translationsDir, 'ps.json'), 'utf8'));

// Get all keys from a nested object
function getAllKeys(obj, prefix = '') {
    const keys = [];
    for (const key in obj) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (typeof obj[key] === 'object' && obj[key] !== null) {
            keys.push(...getAllKeys(obj[key], fullKey));
        } else {
            keys.push(fullKey);
        }
    }
    return keys;
}

// Check if a key exists in a translation object
function keyExists(obj, key) {
    const keys = key.split('.');
    let value = obj;
    for (const k of keys) {
        if (value && value[k] !== undefined) {
            value = value[k];
        } else {
            return false;
        }
    }
    return true;
}

// Get value from nested object
function getValue(obj, key) {
    const keys = key.split('.');
    let value = obj;
    for (const k of keys) {
        if (value && value[k] !== undefined) {
            value = value[k];
        } else {
            return null;
        }
    }
    return value;
}

// Get all keys from each language
const enKeys = getAllKeys(en);
const daKeys = getAllKeys(da);
const psKeys = getAllKeys(ps);

// Find missing keys
const missingInDa = enKeys.filter(key => !keyExists(da, key));
const missingInPs = enKeys.filter(key => !keyExists(ps, key));
const missingInEn = [...new Set([...daKeys, ...psKeys])].filter(key => !keyExists(en, key));

// Find keys only in Dari or Pashto
const onlyInDa = daKeys.filter(key => !keyExists(en, key));
const onlyInPs = psKeys.filter(key => !keyExists(en, key));

// Check for empty or null values
const emptyInEn = enKeys.filter(key => {
    const val = getValue(en, key);
    return val === '' || val === null || val === undefined;
});
const emptyInDa = daKeys.filter(key => {
    const val = getValue(da, key);
    return val === '' || val === null || val === undefined;
});
const emptyInPs = psKeys.filter(key => {
    const val = getValue(ps, key);
    return val === '' || val === null || val === undefined;
});

// Output results
console.log('='.repeat(80));
console.log('I18N TRANSLATION AUDIT REPORT');
console.log('='.repeat(80));
console.log(`\nTotal keys in English: ${enKeys.length}`);
console.log(`Total keys in Dari: ${daKeys.length}`);
console.log(`Total keys in Pashto: ${psKeys.length}`);

console.log('\n' + '='.repeat(80));
console.log('MISSING KEYS (present in English but missing in other languages)');
console.log('='.repeat(80));

if (missingInDa.length > 0) {
    console.log(`\nMissing in Dari (${missingInDa.length}):`);
    missingInDa.forEach(key => console.log(`  - ${key}`));
} else {
    console.log('\n✓ No missing keys in Dari');
}

if (missingInPs.length > 0) {
    console.log(`\nMissing in Pashto (${missingInPs.length}):`);
    missingInPs.forEach(key => console.log(`  - ${key}`));
} else {
    console.log('\n✓ No missing keys in Pashto');
}

console.log('\n' + '='.repeat(80));
console.log('EXTRA KEYS (present in other languages but missing in English)');
console.log('='.repeat(80));

if (onlyInDa.length > 0) {
    console.log(`\nOnly in Dari (${onlyInDa.length}):`);
    onlyInDa.forEach(key => console.log(`  - ${key}`));
} else {
    console.log('\n✓ No extra keys in Dari');
}

if (onlyInPs.length > 0) {
    console.log(`\nOnly in Pashto (${onlyInPs.length}):`);
    onlyInPs.forEach(key => console.log(`  - ${key}`));
} else {
    console.log('\n✓ No extra keys in Pashto');
}

console.log('\n' + '='.repeat(80));
console.log('EMPTY OR NULL VALUES');
console.log('='.repeat(80));

if (emptyInEn.length > 0) {
    console.log(`\nEmpty in English (${emptyInEn.length}):`);
    emptyInEn.forEach(key => console.log(`  - ${key}`));
} else {
    console.log('\n✓ No empty values in English');
}

if (emptyInDa.length > 0) {
    console.log(`\nEmpty in Dari (${emptyInDa.length}):`);
    emptyInDa.forEach(key => console.log(`  - ${key}`));
} else {
    console.log('\n✓ No empty values in Dari');
}

if (emptyInPs.length > 0) {
    console.log(`\nEmpty in Pashto (${emptyInPs.length}):`);
    emptyInPs.forEach(key => console.log(`  - ${key}`));
} else {
    console.log('\n✓ No empty values in Pashto');
}

console.log('\n' + '='.repeat(80));
console.log('SUMMARY');
console.log('='.repeat(80));
console.log(`Total issues found: ${missingInDa.length + missingInPs.length + onlyInDa.length + onlyInPs.length + emptyInEn.length + emptyInDa.length + emptyInPs.length}`);
console.log('\nRecommendations:');
console.log('1. Add missing keys to all language files');
console.log('2. Remove or translate extra keys found only in Dari/Pashto');
console.log('3. Fill in empty or null translation values');
console.log('4. Ensure all user-facing keys exist in all three languages');
console.log('='.repeat(80));
