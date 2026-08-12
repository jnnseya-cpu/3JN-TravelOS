// Anti-hacking Threat Shield — the active perimeter agent.
//
// This is the "anti-hacking AI agent" the OS runs in front of every request. It
// does three jobs, all deliberately CONSERVATIVE so it never blocks a real human:
//   1. Fingerprint the request for attack signatures that a real browser never
//      produces — scanner/exploit User-Agents, path-traversal + secret-file
//      probes, and structural injection keys ($where / __proto__ / $ne) in the
//      JSON body SHAPE (never in free-text values, so a one-sentence travel
//      search like `flights to "New York" — select the cheapest` is untouched).
//   2. Track offences per source IP and QUARANTINE an IP that trips repeatedly
//      inside a short window (an automated scanner fires hundreds of these; a
//      human fat-fingering a URL trips zero to one).
//   3. Report live blocks so the Security Agent's posture is ACTIVE, not a
//      passive read of past auth failures.
//
// What it is NOT: a claim of perfect bot-proofing. No WAF is. It raises the bar
// steeply against commodity automation (sqlmap, nikto, nmap, wpscan, mass
// exploit sweeps) while leaving legitimate app traffic — including the app's own
// fetch() calls and normal human requests — completely unaffected.

// ---- Signature tables -----------------------------------------------------

// Attack-tooling User-Agents. Real browsers and our own frontend never send
// these. Matched case-insensitively as substrings.
const BAD_USER_AGENTS = [
  'sqlmap', 'nikto', 'nmap', 'masscan', 'nessus', 'acunetix', 'nuclei',
  'wpscan', 'dirbuster', 'gobuster', 'feroxbuster', 'ffuf', 'hydra',
  'zgrab', 'zmap', 'metasploit', 'havij', 'arachni', 'w3af', 'openvas',
  'commix', 'xsser', 'wfuzz', 'netsparker', 'qualys', 'whatweb',
];

// Path probes. These target files/routes that DO NOT EXIST in this app — a real
// user clicking around the SPA never generates them; they are the calling cards
// of automated content-discovery and secret-harvesting scans.
const BAD_PATH_PATTERNS = [
  /\.\.[/\\]/,                      // path traversal ../  ..\
  /%2e%2e[%2f%5c]/i,               // url-encoded traversal
  /\/\.(?:env|git|svn|hg|aws|ssh|htpasswd|htaccess|npmrc|dockercfg)\b/i,
  /\/(?:wp-admin|wp-login|wp-content|wp-includes|xmlrpc\.php)/i,
  /\.(?:php|asp|aspx|jsp|cgi|pl|py|sh|bak|old|sql|swp)(?:$|\?)/i,
  /\/(?:phpmyadmin|pma|adminer|dbadmin|mysqladmin)/i,
  /\/(?:actuator|console|solr|jenkins|struts|cgi-bin)\b/i,
  /\/(?:id_rsa|id_dsa|\.DS_Store|web\.config|config\.json|credentials)\b/i,
  /\/vendor\/phpunit/i,
  /\$\{jndi:/i,                    // log4shell in the URL
];

// Structural injection keys. We inspect the SHAPE of a parsed JSON body — object
// KEYS only — for operators that belong to NoSQL query injection or JS
// prototype pollution. A traveller can type these words as VALUES ("I want to
// $ave money", "proto smoothie bar") and never trip this, because we only ever
// look at keys, never at string values.
const DANGEROUS_KEYS = new Set([
  '__proto__', 'constructor', 'prototype',
  '$where', '$ne', '$gt', '$lt', '$gte', '$lte', '$regex', '$expr',
  '$function', '$accumulator', '$javascript', 'mapReduce',
]);

// ---- Body-shape inspection ------------------------------------------------

// Walk a parsed JSON body looking ONLY at object keys (depth-capped so a hostile
// deeply-nested payload can't wedge us). Returns the first dangerous key found.
function scanKeys(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = scanKeys(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) return key;
    const hit = scanKeys(value[key], depth + 1);
    if (hit) return hit;
  }
  return null;
}

// ---- Per-IP offence tracking + quarantine ---------------------------------

// In-memory offence ledger. Serverless instances are short-lived, so this is a
// per-instance fast-path, not the system of record — the immutable audit log
// (written by the caller) is the durable trail. Even a single instance seeing a
// burst is enough to shut a scanner down for the life of that instance.
const OFFENCE_WINDOW_MS = 10 * 60 * 1000;   // offences age out after 10 min
const QUARANTINE_MS = 30 * 60 * 1000;       // a tripped IP is iced for 30 min
const OFFENCE_THRESHOLD = 4;                // trips within the window → quarantine
const MAX_TRACKED_IPS = 5000;               // bound memory against IP-spraying

const offenders = new Map(); // ip -> { hits: number[], quarantinedUntil: number, total: number }

function pruneOffenders(now) {
  if (offenders.size <= MAX_TRACKED_IPS) return;
  // Drop the coldest entries first (no recent hits, not quarantined).
  for (const [ip, rec] of offenders) {
    if ((rec.quarantinedUntil || 0) < now && !(rec.hits || []).some((t) => now - t < OFFENCE_WINDOW_MS)) {
      offenders.delete(ip);
      if (offenders.size <= MAX_TRACKED_IPS) break;
    }
  }
}

// Record an offence for an IP. Returns true once the IP crosses into quarantine.
export function registerThreat(ip, now = Date.now()) {
  if (!ip) return false;
  let rec = offenders.get(ip);
  if (!rec) { rec = { hits: [], quarantinedUntil: 0, total: 0 }; offenders.set(ip, rec); }
  rec.hits = rec.hits.filter((t) => now - t < OFFENCE_WINDOW_MS);
  rec.hits.push(now);
  rec.total += 1;
  if (rec.hits.length >= OFFENCE_THRESHOLD) {
    rec.quarantinedUntil = now + QUARANTINE_MS;
    rec.hits = []; // reset the window; the quarantine now governs
    pruneOffenders(now);
    return true;
  }
  pruneOffenders(now);
  return false;
}

// Is this IP currently quarantined? (Expired quarantines self-clear.)
export function isThreatBlocked(ip, now = Date.now()) {
  if (!ip) return false;
  const rec = offenders.get(ip);
  if (!rec) return false;
  if ((rec.quarantinedUntil || 0) > now) return true;
  return false;
}

// Snapshot for the Security Agent / admin dashboard.
export function threatStats(now = Date.now()) {
  let quarantined = 0;
  let totalOffences = 0;
  for (const rec of offenders.values()) {
    if ((rec.quarantinedUntil || 0) > now) quarantined += 1;
    totalOffences += rec.total || 0;
  }
  return { trackedIps: offenders.size, quarantined, totalOffences };
}

// Test/ops hook — wipe the ledger.
export function resetThreatShield() { offenders.clear(); }

// ---- The inspector --------------------------------------------------------

// Inspect a request. Returns { block: false } for anything that looks like real
// traffic, or { block: true, reason, code, severity } for an attack signature.
// Pure and side-effect-free (offence tracking is the caller's job) so it is
// trivially testable.
export function inspectRequest(req) {
  const path = String(req?.path || req?.url || '');
  const ua = String(req?.headers?.['user-agent'] || '').toLowerCase();
  const method = String(req?.method || 'GET').toUpperCase();

  // 1. Attack-tool User-Agent — highest confidence, block outright.
  for (const sig of BAD_USER_AGENTS) {
    if (ua.includes(sig)) {
      return { block: true, code: 'scanner-ua', reason: `attack-tool user-agent (${sig})`, severity: 'high' };
    }
  }

  // 2. Path probe for files/routes that don't exist here.
  for (const rx of BAD_PATH_PATTERNS) {
    if (rx.test(path)) {
      return { block: true, code: 'path-probe', reason: `probe for non-existent sensitive path`, severity: 'high' };
    }
  }

  // 3. Structural injection in the JSON body shape (mutating methods only —
  //    GETs carry no JSON body, and we never inspect free-text VALUES).
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && req?.body && typeof req.body === 'object') {
    const badKey = scanKeys(req.body);
    if (badKey) {
      return { block: true, code: 'injection-key', reason: `injection/pollution operator in payload (${badKey})`, severity: 'high' };
    }
  }

  return { block: false };
}

// Config surface (mostly for tests / introspection).
export const THREAT_CONFIG = {
  OFFENCE_WINDOW_MS, QUARANTINE_MS, OFFENCE_THRESHOLD, MAX_TRACKED_IPS,
  scannerSignatures: BAD_USER_AGENTS.length, pathPatterns: BAD_PATH_PATTERNS.length,
  injectionKeys: DANGEROUS_KEYS.size,
};
