// Hesitation sounds that speech models write out, in English and Russian.
const FILLERS = /^(?:u+h+|u+m+|u+h+m+|e+r+m+|h+m+|m{2,}|э+|э+м+|м{2,})$/iu;
const EDGE = /^([("«“]*)(.*?)([.,!?;:…)"»”]*)$/su;

// The text without filler words such as "um" and "uh"; sentence ends they carried move to the word before.
export function removeFillers(text) {
  const kept = [];
  let capitalizeNext = false;
  for (const token of text.split(/\s+/).filter(Boolean)) {
    const [, open, core, close] = token.match(EDGE);
    const bare = core.replace(/-/g, '');
    // Quoted words and all-caps acronyms such as "UM" are kept.
    const quoted = /["«“]/.test(open) || /["»”]/.test(close);
    const acronym = bare.length > 1 && bare === bare.toUpperCase() && bare !== bare.toLowerCase();
    if (FILLERS.test(bare) && !quoted && !acronym) {
      const end = close.replace(/,/g, '');
      const previous = kept.at(-1);
      // ", uh," marks a pause and its commas go with it, unless the words before it form a comma list.
      const inList = /,$/.test(kept.at(-2) ?? '');
      if (previous && end && !/[.!?…]$/.test(previous)) kept[kept.length - 1] = previous.replace(/[,;:]$/, '') + end;
      else if (previous && close.includes(',') && /,$/.test(previous) && !inList) kept[kept.length - 1] = previous.slice(0, -1);
      if (kept.length === 0 || /[.!?…]$/.test(kept.at(-1) ?? '')) capitalizeNext = capitalizeNext || /^\p{Lu}/u.test(core);
      continue;
    }
    let word = token;
    if (capitalizeNext) {
      word = open + core.charAt(0).toLocaleUpperCase() + core.slice(1) + close;
      capitalizeNext = false;
    }
    kept.push(word);
  }
  return kept.join(' ');
}

// The languages Parakeet v3 knows, and the alphabet each is written in.
const CYRILLIC = new Set(['bg', 'ru', 'uk']);
export const LANGUAGES = ['bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'hr', 'hu', 'it', 'lt', 'lv', 'mt', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'uk'];
const alphabet = (language) => (CYRILLIC.has(language) ? 'Cyrillic' : language === 'el' ? 'Greek' : 'Latin');

// Whether the text holds letters from an alphabet other than the language's own.
export function inOtherAlphabet(text, language) {
  const own = new RegExp(`\\p{Script=${alphabet(language)}}`, 'u');
  return [...text.matchAll(/\p{L}/gu)].some(([letter]) => !own.test(letter));
}
