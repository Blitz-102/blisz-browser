const SEARCH_URL = 'https://www.google.com/search?q=';

const IPV4 = String.raw`\d{1,3}(?:\.\d{1,3}){3}`;
const DOMAIN = String.raw`(?:[a-z0-9-]+\.)+[a-z]{2,}`;
// localhost, an IPv4 address or a domain, then an optional port and path.
const HOST_LIKE = new RegExp(String.raw`^(localhost|${IPV4}|${DOMAIN})(:\d+)?(?:[/?#]|$)`, 'i');
const LOCAL_HOST_LIKE = new RegExp(String.raw`^(localhost|${IPV4})(:\d+)?(?:[/?#]|$)`, 'i');
const BRACKETED_IPV6 = /^\[[0-9a-f:.]+\](:\d+)?(?:[/?#]|$)/i;
const BARE_IPV6 = /^[0-9a-f]*:[0-9a-f]*:[0-9a-f:.]*$/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// Turns what the user typed into a URL to load, or '' for empty input. An explicit scheme is
// kept as typed: the caller must check it (only http and https may be loaded).
export function toNavigableUrl(input: string): string {
  const text = input.trim();
  if (text === '') return '';
  if (/\s/.test(text)) return SEARCH_URL + encodeURIComponent(text);
  if (BARE_IPV6.test(text) && URL.canParse(`http://[${text}]`)) return `http://[${text}]`;
  if (BRACKETED_IPV6.test(text) || LOCAL_HOST_LIKE.test(text)) return `http://${text}`;
  if (HOST_LIKE.test(text)) return `https://${text}`;
  if (HAS_SCHEME.test(text)) return text;
  return SEARCH_URL + encodeURIComponent(text);
}
