(function () {
  if (!location.href.startsWith('http')) return;

  function parseAppPathFromUrl(urlStr) {
    try {
      const u = new URL(urlStr);
      const segs = u.pathname.split('/').filter(Boolean);
      const sIdx = segs.indexOf('s');
      if (sIdx <= 0) return '/';
      return '/' + segs.slice(0, sIdx).join('/');
    } catch {
      return '/';
    }
  }

  function getAppPath() {
    const meta = document.querySelector('meta[name="salesforce-community-url"]');
    if (meta?.content) return parseAppPathFromUrl(meta.content);

    try {
      if (window.$A?.get) {
        const ctx = window.$A.get('$SiteContext');
        if (ctx?.urlPathPrefix) return '/' + ctx.urlPathPrefix.replace(/^\//, '');
      }
    } catch {}

    return '/';
  }

  function getMarkers() {
    const found = [];

    if (document.querySelector('meta[name="salesforce-community-url"]')) found.push('meta:salesforce-community-url');
    if (document.querySelector('meta[name="experience-id"]')) found.push('meta:experience-id');
    if (typeof window.$A !== 'undefined') found.push('global:$A');
    if (typeof window.sforce !== 'undefined') found.push('global:sforce');

    const scripts = Array.from(document.querySelectorAll('script[src]'));
    if (scripts.some(s => /\/aura|\/s\/sfsites\/aura/.test(s.src))) found.push('script:aura-path');
    if (scripts.some(s => /\.salesforce\.com|\.force\.com/.test(s.src))) found.push('script:sf-domain');

    return found;
  }

  const markers = getMarkers();
  if (markers.length === 0) return;

  chrome.runtime.sendMessage({
    type: 'SF_DETECTED_BY_FINGERPRINT',
    url: location.href,
    appPath: getAppPath(),
    markers,
  }).catch(() => {});
})();
