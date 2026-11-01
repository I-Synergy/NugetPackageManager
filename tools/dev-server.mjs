/**
 * Development server for the NuGet Package Manager for Visual Studio Code UI.
 *
 * Serves the webview bundle with mock data so the UI can be iterated on
 * in a regular browser without a VS Code workspace or dotnet CLI.
 *
 * Project/package references are mocked. All NuGet package data (search,
 * versions, updates, vulnerabilities) is fetched live from nuget.org.
 *
 * Usage: npm run dev
 *   → opens http://localhost:3729 in the default browser
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { exec } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT_DIR = join(__dirname, '..');
const TOOLS_DIR = __dirname;
const DIST_DIR = join(ROOT_DIR, 'dist');

const PORT = 3729;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':  'font/ttf',
};

// ── NuGet service URL cache (keyed by index URL) ──────────────────────────────

const _serviceCache = new Map();

async function getNugetServices(indexUrl = 'https://api.nuget.org/v3/index.json') {
  if (_serviceCache.has(indexUrl)) return _serviceCache.get(indexUrl);

  console.log(`[nuget-proxy] Resolving service URLs from ${indexUrl}`);
  const res = await fetch(indexUrl);
  const data = await res.json();
  const resources = data.resources || [];

  const findUrl = (type) => {
    const matches = resources
      .filter(r => r['@type'].includes(type))
      .sort((a, b) => b['@type'].localeCompare(a['@type']));
    return matches[0]?.['@id'] || '';
  };

  const services = {
    search: findUrl('SearchQueryService'),
    registration: findUrl('RegistrationsBaseUrl'),
    vulnerability: findUrl('VulnerabilityInfo'),
  };
  _serviceCache.set(indexUrl, services);
  return services;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchRegistrationItems(registrationBaseUrl, pkgId) {
  const url = `${registrationBaseUrl}${pkgId.toLowerCase()}/index.json`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  const pages = await Promise.all((data.items || []).map(async (page) => {
    if (page.items) return page.items;
    const pageRes = await fetch(page['@id']);
    const pageData = await pageRes.json();
    return pageData.items || [];
  }));
  return pages.flat();
}

function parseVersion(v) {
  // Returns { parts: number[], pre: string|null }
  // e.g. "1.2.3-alpha.1" → { parts: [1,2,3], pre: "alpha.1" }
  const [numeric, ...preParts] = (v || '').split('-');
  const pre = preParts.length > 0 ? preParts.join('-') : null;
  const parts = (numeric || '').split('.').map(n => Number.parseInt(n, 10) || 0);
  return { parts, pre };
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  // Compare numeric parts first
  for (let i = 0; i < Math.max(pa.parts.length, pb.parts.length); i++) {
    const diff = (pa.parts[i] || 0) - (pb.parts[i] || 0);
    if (diff !== 0) return diff;
  }
  // Per semver: release > prerelease (null > non-null)
  if (pa.pre === null && pb.pre !== null) return 1;
  if (pa.pre !== null && pb.pre === null) return -1;
  if (pa.pre !== null && pb.pre !== null) return pa.pre.localeCompare(pb.pre);
  return 0;
}

function isVersionInRange(version, range) {
  if (!range) return false;
  const open = range[0];
  const close = range[range.length - 1];
  if (!isRangeBracket(open, close)) return false;

  const inner = range.slice(1, -1).trim();
  const comma = inner.indexOf(',');
  if (comma === -1) {
    // Exact version: [1.2.3]
    return open === '[' && close === ']' && compareVersions(version, inner) === 0;
  }

  return satisfiesMin(version, inner.slice(0, comma).trim(), open)
    && satisfiesMax(version, inner.slice(comma + 1).trim(), close);
}

function isRangeBracket(open, close) {
  return (open === '[' || open === '(') && (close === ']' || close === ')');
}

function satisfiesMin(version, minVersion, open) {
  if (!minVersion) return true;
  const cmp = compareVersions(version, minVersion);
  return open === '[' ? cmp >= 0 : cmp > 0;
}

function satisfiesMax(version, maxVersion, close) {
  if (!maxVersion) return true;
  const cmp = compareVersions(version, maxVersion);
  return close === ']' ? cmp <= 0 : cmp < 0;
}

function mapSearchItem(item) {
  return {
    Id: item['@id'] || '',
    Name: item.id || '',
    Authors: item.authors || [],
    Description: item.description || '',
    IconUrl: item.iconUrl || '',
    Registration: item.registration || '',
    LicenseUrl: item.licenseUrl || '',
    ProjectUrl: item.projectUrl || '',
    TotalDownloads: item.totalDownloads || 0,
    Verified: item.verified || false,
    Version: item.version || '',
    InstalledVersion: '',
    Versions: (item.versions || []).map(v => ({ Version: v.version, Id: v['@id'] })),
    Tags: item.tags || [],
  };
}

function mapCatalogEntry(item, allItems) {
  const ce = typeof item.catalogEntry === 'object' ? item.catalogEntry : {};
  return {
    Id: item['@id'] || '',
    Name: ce.id || '',
    Authors: typeof ce.authors === 'string' ? [ce.authors] : (ce.authors || []),
    Description: ce.description || '',
    IconUrl: ce.iconUrl || '',
    Registration: ce.registration || '',
    LicenseUrl: ce.licenseUrl || '',
    ProjectUrl: ce.projectUrl || '',
    TotalDownloads: ce.totalDownloads || 0,
    Verified: ce.verified || false,
    Version: ce.version || '',
    InstalledVersion: '',
    Versions: (allItems || [item]).map(v => ({
      Version: (typeof v.catalogEntry === 'object' ? v.catalogEntry.version : '') || '',
      Id: v['@id'] || '',
    })),
    Tags: ce.tags || [],
  };
}

// ── NuGet source URL validation ───────────────────────────────────────────────

/** Exact hostnames that are permitted as NuGet feed origins. */
const ALLOWED_NUGET_HOSTS = new Set([
  'api.nuget.org',
  'www.nuget.org',
  'nuget.org',
  'pkgs.dev.azure.com',
]);

/**
 * Suffix-based allowlist for feeds that use tenant/org sub-domains
 * (e.g. mycompany.myget.org, mycompany.pkgs.visualstudio.com).
 */
const ALLOWED_NUGET_HOST_SUFFIXES = [
  '.nuget.org',
  '.myget.org',
  '.pkgs.visualstudio.com',
];

/**
 * Validates that a NuGet source URL uses HTTPS and targets a host that is in
 * the explicit allowlist.  Throws a descriptive Error if validation fails so
 * the caller can surface a clean message rather than silently proxying an
 * arbitrary internal URL.
 *
 * @param {string} raw - The URL string to validate.
 * @returns {string} The normalised URL string (from `new URL()`).
 */
function validateNugetSourceUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid NuGet source URL: ${raw}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`NuGet source URL must use HTTPS (got "${parsed.protocol}"): ${raw}`);
  }

  const host = parsed.hostname.toLowerCase();
  // Use both an exact-match check and an anchored suffix check.
  // The suffix check verifies that the suffix is either the full hostname
  // (e.g. "nuget.org" against ".nuget.org") or is immediately preceded by a
  // dot, preventing bypasses like "evilnuget.org" matching ".nuget.org".
  const allowed =
    ALLOWED_NUGET_HOSTS.has(host) ||
    ALLOWED_NUGET_HOST_SUFFIXES.some(
      suffix => host === suffix.slice(1) || host.endsWith(suffix),
    );

  if (!allowed) {
    const permittedSuffixes = ALLOWED_NUGET_HOST_SUFFIXES.map(s => `*${s}`).join(' / ');
    throw new Error(
      `NuGet source host "${parsed.hostname}" is not in the allowed-host list. ` +
      `Permitted hosts: ${[...ALLOWED_NUGET_HOSTS].join(', ')} and ${permittedSuffixes}`,
    );
  }

  return parsed.toString();
}

// ── NuGet RPC proxy ───────────────────────────────────────────────────────────

function selectPrerelease(items, prerelease) {
  if (prerelease) return items;
  const filtered = items.filter(v => {
    const ce = typeof v.catalogEntry === 'object' ? v.catalogEntry : null;
    return !ce?.version?.includes('-');
  });
  return filtered.length > 0 ? filtered : items;
}

async function proxyGetPackagesAsync(services, params) {
  const searchBase = services.search.endsWith('/') ? services.search.slice(0, -1) : services.search;
  const searchUrl = new URL(searchBase);
  searchUrl.searchParams.set('q', params.Filter || '');
  searchUrl.searchParams.set('take', String(params.Take ?? 20));
  searchUrl.searchParams.set('skip', String(params.Skip ?? 0));
  searchUrl.searchParams.set('prerelease', String(params.Prerelease ?? false));
  searchUrl.searchParams.set('semVerLevel', '2.0.0');
  const res = await fetch(searchUrl.toString());
  const data = await res.json();
  return { ok: true, value: { Packages: sortPackages((data.data || []).map(mapSearchItem), params.Sort) } };
}

/**
 * The host sorts results after the feed answers (`sortPackages` in host-api.ts); the dev proxy
 * has to do the same, otherwise "Sort by" looks inert in the browser.
 */
function sortPackages(packages, sort) {
  if (sort === 'downloads') {
    return packages.sort((left, right) => (right.TotalDownloads ?? 0) - (left.TotalDownloads ?? 0));
  }
  if (sort === 'name-asc') {
    return packages.sort((left, right) => String(left.Name).localeCompare(String(right.Name)));
  }
  return packages;
}

async function proxyGetPackageAsync(services, params, sourceUrl) {
  const items = await fetchRegistrationItems(services.registration, params.Id);
  if (!items.length) return { ok: false, error: `Package ${params.Id} not found` };
  const toUse = selectPrerelease(items, params.Prerelease);
  return { ok: true, value: { Package: mapCatalogEntry(toUse.at(-1), toUse), SourceUrl: sourceUrl } };
}

async function proxyGetPackageDetailsAsync(_services, params) {
  const empty = { ok: true, value: { Package: { dependencies: { frameworks: {} } } } };
  const pvUrl = params.PackageVersionUrl;
  if (!pvUrl) return empty;

  const pvRes = await fetch(pvUrl);
  if (!pvRes.ok) return empty;
  const pvData = await pvRes.json();

  let catalogData;
  const ce = pvData.catalogEntry;
  if (typeof ce === 'object' && ce !== null && Array.isArray(ce.dependencyGroups)) {
    catalogData = ce;
  } else {
    const catalogUrl = typeof ce === 'string' ? ce : ce?.['@id'];
    if (!catalogUrl) return empty;
    const catRes = await fetch(catalogUrl);
    catalogData = await catRes.json();
  }

  const frameworks = {};
  for (const group of catalogData?.dependencyGroups || []) {
    const deps = (group.dependencies || []).map(d => ({ package: d.id, versionRange: d.range }));
    if (deps.length > 0) frameworks[group.targetFramework] = deps;
  }
  return { ok: true, value: { Package: { dependencies: { frameworks } } } };
}

async function proxyGetOutdatedPackagesAsync(services, params, sourceUrl) {
  const installed = params._installedPackages || [];
  const outdated = [];

  await Promise.all(installed.map(async ({ id, version, projects }) => {
    try {
      const items = await fetchRegistrationItems(services.registration, id);
      if (!items.length) return;
      const toUse = selectPrerelease(items, params.Prerelease);
      const lastEntry = toUse.at(-1);
      const latestVersion = (typeof lastEntry.catalogEntry === 'object' ? lastEntry.catalogEntry.version : '') || '';
      if (latestVersion && compareVersions(latestVersion, version) > 0) {
        outdated.push({ Id: id, InstalledVersion: version, LatestVersion: latestVersion, Projects: projects, SourceUrl: sourceUrl, SourceName: 'nuget.org' });
      }
    } catch (e) {
      console.warn(`[nuget-proxy] getOutdatedPackagesAsync: failed for ${id}:`, e.message);
    }
  }));

  return { ok: true, value: { Packages: outdated } };
}

async function proxyGetVulnerablePackagesAsync(services, params) {
  const installed = params._installedPackages || [];
  if (!services.vulnerability || !installed.length) return { ok: true, value: { Packages: [] } };

  const vulnRes = await fetch(services.vulnerability);
  if (!vulnRes.ok) return { ok: true, value: { Packages: [] } };
  const vulnIndex = await vulnRes.json();

  const vulnMap = {};
  await Promise.all(vulnIndex.map(async page => {
    try {
      const pageRes = await fetch(page['@id']);
      const pageData = await pageRes.json();
      for (const [pkgId, entries] of Object.entries(pageData)) {
        vulnMap[pkgId.toLowerCase()] = entries;
      }
    } catch (e) {
      console.warn('[nuget-proxy] getVulnerablePackagesAsync: failed to fetch page:', e.message);
    }
  }));

  const vulnerable = [];
  for (const { id, version, projects } of installed) {
    const entries = vulnMap[id.toLowerCase()];
    if (!entries) continue;
    for (const entry of entries) {
      if (isVersionInRange(version, entry.versions)) {
        vulnerable.push({ Id: id, InstalledVersion: version, Severity: entry.severity, AdvisoryUrl: entry.advisoryUrl, AffectedVersionRange: entry.versions, Projects: projects });
        break;
      }
    }
  }
  return { ok: true, value: { Packages: vulnerable } };
}

const NUGET_PROXY_HANDLERS = {
  getPackagesAsync: proxyGetPackagesAsync,
  getPackageAsync: proxyGetPackageAsync,
  getPackageDetailsAsync: proxyGetPackageDetailsAsync,
  getOutdatedPackagesAsync: proxyGetOutdatedPackagesAsync,
  getVulnerablePackagesAsync: proxyGetVulnerablePackagesAsync,
};

async function handleNugetProxy(method, params) {
  const rawUrl = params?.Url || 'https://api.nuget.org/v3/index.json';
  const sourceUrl = validateNugetSourceUrl(rawUrl);
  const services = await getNugetServices(sourceUrl);
  const handler = NUGET_PROXY_HANDLERS[method];
  if (!handler) return { ok: false, error: `Unknown NuGet proxy method: ${method}` };
  return handler(services, params, sourceUrl);
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // NuGet proxy endpoint
  if (req.method === 'POST' && url === '/nuget-proxy') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { method, params } = JSON.parse(body);
        console.log(`[nuget-proxy] → ${method}`);
        const result = await handleNugetProxy(method, params);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('[nuget-proxy] Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // Static file serving
  let filePath;
  if (url.startsWith('/dist/')) {
    filePath = join(DIST_DIR, url.slice('/dist/'.length));
  } else if (url === '/' || url === '/index.html') {
    filePath = join(TOOLS_DIR, 'index.html');
  } else {
    filePath = join(TOOLS_DIR, url.slice(1));
  }

  try {
    const data = await readFile(filePath);
    const mime = MIME_TYPES[extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found: ' + url);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\nDev server running at ${url}\n`);

  let cmd;
  if (process.platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else if (process.platform === 'darwin') {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd);

  console.log('Press Ctrl+C to stop.\n');
});
