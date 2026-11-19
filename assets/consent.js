/* LegLock cookie consent — Google Consent Mode v2.
 *
 * Every page's <head> sets the Consent Mode defaults to "denied"
 * before the Google tag loads (see the snippet above the tag). This
 * script then resolves the visitor's actual state, in order:
 *   1. A stored choice (localStorage "leglock.consent") is applied
 *      as a consent update and nothing else happens.
 *   2. With no stored choice, Cloudflare's /cdn-cgi/trace says which
 *      country the visit comes from. Only EU/EEA/UK visitors and
 *      Quebec visitors are shown the banner; everyone else is updated
 *      to "granted" (how the site behaved before the banner existed)
 *      and never sees it.
 *   3. If the country cannot be determined, the script fails safe
 *      and shows the banner.
 * A "Privacy choices" link is added to every page's footer so any
 * visitor — banner region or not — can re-open the banner and change
 * the choice at any time. Choosing Reject is one tap, same as Accept.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'leglock.consent';
  var CONSENT_KEYS = ['analytics_storage', 'ad_storage', 'ad_user_data', 'ad_personalization'];

  /* EU-27 + EEA (Iceland, Liechtenstein, Norway) + United Kingdom. */
  var BANNER_COUNTRIES = {
    AT: 1, BE: 1, BG: 1, HR: 1, CY: 1, CZ: 1, DK: 1, EE: 1, FI: 1, FR: 1,
    DE: 1, GR: 1, HU: 1, IE: 1, IT: 1, LV: 1, LT: 1, LU: 1, MT: 1, NL: 1,
    PL: 1, PT: 1, RO: 1, SK: 1, SI: 1, ES: 1, SE: 1,
    IS: 1, LI: 1, NO: 1,
    GB: 1
  };

  function applyConsent(state) {
    var update = {};
    for (var i = 0; i < CONSENT_KEYS.length; i++) update[CONSENT_KEYS[i]] = state;
    if (typeof window.gtag === 'function') {
      window.gtag('consent', 'update', update);
    } else {
      /* The head snippet defines gtag before this script runs; queue
         the update on the dataLayer in the same shape if it did not. */
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(['consent', 'update', update]);
    }
  }

  function storedChoice() {
    try {
      var v = window.localStorage.getItem(STORAGE_KEY);
      return (v === 'granted' || v === 'denied') ? v : null;
    } catch (e) { return null; }
  }

  function storeChoice(v) {
    try { window.localStorage.setItem(STORAGE_KEY, v); } catch (e) { /* storage unavailable */ }
  }

  /* Quebec heuristic for Canadian visits: the device clock is on
     Quebec time (America/Montreal) or the browser language is French. */
  function isQuebec() {
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { tz = ''; }
    if (tz === 'America/Montreal') return true;
    var lang = '';
    try { lang = (window.navigator && window.navigator.language) || ''; } catch (e) { lang = ''; }
    return /^fr/i.test(String(lang));
  }

  /* cb(true) = show the banner. Any failure to determine the country
     (no fetch, bad response, no loc line) fails safe to showing it. */
  function needsBanner(cb) {
    if (typeof window.fetch !== 'function') { cb(true); return; }
    window.fetch('/cdn-cgi/trace').then(function (res) {
      if (res && res.ok === false) throw new Error('trace request failed');
      return res.text();
    }).then(function (text) {
      var m = /(?:^|\n)loc=([A-Za-z]{2})(?:\n|$)/.exec(text || '');
      if (!m) { cb(true); return; }
      var loc = m[1].toUpperCase();
      if (BANNER_COUNTRIES[loc]) { cb(true); return; }
      if (loc === 'CA' && isQuebec()) { cb(true); return; }
      cb(false);
    }).catch(function () { cb(true); });
  }

  var banner = null;

  function buildBanner() {
    var el = document.createElement('div');
    el.className = 'consent-banner';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Cookie consent');

    var text = document.createElement('p');
    text.className = 'consent-text';
    text.appendChild(document.createTextNode(
      'We use cookies for analytics — to see which pages and props people actually use. ' +
      'Nothing is collected unless you accept. '));
    var link = document.createElement('a');
    link.setAttribute('href', '/privacy/');
    link.textContent = 'Privacy Policy';
    text.appendChild(link);
    el.appendChild(text);

    var actions = document.createElement('div');
    actions.className = 'consent-actions';

    var reject = document.createElement('button');
    reject.type = 'button';
    reject.className = 'consent-btn consent-reject';
    reject.textContent = 'Reject';
    reject.addEventListener('click', function () { choose('denied'); });
    actions.appendChild(reject);

    var accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'consent-btn consent-accept';
    accept.textContent = 'Accept';
    accept.addEventListener('click', function () { choose('granted'); });
    actions.appendChild(accept);

    el.appendChild(actions);
    return el;
  }

  function showBanner() {
    if (!banner) banner = buildBanner();
    if (!banner.parentNode && document.body) document.body.appendChild(banner);
  }

  function hideBanner() {
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
  }

  function choose(state) {
    storeChoice(state);
    applyConsent(state);
    hideBanner();
  }

  /* The footer link is present for every visitor, including regions
     that never see the banner automatically — it is their opt-out. */
  function addFooterLink() {
    var nav = document.querySelector('.site-footer-links') || document.querySelector('.footlinks');
    var el;
    if (nav && (' ' + (nav.className || '') + ' ').indexOf(' footlinks ') >= 0) {
      /* App shell: the footer nav is a row of <button>s. */
      el = document.createElement('button');
      el.type = 'button';
    } else {
      el = document.createElement('a');
      el.setAttribute('href', '#');
    }
    el.className = 'consent-choices';
    el.textContent = 'Privacy choices';
    el.addEventListener('click', function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      showBanner();
    });
    if (nav) { nav.appendChild(el); return; }
    var footer = document.querySelector('footer');
    if (footer) footer.appendChild(el);
  }

  function init() {
    addFooterLink();
    var choice = storedChoice();
    if (choice) { applyConsent(choice); return; }
    needsBanner(function (show) {
      if (show) showBanner();
      else applyConsent('granted');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
