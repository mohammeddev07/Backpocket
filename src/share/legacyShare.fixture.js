// Verbatim copy of the v1 share-parsing functions from the old single-file
// index.html (commit 80ea113). Used only by share.test.ts as an oracle: the
// ported TypeScript must return exactly what this returns. Don't edit.
const SHARE_PARAMS = ['url', 'text', 'title'];
const URL_IN_TEXT = /https?:\/\/[^\s<>"]+/gi;
const TRAILING_PUNCT = /[.,;:!?'’”»…]$/;
const CLOSER_TO_OPENER = { ')': '(', ']': '[', '}': '{' };

function trimSharedUrl(s){
  for(;;){
    const last = s.slice(-1);
    const opener = CLOSER_TO_OPENER[last];
    if(TRAILING_PUNCT.test(last)){ s = s.slice(0, -1); continue; }
    if(opener && s.split(opener).length < s.split(last).length){ s = s.slice(0, -1); continue; }
    return s;
  }
}

function firstSharedUrl(values){
  for(const value of values){
    if(!value) continue;
    for(const m of value.matchAll(URL_IN_TEXT)){
      try{
        const u = new URL(trimSharedUrl(m[0]));
        if((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.includes('.')) return u.href;
      }catch(e){}
    }
  }
  return null;
}

// The v1 applySharedPayload, reduced to its observable outputs.
export function legacyApply(search){
  const params = new URLSearchParams(search);
  if(!SHARE_PARAMS.some(k => params.has(k))) return null;
  const title = (params.get('title') || '').trim();
  const sharedUrl = firstSharedUrl(SHARE_PARAMS.map(k => params.get(k)));
  SHARE_PARAMS.forEach(k => params.delete(k));
  const qs = params.toString();
  const note = (sharedUrl && title && !/^https?:\/\/\S+$/i.test(title)) ? title : '';
  return { url: sharedUrl, note, search: qs ? '?' + qs : '' };
}

export { trimSharedUrl as legacyTrim, firstSharedUrl as legacyFirst };
