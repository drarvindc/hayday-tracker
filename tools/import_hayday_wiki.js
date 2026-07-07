#!/usr/bin/env node
/**
 * Hay Day product importer.
 *
 * Default behavior:
 *   - scrape the live Hay Day Wiki/Fandom data
 *   - fail loudly if the import is incomplete or suspicious
 *   - write a browser-loadable data file plus an import report
 *
 * Development fallback:
 *   - pass --allow-sample to allow the bundled sample data when the real
 *     import cannot be completed
 *
 * Usage:
 *   node tools/import_hayday_wiki.js
 *   node tools/import_hayday_wiki.js --download-images
 *   node tools/import_hayday_wiki.js --allow-sample
 *   node tools/import_hayday_wiki.js --limit 10
 */

const fs = require('fs/promises');
const path = require('path');
const cheerio = require('cheerio');

const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'hayday_product_data.js');
const REPORT_FILE = path.join(ROOT, 'data', 'hayday_import_report.json');
const IMAGES_DIR = path.join(ROOT, 'images', 'items');

const DEFAULT_BASE_URL = 'https://hayday.fandom.com';
const GOODS_LIST_URL = `${DEFAULT_BASE_URL}/wiki/Goods_List`;
const PRODUCTS_URL = `${DEFAULT_BASE_URL}/wiki/Products`;
const CATEGORY_URLS = [
  `${DEFAULT_BASE_URL}/wiki/Category:Products`,
  `${DEFAULT_BASE_URL}/wiki/Category:Animal_goods`,
  `${DEFAULT_BASE_URL}/wiki/Category:Crops`,
  `${DEFAULT_BASE_URL}/wiki/Category:Trees_and_Bushes`
];

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) HayDayTrackerImporter/2.0';
const MAX_CONCURRENCY = 6;

const args = process.argv.slice(2);
const DOWNLOAD_IMAGES = args.includes('--download-images') || process.env.HAYDAY_DOWNLOAD_IMAGES === '1';
const ALLOW_SAMPLE = args.includes('--allow-sample') || process.env.HAYDAY_ALLOW_SAMPLE === '1';
const LIMIT = parseLimit(args);

function parseLimit(argv) {
  const index = argv.indexOf('--limit');
  if (index === -1) return null;
  const value = Number(argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/['’â€™]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function cleanText(value) {
  return normalizeWhitespace(String(value || '').replace(/\u00a0/g, ' '));
}

function isMainspaceWikiLink(href) {
  if (!href) return false;
  const pathPart = String(href).replace(/^https?:\/\/[^/]+/i, '');
  if (!/^\/wiki\//i.test(pathPart)) return false;
  if (/^\/wiki\/(?:File|Category|Help|Special|Template|Module|Talk):/i.test(pathPart)) return false;
  if (/^\/wiki\/Main_Page$/i.test(pathPart)) return false;
  return true;
}

function absoluteWikiUrl(href) {
  if (!href) return '';
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('//')) return `https:${href}`;
  if (href.startsWith('/')) return `${DEFAULT_BASE_URL}${href}`;
  return `${DEFAULT_BASE_URL}/wiki/${href.replace(/^\/?wiki\//i, '')}`;
}

function titleFromWikiUrl(url) {
  try {
    const parsed = new URL(url, DEFAULT_BASE_URL);
    const match = parsed.pathname.match(/\/wiki\/(.+)$/i);
    if (!match) return '';
    return decodeURIComponent(match[1]).replace(/_/g, ' ');
  } catch {
    return '';
  }
}

function makeWikiUrlFromTitle(title) {
  return `${DEFAULT_BASE_URL}/wiki/${encodeURIComponent(String(title || '').replace(/\s+/g, '_'))}`;
}

function stripFileNameQuery(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return String(url || '');
  }
}

function parseFirstInt(text) {
  const match = String(text || '').match(/-?\d+/);
  return match ? Number(match[0]) : null;
}

function parseLastInt(text) {
  const matches = String(text || '').match(/-?\d+/g);
  if (!matches || !matches.length) return null;
  return Number(matches[matches.length - 1]);
}

function parseDurationToMinutes(raw) {
  const text = cleanText(raw).toLowerCase();
  if (!text) return null;

  let total = 0;
  const hourMatch = text.match(/(\d+)\s*h(?:ours?)?/i);
  const minuteMatch = text.match(/(\d+)\s*m(?:in(?:ute)?s?)?/i);

  if (hourMatch) {
    total += Number(hourMatch[1]) * 60;
  }
  if (minuteMatch) {
    total += Number(minuteMatch[1]);
  } else if (!hourMatch) {
    const bareMinutes = text.match(/^\d+$/);
    if (bareMinutes) {
      total += Number(bareMinutes[0]);
    }
  }

  return total > 0 ? total : null;
}

function extractDurations(text) {
  const cleaned = cleanText(String(text || ''))
    .replace(/[★☆]/g, ' ')
    .replace(/\[[^\]]+\]/g, ' ');

  const durations = cleaned.match(/(?:\d+\s*h(?:\s*\d+\s*m(?:in(?:ute)?s?)?)?|\d+\s*m(?:in(?:ute)?s?)?)/gi) || [];
  return durations
    .map(parseDurationToMinutes)
    .filter((value) => Number.isFinite(value));
}

function parseIngredients(text) {
  const cleaned = cleanText(String(text || ''))
    .replace(/[•·|]/g, ' ')
    .replace(/\[[^\]]+\]/g, ' ');

  if (!cleaned || /^(?:n\/?a|none|unknown|-|—)$/i.test(cleaned)) {
    return [];
  }

  const ingredients = [];
  const seen = new Set();
  const pattern = /([A-Za-z][A-Za-z0-9'’&\-\s]+?)\s*(?:\((\d+)\)|x\s*(\d+)|×\s*(\d+))/g;
  let match;
  while ((match = pattern.exec(cleaned)) !== null) {
    const name = cleanText(match[1]);
    const qty = Number(match[2] || match[3] || match[4] || 0);
    if (!name || !qty) continue;
    const itemId = slugify(name);
    const key = `${itemId}:${qty}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ingredients.push({
      itemId,
      name,
      qty
    });
  }

  return ingredients;
}

function inferType(source, ingredients, name) {
  const sourceText = String(source || '').toLowerCase();
  const nameText = String(name || '').toLowerCase();

  if (Array.isArray(ingredients) && ingredients.length) return 'product';
  if (/field|crop|tree|bush|garden/.test(sourceText)) return 'crop';
  if (/chicken|cow|duck|goat|pig|sheep|rabbit|bee|horse|donkey|lobster|cat|dog|fish/.test(sourceText)) return 'animal_good';
  if (/mine|smelter|foundry|mill|oven|maker|machine|loom|workshop|barbecue|bakery|dairy|jam|sauce|tea|juice|kebab|pastry/.test(sourceText)) return 'product';
  if (/feed|sugar|salt|flour|bread|cake|pie|dessert|drink|soup|soup|yogurt|cheese/.test(nameText)) return 'product';
  return 'product';
}

function isAcceptableImageUrl(url) {
  if (!url) return false;
  const normalized = String(url);
  if (/sprite|placeholder|blank|avatar|icon/i.test(normalized)) return false;
  if (/^data:/i.test(normalized)) return false;
  return true;
}

function normalizeImageUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return stripFileNameQuery(url);
  if (url.startsWith('//')) return stripFileNameQuery(`https:${url}`);
  return stripFileNameQuery(absoluteWikiUrl(url));
}

function extensionFromUrl(url, contentType) {
  try {
    const parsed = new URL(url);
    const ext = path.extname(parsed.pathname).toLowerCase();
    if (ext && ext.length <= 5) {
      if (ext === '.jpeg') return '.jpg';
      return ext;
    }
  } catch {
    // ignore
  }

  const type = String(contentType || '').toLowerCase();
  if (type.includes('image/png')) return '.png';
  if (type.includes('image/jpeg')) return '.jpg';
  if (type.includes('image/webp')) return '.webp';
  if (type.includes('image/gif')) return '.gif';
  if (type.includes('image/svg+xml')) return '.svg';
  return '.png';
}

function formatNumber(value, decimals) {
  if (!Number.isFinite(value)) return '-';
  const places = Number.isFinite(decimals) ? decimals : 1;
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: places,
    minimumFractionDigits: places
  }).format(value);
}

function formatCoins(value) {
  if (!Number.isFinite(value)) return '-';
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

function formatMinutes(value) {
  if (!Number.isFinite(value)) return 'Unknown';
  const total = Math.round(value);
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${hours}h${minutes ? ` ${minutes}m` : ''}`;
}

function formatOtherIngredients(ingredients) {
  if (!Array.isArray(ingredients) || !ingredients.length) return 'None';
  return ingredients.map((ingredient) => `${ingredient.name} x ${ingredient.qty}`).join(', ');
}

function makeFallbackArt(name, source) {
  const hash = Math.abs(Array.from(String(name || '')).reduce((value, char) => {
    return ((value << 5) - value) + char.charCodeAt(0);
  }, 0));
  const hue = hash % 360;
  const hue2 = (hue + 38) % 360;
  const initials = String(name || '')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase() || '?';
  const shortSource = String(source || '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .join(' ')
    .toUpperCase();

  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320">',
    '<defs>',
    `<linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">`,
    `<stop offset="0%" stop-color="hsl(${hue}, 72%, 42%)"/>`,
    `<stop offset="100%" stop-color="hsl(${hue2}, 72%, 56%)"/>`,
    '</linearGradient>',
    '</defs>',
    '<rect width="320" height="320" rx="52" fill="url(#g)"/>',
    '<circle cx="242" cy="72" r="62" fill="rgba(255,255,255,0.16)"/>',
    '<circle cx="92" cy="250" r="72" fill="rgba(255,255,255,0.10)"/>',
    '<rect x="56" y="58" width="208" height="204" rx="40" fill="rgba(255,255,255,0.16)" stroke="rgba(255,255,255,0.26)"/>',
    `<text x="160" y="155" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="78" font-weight="800" fill="#ffffff">${escapeXml(initials)}</text>`,
    `<text x="160" y="206" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="700" fill="rgba(255,255,255,0.9)">${escapeXml(shortSource || 'HAY DAY')}</text>`,
    '</svg>'
  ].join('');

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function pageTitleFromAnchor(anchor) {
  const href = anchor && anchor.attribs ? anchor.attribs.href : '';
  if (!href || !isMainspaceWikiLink(href)) return '';
  return cleanText(decodeURIComponent(href.replace(/^\/wiki\//i, '')).replace(/_/g, ' '));
}

function parseWikiTableCandidate($, tableEl) {
  const $table = $(tableEl);
  const headerCells = $table.find('tr').first().find('th,td').toArray();
  const headerText = headerCells.map((cell) => cleanText($(cell).text()).toLowerCase()).join(' ');
  const score =
    (headerText.includes('name') ? 1 : 0) +
    (headerText.includes('level') ? 1 : 0) +
    (headerText.includes('max') && headerText.includes('price') ? 1 : 0) +
    (headerText.includes('time') ? 1 : 0) +
    (headerText.includes('xp') ? 1 : 0) +
    (headerText.includes('needs') ? 1 : 0) +
    (headerText.includes('source') ? 1 : 0);

  return { $table, score };
}

function findBestGoodsTable($) {
  let best = null;

  $('table').each((_, tableEl) => {
    const candidate = parseWikiTableCandidate($, tableEl);
    const rowCount = candidate.$table.find('tr').length;
    const totalScore = candidate.score * 1000 + rowCount;
    if (!best || totalScore > best.totalScore) {
      best = { ...candidate, totalScore };
    }
  });

  return best && best.score >= 4 ? best.$table : null;
}

function extractImageFromHtml($, candidate) {
  const selectors = [
    'meta[property="og:image"]',
    'meta[property="og:image:secure_url"]',
    'link[rel="image_src"]'
  ];

  for (const selector of selectors) {
    const value = $(selector).first().attr('content') || $(selector).first().attr('href');
    const normalized = normalizeImageUrl(value);
    if (isAcceptableImageUrl(normalized)) return normalized;
  }

  const imageNodes = [
    '.portable-infobox .pi-image img',
    '.portable-infobox img',
    '#mw-content-text img',
    'img'
  ];

  for (const selector of imageNodes) {
    const images = $(selector).toArray();
    for (const node of images) {
      const $node = $(node);
      const src = normalizeImageUrl($node.attr('data-src') || $node.attr('src') || $node.attr('data-lazy-src'));
      if (!isAcceptableImageUrl(src)) continue;
      const alt = cleanText($node.attr('alt'));
      const width = Number($node.attr('width') || $node.attr('data-width') || 0);
      if (alt && candidate && candidate.name && alt.toLowerCase() !== candidate.name.toLowerCase()) {
        // Still valid, just lower priority.
      }
      if (width && width < 64) continue;
      return src;
    }
  }

  return '';
}

function extractPageImageViaApi(htmlOrNull, pageTitle) {
  return pageTitle ? `${DEFAULT_BASE_URL}/api.php?action=query&prop=pageimages&piprop=original&titles=${encodeURIComponent(pageTitle)}&format=json&formatversion=2` : '';
}

async function fetchText(url, { accept = 'text/html,application/xhtml+xml', retry = 2 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retry; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: accept
        }
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} while fetching ${url}`);
      }
      return {
        text: await response.text(),
        response
      };
    } catch (error) {
      lastError = error;
      if (attempt < retry) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

async function fetchJson(url, { retry = 2 } = {}) {
  const { text, response } = await fetchText(url, { accept: 'application/json,text/plain,*/*', retry });
  try {
    return {
      json: JSON.parse(text),
      response
    };
  } catch (error) {
    throw new Error(`Failed to parse JSON from ${url}: ${error.message}`);
  }
}

async function fetchBinary(url, { retry = 2 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retry; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT
        }
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} while fetching ${url}`);
      }
      return {
        bytes: Buffer.from(await response.arrayBuffer()),
        response
      };
    } catch (error) {
      lastError = error;
      if (attempt < retry) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

async function fetchParsedPage(pageTitle, { retry = 2 } = {}) {
  const apiUrl = `${DEFAULT_BASE_URL}/api.php?action=parse&page=${encodeURIComponent(String(pageTitle || '').replace(/\s+/g, '_'))}&prop=text|images&format=json`;
  const { json } = await fetchJson(apiUrl, { retry });
  const parse = json && json.parse ? json.parse : null;
  const html = parse && typeof parse.text === 'string'
    ? parse.text
    : parse && parse.text && typeof parse.text['*'] === 'string'
      ? parse.text['*']
      : '';
  if (!parse || !html) {
    throw new Error(`Unable to parse wiki page: ${pageTitle}`);
  }
  return {
    title: parse.title || pageTitle,
    html,
    images: Array.isArray(parse.images) ? parse.images : []
  };
}

async function mapLimit(items, limit, iterator) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      results[current] = await iterator(items[current], current);
    }
  }

  const workers = [];
  const workerCount = Math.min(limit, items.length);
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

function chooseTableTextCellText($, cells, startIndex) {
  const values = [];
  for (let index = startIndex; index < cells.length; index += 1) {
    const value = cleanText($(cells[index]).text());
    if (value) values.push(value);
  }
  return values;
}

function parseGoodsListRows(html, sourcePageUrl, warnings) {
  const $ = cheerio.load(html);
  const candidates = [];
  const seenIds = new Set();
  let matchedTables = 0;

  $('table').each((tableIndex, tableEl) => {
    const table = $(tableEl);
    const candidateInfo = parseWikiTableCandidate($, tableEl);
    if (candidateInfo.score < 1) return;

    matchedTables += 1;
    table.find('tr').toArray().slice(1).forEach((rowEl, rowIndex) => {
      const row = $(rowEl);
      const cells = row.find('th,td').toArray();
      if (!cells.length) return;

      const anchors = row.find('a[href^="/wiki/"]').toArray().map((anchor) => ({
        href: absoluteWikiUrl($(anchor).attr('href')),
        text: cleanText($(anchor).text()),
        title: cleanText($(anchor).attr('title'))
      }));

      const mainAnchor = anchors.find((link) => isMainspaceWikiLink(link.href) && !/^image/i.test(link.text) && !/^file/i.test(link.text));
      if (!mainAnchor) return;

      const pageTitle = titleFromWikiUrl(mainAnchor.href);
      const name = cleanText(mainAnchor.text || pageTitle);
      const id = slugify(name || pageTitle);
      if (!id || seenIds.has(id)) return;

      const mainCellIndex = cells.findIndex((cell) => {
        const linksInCell = $(cell).find('a[href^="/wiki/"]').toArray();
        return linksInCell.some((linkEl) => absoluteWikiUrl($(linkEl).attr('href')) === mainAnchor.href);
      });
      const after = chooseTableTextCellText($, cells, Math.max(mainCellIndex + 1, 0));
      if (!after.length || !after.some((cell) => /\d/.test(cell))) return;

      const level = parseFirstInt(after[0]);
      const maxPrice = parseLastInt(after[1]);
      const durations = extractDurations(after[2]);
      const xp = parseFirstInt(after[3]);
      const needsText = after[4] || '';
      const source = after[5] || '';
      const ingredients = parseIngredients(needsText);
      const rowImage = normalizeImageUrl(
        $(rowEl).find('img').first().attr('data-src') ||
        $(rowEl).find('img').first().attr('src') ||
        ''
      );

      const candidate = {
        id,
        name,
        type: inferType(source, ingredients, name),
        level: Number.isFinite(level) ? level : null,
        source,
        productionTimeMin: durations.length ? durations[0] : null,
        masteredTimeMin: durations.length > 1 ? durations[1] : null,
        xp: Number.isFinite(xp) ? xp : null,
        maxPrice: Number.isFinite(maxPrice) ? maxPrice : null,
        ingredients,
        image: rowImage,
        wikiUrl: mainAnchor.href,
        sourceUrl: sourcePageUrl,
        _sourceTableIndex: tableIndex,
        _sourceRowIndex: rowIndex
      };

      candidates.push(candidate);
      seenIds.add(id);
    });
  });

  if (!candidates.length) {
    throw new Error('Could not find any goods rows on the page.');
  }

  if (candidates.length < 200) {
    warnings.push(`Goods List parsing returned only ${candidates.length} rows across ${matchedTables} tables.`);
  }

  return candidates;
}

async function fetchCategoryMembers(categoryTitle, report) {
  const members = [];
  let continueToken = '';

  try {
    do {
      const url = `${DEFAULT_BASE_URL}/api.php?action=query&list=categorymembers&cmtitle=${encodeURIComponent(categoryTitle)}&cmtype=page&cmlimit=500&format=json${continueToken ? `&cmcontinue=${encodeURIComponent(continueToken)}` : ''}`;
      const { json } = await fetchJson(url);
      const query = json && json.query ? json.query : null;
      const batch = query && Array.isArray(query.categorymembers) ? query.categorymembers : [];
      batch.forEach((member) => {
        if (!member || !member.title) return;
        if (member.ns !== 0) return;
        members.push({
          title: member.title,
          href: makeWikiUrlFromTitle(member.title)
        });
      });
      continueToken = json && json.continue && json.continue.cmcontinue ? json.continue.cmcontinue : '';
    } while (continueToken);

    report.sourcePages.push({
      label: categoryTitle,
      url: `${DEFAULT_BASE_URL}/wiki/${encodeURIComponent(categoryTitle.replace(/^Category:/i, 'Category:').replace(/ /g, '_'))}`,
      count: members.length,
      kind: 'categorymembers'
    });
  } catch (error) {
    report.parseWarnings.push(`Category lookup skipped for ${categoryTitle}: ${error.message}`);
  }

  return members;
}

async function fetchPageImageMap(titles) {
  const result = new Map();
  const batches = [];
  for (let i = 0; i < titles.length; i += 50) {
    batches.push(titles.slice(i, i + 50));
  }

  for (const batch of batches) {
    const url = `${DEFAULT_BASE_URL}/api.php?action=query&prop=pageimages&piprop=original&titles=${encodeURIComponent(batch.join('|'))}&format=json&formatversion=2`;
    const { json } = await fetchJson(url);
    const pages = json && json.query && Array.isArray(json.query.pages) ? json.query.pages : [];
    pages.forEach((page) => {
      if (!page || !page.title) return;
      const original = page.original && page.original.source ? page.original.source : '';
      if (original && isAcceptableImageUrl(original)) {
        result.set(page.title, normalizeImageUrl(original));
      }
    });
  }

  return result;
}

function mergeCandidates(existing, incoming) {
  if (!existing) return { ...incoming };
  const merged = { ...existing };
  const preferIncoming = (key) => {
    if (incoming[key] == null || incoming[key] === '') return;
    if (merged[key] == null || merged[key] === '') {
      merged[key] = incoming[key];
    }
  };

  preferIncoming('name');
  preferIncoming('type');
  preferIncoming('level');
  preferIncoming('source');
  preferIncoming('productionTimeMin');
  preferIncoming('masteredTimeMin');
  preferIncoming('xp');
  preferIncoming('maxPrice');
  preferIncoming('image');
  preferIncoming('wikiUrl');
  preferIncoming('sourceUrl');

  if ((!Array.isArray(merged.ingredients) || !merged.ingredients.length) && Array.isArray(incoming.ingredients) && incoming.ingredients.length) {
    merged.ingredients = incoming.ingredients.slice();
  }

  if (typeof existing._sourceRowIndex === 'number' && typeof incoming._sourceRowIndex === 'number') {
    merged._sourceRowIndex = Math.min(existing._sourceRowIndex, incoming._sourceRowIndex);
  } else if (typeof incoming._sourceRowIndex === 'number') {
    merged._sourceRowIndex = incoming._sourceRowIndex;
  }

  return merged;
}

function inferImageFromPage(candidate, html) {
  const $ = cheerio.load(html);
  const image = extractImageFromHtml($, candidate);
  if (isAcceptableImageUrl(image)) return image;
  return '';
}

async function enrichCandidate(candidate, report) {
  const pageTitle = titleFromWikiUrl(candidate.wikiUrl) || candidate.name;
  let html = '';
  let pageImage = '';

  try {
    const response = await fetchParsedPage(pageTitle || candidate.name, { retry: 2 });
    html = response.html;
    report.itemsFetchedCount += 1;
  } catch (error) {
    report.parseWarnings.push(`Page fetch failed for ${candidate.name}: ${error.message}`);
  }

  if (html) {
    const $ = cheerio.load(html);
    const pageName = cleanText($('#firstHeading').text()) || candidate.name;
    const pageText = cleanText($('#mw-content-text').text());

    candidate.name = pageName || candidate.name;
    candidate.id = slugify(candidate.name || candidate.id);

    if (candidate.level == null) {
      const levelMatch = pageText.match(/(?:Experience level|Exp\. lvl\(s\)|unlocked at level)\s*(\d+)/i);
      if (levelMatch) candidate.level = Number(levelMatch[1]);
    }

    if (!candidate.source) {
      const sourceMatch = pageText.match(/(?:Source|Produced by)\s+([A-Za-z0-9'’&\-\s]+)/i);
      if (sourceMatch) candidate.source = cleanText(sourceMatch[1]);
    }

    if (candidate.productionTimeMin == null || candidate.masteredTimeMin == null) {
      const timeCandidates = extractDurations(pageText);
      if (timeCandidates.length && candidate.productionTimeMin == null) {
        candidate.productionTimeMin = timeCandidates[0];
      }
      if (timeCandidates.length > 1 && candidate.masteredTimeMin == null) {
        candidate.masteredTimeMin = timeCandidates[1];
      }
    }

    if (candidate.xp == null) {
      const xpMatch = pageText.match(/(?:XP|Exp\.)\s*(\d+)/i);
      if (xpMatch) candidate.xp = Number(xpMatch[1]);
    }

    if (candidate.maxPrice == null) {
      const priceMatch = pageText.match(/(?:max(?:imum)? price|can be bought or sold for a maximum price of)\s*([0-9]+)/i);
      if (priceMatch) candidate.maxPrice = Number(priceMatch[1]);
    }

    if (!candidate.image) {
      pageImage = await resolvePageImage(candidate, $, report);
      if (pageImage) candidate.image = pageImage;
    }

    const inferredIngredients = extractIngredientsFromPageText(pageText);
    if ((!candidate.ingredients || !candidate.ingredients.length) && inferredIngredients.length) {
      candidate.ingredients = inferredIngredients;
    }
  }

  if (!candidate.image) {
    candidate.image = makeFallbackArt(candidate.name, candidate.source);
    candidate._generatedFallback = true;
  } else if (candidate._generatedFallback == null) {
    candidate._generatedFallback = false;
  }

  candidate.type = inferType(candidate.source, candidate.ingredients, candidate.name);
  candidate.wikiUrl = candidate.wikiUrl || makeWikiUrlFromTitle(pageTitle);
  candidate.sourceUrl = candidate.sourceUrl || candidate.wikiUrl;
  candidate.id = slugify(candidate.name || candidate.id);

  return candidate;
}

function extractIngredientsFromPageText(pageText) {
  const text = normalizeWhitespace(pageText);
  const extracted = [];
  const patterns = [
    /([A-Za-z][A-Za-z0-9'’&\-\s]+?)\s+x\s*(\d+)/g,
    /([A-Za-z][A-Za-z0-9'’&\-\s]+?)\s*\((\d+)\)/g
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const name = cleanText(match[1]);
      const qty = Number(match[2]);
      if (!name || !Number.isFinite(qty)) continue;
      const itemId = slugify(name);
      if (extracted.some((entry) => entry.itemId === itemId && entry.qty === qty)) continue;
      extracted.push({ itemId, name, qty });
    }
  }

  return extracted;
}

async function resolvePageImage(candidate, $, report) {
  const title = titleFromWikiUrl(candidate.wikiUrl) || candidate.name;
  const apiUrl = extractPageImageViaApi(null, title);
  if (apiUrl) {
    try {
      const { json } = await fetchJson(apiUrl);
      const pages = json && json.query && Array.isArray(json.query.pages) ? json.query.pages : [];
      const page = pages.find((entry) => entry && entry.title === title) || pages[0];
      const original = page && page.original && page.original.source ? normalizeImageUrl(page.original.source) : '';
      if (isAcceptableImageUrl(original)) {
        return original;
      }
    } catch (error) {
      report.parseWarnings.push(`API image lookup failed for ${candidate.name}: ${error.message}`);
    }
  }

  const fallback = inferImageFromPage(candidate, $.html());
  if (isAcceptableImageUrl(fallback)) {
    return fallback;
  }

  return candidate.image || '';
}

async function downloadImage(candidate, imageUrl, report) {
  if (!imageUrl) {
    return '';
  }

  try {
    const { bytes, response } = await fetchBinary(imageUrl, { retry: 2 });
    const contentType = response.headers.get('content-type') || '';
    const ext = extensionFromUrl(imageUrl, contentType);
    await fs.mkdir(IMAGES_DIR, { recursive: true });
    const fileName = `${candidate.id}${ext}`;
    const targetPath = path.join(IMAGES_DIR, fileName);
    await fs.writeFile(targetPath, bytes);
    report.imagesDownloadedCount += 1;
    return path.posix.join('images', 'items', fileName);
  } catch (error) {
    report.imageFailures.push({
      id: candidate.id,
      name: candidate.name,
      imageUrl,
      error: error.message
    });
    report.parseWarnings.push(`Image download failed for ${candidate.name}: ${error.message}`);
    return imageUrl;
  }
}

function decorateEntry(entry, selectedId) {
  const selectedQtyUsed = Number.isFinite(entry.selectedQtyUsed) ? Number(entry.selectedQtyUsed) : 0;
  const productionTimeMin = Number.isFinite(entry.productionTimeMin) ? Number(entry.productionTimeMin) : null;
  const masteredTimeMin = Number.isFinite(entry.masteredTimeMin) ? Number(entry.masteredTimeMin) : null;
  const maxPrice = Number.isFinite(entry.maxPrice) ? Number(entry.maxPrice) : null;
  const xp = Number.isFinite(entry.xp) ? Number(entry.xp) : null;
  const otherIngredients = Array.isArray(entry.otherIngredients) ? entry.otherIngredients : [];
  const coinsPerMinute = productionTimeMin && maxPrice ? maxPrice / productionTimeMin : null;
  const coinsPerSelectedItem = selectedQtyUsed > 0 && maxPrice ? maxPrice / selectedQtyUsed : null;
  return {
    productId: entry.productId,
    productName: entry.productName,
    selectedQtyUsed,
    otherIngredients,
    productionTimeMin,
    masteredTimeMin,
    maxPrice,
    xp,
    source: entry.source || '',
    image: entry.image || '',
    wikiUrl: entry.wikiUrl || '',
    coinsPerMinute,
    coinsPerSelectedItem,
    selectedId
  };
}

function buildReverseIndex(items) {
  const reverseIndex = {};

  for (const item of items) {
    const ingredients = Array.isArray(item.ingredients) ? item.ingredients : [];
    for (const ingredient of ingredients) {
      const key = ingredient.itemId || slugify(ingredient.name);
      if (!key) continue;
      if (!reverseIndex[key]) reverseIndex[key] = [];

      const otherIngredients = ingredients
        .filter((entry) => (entry.itemId || slugify(entry.name)) !== key)
        .map((entry) => ({
          itemId: entry.itemId || slugify(entry.name),
          name: entry.name,
          qty: entry.qty
        }));

      reverseIndex[key].push({
        productId: item.id,
        productName: item.name,
        selectedQtyUsed: ingredient.qty,
        otherIngredients,
        productionTimeMin: item.productionTimeMin ?? null,
        masteredTimeMin: item.masteredTimeMin ?? null,
        maxPrice: item.maxPrice ?? null,
        xp: item.xp ?? null,
        source: item.source || '',
        image: item.image || '',
        wikiUrl: item.wikiUrl || ''
      });
    }
  }

  Object.keys(reverseIndex).forEach((key) => {
    reverseIndex[key].sort((left, right) => {
      if (left.productName !== right.productName) return left.productName.localeCompare(right.productName);
      return (left.selectedQtyUsed || 0) - (right.selectedQtyUsed || 0);
    });
  });

  return reverseIndex;
}

function buildSampleData() {
  const items = [
    {
      id: 'sugarcane',
      name: 'Sugarcane',
      type: 'crop',
      level: 1,
      source: 'Field',
      productionTimeMin: null,
      masteredTimeMin: null,
      xp: null,
      maxPrice: null,
      ingredients: [],
      image: '',
      wikiUrl: 'https://hayday.fandom.com/wiki/Sugarcane',
      sourceUrl: 'https://hayday.fandom.com/wiki/Sugarcane'
    },
    {
      id: 'white_sugar',
      name: 'White Sugar',
      type: 'product',
      level: 13,
      source: 'Sugar Mill',
      productionTimeMin: 40,
      masteredTimeMin: 34,
      xp: 6,
      maxPrice: 50,
      ingredients: [
        { itemId: 'sugarcane', name: 'Sugarcane', qty: 2 }
      ],
      image: '',
      wikiUrl: 'https://hayday.fandom.com/wiki/White_Sugar',
      sourceUrl: 'https://hayday.fandom.com/wiki/Goods_List#White_sugar'
    },
    {
      id: 'plain_cupcake',
      name: 'Plain Cupcake',
      type: 'product',
      level: null,
      source: 'Cupcake Maker',
      productionTimeMin: 40,
      masteredTimeMin: 34,
      xp: null,
      maxPrice: 280,
      ingredients: [
        { itemId: 'milk', name: 'Milk', qty: 2 },
        { itemId: 'white_sugar', name: 'White Sugar', qty: 3 },
        { itemId: 'egg', name: 'Egg', qty: 1 },
        { itemId: 'wheat', name: 'Wheat', qty: 5 }
      ],
      image: '',
      wikiUrl: 'https://hayday.fandom.com/wiki/Plain_Cupcake',
      sourceUrl: 'https://hayday.fandom.com/wiki/Plain_Cupcake'
    },
    {
      id: 'plain_waffles',
      name: 'Plain Waffles',
      type: 'product',
      level: null,
      source: 'Waffle Maker',
      productionTimeMin: 25,
      masteredTimeMin: 21,
      xp: null,
      maxPrice: 198,
      ingredients: [
        { itemId: 'white_sugar', name: 'White Sugar', qty: 2 },
        { itemId: 'egg', name: 'Egg', qty: 3 },
        { itemId: 'wheat', name: 'Wheat', qty: 5 }
      ],
      image: '',
      wikiUrl: 'https://hayday.fandom.com/wiki/Plain_Waffles',
      sourceUrl: 'https://hayday.fandom.com/wiki/Plain_Waffles'
    },
    {
      id: 'macaroon',
      name: 'Macaroon',
      type: 'product',
      level: null,
      source: 'Pastry Oven',
      productionTimeMin: 30,
      masteredTimeMin: 25,
      xp: null,
      maxPrice: 410,
      ingredients: [
        { itemId: 'white_sugar', name: 'White Sugar', qty: 2 },
        { itemId: 'coconut', name: 'Coconut', qty: 2 },
        { itemId: 'cacao', name: 'Cacao', qty: 1 }
      ],
      image: '',
      wikiUrl: 'https://hayday.fandom.com/wiki/Macaroon',
      sourceUrl: 'https://hayday.fandom.com/wiki/Macaroon'
    },
    {
      id: 'fruit_sorbet',
      name: 'Fruit Sorbet',
      type: 'product',
      level: null,
      source: 'Ice Cream Maker',
      productionTimeMin: 60,
      masteredTimeMin: 51,
      xp: null,
      maxPrice: 540,
      ingredients: [
        { itemId: 'white_sugar', name: 'White Sugar', qty: 3 },
        { itemId: 'guava', name: 'Guava', qty: 1 },
        { itemId: 'passion_fruit', name: 'Passion Fruit', qty: 1 },
        { itemId: 'mango', name: 'Mango', qty: 2 }
      ],
      image: '',
      wikiUrl: 'https://hayday.fandom.com/wiki/Fruit_Sorbet',
      sourceUrl: 'https://hayday.fandom.com/wiki/Fruit_Sorbet'
    }
  ];

  return {
    generatedAt: new Date().toISOString(),
    sources: [
      { label: 'Hay Day Wiki Goods List', url: GOODS_LIST_URL },
      { label: 'Hay Day Wiki Products', url: PRODUCTS_URL },
      { label: 'Hay Day Wiki Categories', url: CATEGORY_URLS.join(', ') }
    ],
    items,
    reverseIndex: buildReverseIndex(items)
  };
}

function createReportBase() {
  return {
    generatedAt: new Date().toISOString(),
    sourcePages: [],
    itemCount: 0,
    productsWithIngredientsCount: 0,
    reverseIndexIngredientCount: 0,
    reverseIndexEntryCount: 0,
    imagesFoundCount: 0,
    imagesDownloadedCount: 0,
    imageFailures: [],
    parseWarnings: [],
    sampleFallbackUsed: false,
    itemsFetchedCount: 0
  };
}

function writeDataFile(data) {
  return fs.writeFile(DATA_FILE, `window.HAYDAY_PRODUCT_DATA = ${JSON.stringify(data, null, 2)};\n`, 'utf8');
}

function writeReportFile(report) {
  return fs.writeFile(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function runRealImport(report) {
  const sourcePages = [
    { label: 'Goods List', url: GOODS_LIST_URL, pageTitle: 'Goods_List', kind: 'goods-list' },
    { label: 'Products', url: PRODUCTS_URL, pageTitle: 'Products', kind: 'products' }
  ];
  for (const categoryUrl of CATEGORY_URLS) {
    sourcePages.push({ label: titleFromWikiUrl(categoryUrl), url: categoryUrl, pageTitle: titleFromWikiUrl(categoryUrl), kind: 'category' });
  }

  const fetchedSourcePages = [];
  const sourceHtml = new Map();

  for (const source of sourcePages) {
    try {
      const response = await fetchParsedPage(source.pageTitle, { retry: 2 });
      sourceHtml.set(source.pageTitle, response.html);
      fetchedSourcePages.push({
        label: source.label,
        url: source.url,
        pageTitle: source.pageTitle,
        kind: source.kind,
        length: response.html.length
      });
    } catch (error) {
      report.parseWarnings.push(`Source page skipped for ${source.label}: ${error.message}`);
    }
  }

  report.sourcePages = fetchedSourcePages;

  const goodsListCandidates = parseGoodsListRows(sourceHtml.get('Goods_List'), GOODS_LIST_URL, report.parseWarnings);
  const candidatesById = new Map(goodsListCandidates.map((candidate) => [candidate.id, candidate]));

  // Pull in any pages surfaced by the categories, then keep only titles that
  // overlap with the goods library or look like real items.
  const categoryMembers = [];
  for (const categoryUrl of CATEGORY_URLS) {
    const title = titleFromWikiUrl(categoryUrl);
    const members = await fetchCategoryMembers(title, report);
    categoryMembers.push(...members);
  }

  for (const member of categoryMembers) {
    const name = cleanText(member.title);
    const id = slugify(name);
    if (!id) continue;
    if (candidatesById.has(id)) continue;
    candidatesById.set(id, {
      id,
      name,
      type: 'product',
      level: null,
      source: '',
      productionTimeMin: null,
      masteredTimeMin: null,
      xp: null,
      maxPrice: null,
      ingredients: [],
      image: '',
      wikiUrl: member.href,
      sourceUrl: member.href
    });
  }

  const candidates = Array.from(candidatesById.values())
    .sort((left, right) => {
      const leftLevel = Number.isFinite(left.level) ? left.level : Number.POSITIVE_INFINITY;
      const rightLevel = Number.isFinite(right.level) ? right.level : Number.POSITIVE_INFINITY;
      if (leftLevel !== rightLevel) return leftLevel - rightLevel;
      return left.name.localeCompare(right.name);
    });

  const limited = LIMIT ? candidates.slice(0, LIMIT) : candidates;
  if (LIMIT) {
    report.parseWarnings.push(`Debug limit applied: using only the first ${limited.length} candidates.`);
  }

  const titles = limited.map((candidate) => titleFromWikiUrl(candidate.wikiUrl) || candidate.name);
  const apiImageMap = await fetchPageImageMap(titles);

  const enriched = await mapLimit(limited, MAX_CONCURRENCY, async (candidate) => {
    const copy = { ...candidate };
    const pageTitle = titleFromWikiUrl(copy.wikiUrl) || copy.name;
    const apiImage = apiImageMap.get(pageTitle) || '';
    if (apiImage && !copy.image) {
      copy.image = apiImage;
      copy._realImageFound = true;
    }

    const enrichedCandidate = await enrichCandidate(copy, report);
    if (enrichedCandidate.image && !enrichedCandidate._generatedFallback) {
      enrichedCandidate._realImageFound = true;
    }

    if (DOWNLOAD_IMAGES) {
      if (enrichedCandidate.image && !/^images\/items\//i.test(enrichedCandidate.image) && !/^data:/i.test(enrichedCandidate.image)) {
        enrichedCandidate.image = await downloadImage(enrichedCandidate, enrichedCandidate.image, report);
      }
    }

    return enrichedCandidate;
  });

  const finalMap = new Map();
  for (const item of enriched) {
    const candidate = { ...item };
    candidate.ingredients = Array.isArray(candidate.ingredients) ? candidate.ingredients : [];
    const existing = finalMap.get(candidate.id);
    finalMap.set(candidate.id, mergeCandidates(existing, candidate));
  }

  const rawItems = Array.from(finalMap.values())
    .sort((left, right) => {
      const leftLevel = Number.isFinite(left.level) ? left.level : Number.POSITIVE_INFINITY;
      const rightLevel = Number.isFinite(right.level) ? right.level : Number.POSITIVE_INFINITY;
      if (leftLevel !== rightLevel) return leftLevel - rightLevel;
      return left.name.localeCompare(right.name);
    });

  const reverseIndex = buildReverseIndex(rawItems);

  const productItems = rawItems.filter((item) => item.type === 'product');
  const productItemsWithImages = productItems.filter((item) => Boolean(item.image && !/^data:/i.test(item.image))).length;

  const reportCounts = {
    itemCount: rawItems.length,
    productsWithIngredientsCount: productItems.filter((item) => Array.isArray(item.ingredients) && item.ingredients.length > 0).length,
    reverseIndexIngredientCount: Object.keys(reverseIndex).length,
    reverseIndexEntryCount: Object.values(reverseIndex).reduce((count, entries) => count + entries.length, 0),
    imagesFoundCount: rawItems.filter((item) => item._realImageFound).length,
    imagesDownloadedCount: report.imagesDownloadedCount,
    productItemsWithImages,
    productItemCount: productItems.length
  };

  Object.assign(report, {
    itemCount: reportCounts.itemCount,
    productsWithIngredientsCount: reportCounts.productsWithIngredientsCount,
    reverseIndexIngredientCount: reportCounts.reverseIndexIngredientCount,
    reverseIndexEntryCount: reportCounts.reverseIndexEntryCount,
    imagesFoundCount: reportCounts.imagesFoundCount,
    imagesDownloadedCount: reportCounts.imagesDownloadedCount
  });

  const validationErrors = [];
  const validationWarnings = [];

  if (!LIMIT && rawItems.length < 200) {
    validationErrors.push(`Only ${rawItems.length} items were imported; expected at least 200.`);
  }

  if (!LIMIT && reportCounts.reverseIndexIngredientCount < 50) {
    validationErrors.push(`Reverse index is suspiciously small (${reportCounts.reverseIndexIngredientCount} ingredient keys).`);
  } else if (reportCounts.reverseIndexIngredientCount < 100) {
    validationWarnings.push(`Reverse index is smaller than expected (${reportCounts.reverseIndexIngredientCount} ingredient keys).`);
  }

  const imageRatio = reportCounts.productItemCount > 0 ? (reportCounts.productItemsWithImages / reportCounts.productItemCount) : 0;
  if (!LIMIT && imageRatio < 0.7) {
    validationErrors.push(`Only ${(imageRatio * 100).toFixed(1)}% of product items have images; expected at least 70%.`);
  } else if (imageRatio < 0.7) {
    validationWarnings.push(`Only ${(imageRatio * 100).toFixed(1)}% of product items have images.`);
  }

  if (validationWarnings.length) {
    report.parseWarnings.push(...validationWarnings);
  }

  if (validationErrors.length) {
    throw new Error(validationErrors.join(' '));
  }

  const data = {
    generatedAt: new Date().toISOString(),
    sources: [
      { label: 'Hay Day Wiki Goods List', url: GOODS_LIST_URL },
      { label: 'Hay Day Wiki Products', url: PRODUCTS_URL },
      ...CATEGORY_URLS.map((url) => ({ label: titleFromWikiUrl(url), url }))
    ],
    items: rawItems.map((item) => {
      const copy = { ...item };
      delete copy._sourceRowIndex;
      delete copy._realImageFound;
      delete copy._generatedFallback;
      return copy;
    }),
    reverseIndex
  };

  return { data, report };
}

async function runWithSample(report, reason) {
  const sample = buildSampleData();
  report.sampleFallbackUsed = true;
  report.parseWarnings.push(`Sample fallback used: ${reason}`);
  report.itemCount = sample.items.length;
  report.productsWithIngredientsCount = sample.items.filter((item) => Array.isArray(item.ingredients) && item.ingredients.length > 0).length;
  report.reverseIndexIngredientCount = Object.keys(sample.reverseIndex).length;
  report.reverseIndexEntryCount = Object.values(sample.reverseIndex).reduce((count, entries) => count + entries.length, 0);
  report.imagesFoundCount = sample.items.filter((item) => Boolean(item.image)).length;
  report.imagesDownloadedCount = 0;
  return { data: sample, report };
}

async function main() {
  const report = createReportBase();
  try {
    const result = await runRealImport(report);
    await writeDataFile(result.data);
    await writeReportFile(result.report);
    console.log(`Imported ${result.report.itemCount} items into ${DATA_FILE}`);
    console.log(`Reverse index keys: ${result.report.reverseIndexIngredientCount}`);
    console.log(`Images downloaded: ${result.report.imagesDownloadedCount}`);
  } catch (error) {
    if (!ALLOW_SAMPLE) {
      report.parseWarnings.push(`Import failed: ${error.message}`);
      await writeReportFile(report);
      console.error(`Import failed: ${error.message}`);
      process.exitCode = 1;
      return;
    }

    const fallback = await runWithSample(report, error.message);
    await writeDataFile(fallback.data);
    await writeReportFile(fallback.report);
    console.warn(`Real import failed, but sample fallback was allowed: ${error.message}`);
    console.log(`Wrote sample data to ${DATA_FILE}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
