// Hides phone numbers, emails, links and messenger handles in chat, so that
// talking and paying stay inside the app (that is what keeps payment
// protection and the cargo record valid).

const HIDDEN = '[contact hidden]';

const patterns: RegExp[] = [
  // links and bare domains
  /\b(?:https?:\/\/|www\.)\S+/gi,
  /\b[\w-]+(?:\.[\w-]+)*\.(?:com|ca|net|org|io|me|app|info|biz|co|ru|ua|link|ly)\b(?:\/\S*)?/gi,
  // emails (also "name at gmail dot com")
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
  /\b[\w.+-]+\s*(?:\(at\)|\[at\]|\sat\s|собака)\s*[\w-]+\s*(?:\(dot\)|\[dot\]|\sdot\s|точка)\s*\w+/gi,
  // messenger names and handles
  /(?<![\p{L}\p{N}_])(?:whats\s?app|wa\.me|telegram|t\.me|viber|instagram|insta|snapchat|facebook|fb\.com|вотсап\p{L}*|ватсап\p{L}*|вацап\p{L}*|телегр\p{L}*|телег[уаие](?![\p{L}])|вайбер\p{L}*|инстаграм\p{L}*|инст[уае](?![\p{L}]))(?![\p{L}\p{N}_])/giu,
  /(?:^|\s)@[A-Za-z0-9_]{3,}/g,
];

// 7+ digits, possibly split by spaces, dots, dashes or brackets: phone numbers
const PHONE = /(?:\+?\d[\s().-]{0,3}){7,}\d?/g;

export function filterContacts(text: string): { text: string; hidden: boolean } {
  let hidden = false;
  let out = text;
  for (const re of patterns) {
    out = out.replace(re, (m) => {
      hidden = true;
      const lead = m.match(/^\s+/)?.[0] ?? '';
      return lead + HIDDEN;
    });
  }
  out = out.replace(PHONE, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 7) return m;
    hidden = true;
    const trail = m.match(/\s+$/)?.[0] ?? '';
    return HIDDEN + trail;
  });
  return { text: out, hidden };
}
