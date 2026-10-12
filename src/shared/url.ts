// True for URLs that may be loaded into a page view: http and https only.
export function isWebUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const { protocol } = new URL(url);
  return protocol === 'http:' || protocol === 'https:';
}
