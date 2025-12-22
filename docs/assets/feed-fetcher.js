/**
 * Live RSS Feed Fetcher - Fetches feeds directly in the browser
 * Uses corsproxy.io to bypass CORS restrictions
 */

import settings from './settings.js';

// CORS proxy that works well with EU government feeds
const CORS_PROXY = 'https://corsproxy.io/?';

/**
 * Parse RSS/Atom XML into structured entries
 */
function parseRSS(xmlText, feedUrl, feedName = null) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  const entries = [];
  
  // Check for parsing errors
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    console.warn('[feed-fetcher] XML parse error for', feedUrl);
    return [];
  }
  
  // Use provided feed name, or extract from feed title, or fall back to domain
  const sourceDomain = getSourceName(feedUrl);
  const feedTitle = doc.querySelector('channel > title, feed > title')?.textContent;
  const displaySource = feedName || cleanText(feedTitle) || sourceDomain;
  
  // Try RSS 2.0 format first
  const rssItems = doc.querySelectorAll('item');
  if (rssItems.length > 0) {
    rssItems.forEach(item => {
      const title = item.querySelector('title')?.textContent || '';
      const link = item.querySelector('link')?.textContent || '';
      const description = item.querySelector('description')?.textContent || '';
      const pubDate = item.querySelector('pubDate')?.textContent;
      const creator = item.querySelector('creator')?.textContent || '';
      
      entries.push({
        title: cleanText(title),
        url: link,
        summary: cleanText(description),
        published: pubDate ? new Date(pubDate) : new Date(),
        source: displaySource,
        sourceDomain,
        feedName: feedName || displaySource,
        creator
      });
    });
    return entries;
  }
  
  // Try Atom format
  const atomEntries = doc.querySelectorAll('entry');
  if (atomEntries.length > 0) {
    atomEntries.forEach(entry => {
      const title = entry.querySelector('title')?.textContent || '';
      const link = entry.querySelector('link')?.getAttribute('href') || '';
      const summary = entry.querySelector('summary')?.textContent || 
                      entry.querySelector('content')?.textContent || '';
      const updated = entry.querySelector('updated')?.textContent ||
                      entry.querySelector('published')?.textContent;
      
      entries.push({
        title: cleanText(title),
        url: link,
        summary: cleanText(summary),
        published: updated ? new Date(updated) : new Date(),
        source: displaySource,
        sourceDomain,
        feedName: feedName || displaySource
      });
    });
    return entries;
  }
  
  return entries;
}

/**
 * Clean HTML entities and tags from text
 */
function cleanText(text) {
  if (!text) return '';
  // Remove HTML tags
  const div = document.createElement('div');
  div.innerHTML = text;
  let cleaned = div.textContent || div.innerText || '';
  // Trim and collapse whitespace
  return cleaned.replace(/\s+/g, ' ').trim();
}

/**
 * Get a friendly source name from feed URL
 */
function getSourceName(feedUrl) {
  if (feedUrl.includes('eur-lex.europa.eu')) return 'EUR-Lex';
  if (feedUrl.includes('ecb.europa.eu')) return 'ECB';
  if (feedUrl.includes('eba.europa.eu')) return 'EBA';
  if (feedUrl.includes('eiopa.europa.eu')) return 'EIOPA';
  if (feedUrl.includes('esma.europa.eu')) return 'ESMA';
  if (feedUrl.includes('europarl.europa.eu')) return 'European Parliament';
  if (feedUrl.includes('consilium.europa.eu')) return 'Council of the EU';
  return 'RSS Feed';
}

/**
 * Generate a stable ID from URL
 */
function generateId(url) {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

/**
 * Categorize post based on keywords in text
 */
function categorize(text) {
  const lower = text.toLowerCase();
  const categories = [];
  
  // CMU & Financial Markets
  if (/\b(cmu|mifid|mifir|emir|finance|financial|banking|ecb|eba|esma|eiopa|aml|dora|mica|pension|investment)\b/i.test(lower)) {
    categories.push('CMU & Financial Markets');
  }
  
  // AI & Digital
  if (/\b(ai|artificial intelligence|digital|data act|dsa|dma|nis2|cyber|eidas)\b/i.test(lower)) {
    categories.push('AI & Digital');
  }
  
  // Defence & Security
  if (/\b(defence|defense|security|military|pesco|eda)\b/i.test(lower)) {
    categories.push('Defence & Security');
  }
  
  // De-risking & Investment
  if (/\b(de-risking|investment|fdi|export|industrial|raw materials)\b/i.test(lower)) {
    categories.push('De-risking & Investment');
  }
  
  if (categories.length === 0) {
    categories.push('Other');
  }
  
  return categories;
}

/**
 * Check if post matches user's enabled keywords
 */
function matchesKeywords(text, enabledKeywords) {
  if (enabledKeywords.length === 0) return { matches: true, score: 0 };
  
  const lower = text.toLowerCase();
  let score = 0;
  
  for (const kw of enabledKeywords) {
    if (lower.includes(kw.term.toLowerCase())) {
      score++;
    }
  }
  
  return { matches: score > 0, score };
}

/**
 * Fetch a single RSS feed via CORS proxy
 */
async function fetchFeed(feedUrl, feedName = null) {
  try {
    const proxyUrl = CORS_PROXY + encodeURIComponent(feedUrl);
    const response = await fetch(proxyUrl);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const text = await response.text();
    const entries = parseRSS(text, feedUrl, feedName);
    
    console.log(`[feed-fetcher] Got ${entries.length} items from ${feedName || getSourceName(feedUrl)}`);
    return entries;
  } catch (e) {
    console.warn(`[feed-fetcher] Failed to fetch ${feedUrl}:`, e.message);
    return [];
  }
}

/**
 * Fetch all enabled feeds and return processed posts
 */
async function fetchAllFeeds(onProgress) {
  const enabledFeeds = settings.getEnabledFeeds();
  const enabledKeywords = settings.getEnabledKeywords();
  const enabledCategories = settings.getEnabledCategories().map(c => c.name);
  
  if (enabledFeeds.length === 0) {
    return { posts: [], error: 'No feeds enabled. Go to Settings to add feeds.' };
  }
  
  const allEntries = [];
  let completed = 0;
  
  // Fetch feeds in parallel (max 3 at a time)
  const batchSize = 3;
  for (let i = 0; i < enabledFeeds.length; i += batchSize) {
    const batch = enabledFeeds.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(f => fetchFeed(f.url, f.name)));
    
    results.forEach((entries, idx) => {
      allEntries.push(...entries);
      completed++;
      if (onProgress) {
        onProgress(completed, enabledFeeds.length, batch[idx].name);
      }
    });
  }
  
  // Process and filter entries
  const seenUrls = new Set();
  const posts = [];
  
  for (const entry of allEntries) {
    if (!entry.url || seenUrls.has(entry.url)) continue;
    seenUrls.add(entry.url);
    
    const text = `${entry.title} ${entry.summary}`;
    
    // Check keyword match
    const { matches, score } = matchesKeywords(text, enabledKeywords);
    if (!matches && enabledKeywords.length > 0) continue;
    
    // Categorize
    const categories = categorize(text);
    
    // Check category filter
    if (enabledCategories.length < settings.getCategories().length) {
      const hasCategory = categories.some(c => enabledCategories.includes(c));
      if (!hasCategory) continue;
    }
    
    posts.push({
      id: generateId(entry.url),
      source: entry.source,
      url: entry.url,
      title: entry.title,
      summary: entry.summary.slice(0, 500),
      tags: [...categories, entry.source],
      categories,
      added: entry.published.toISOString(),
      score,
      ts: entry.published.getTime(),
      _keywordScore: score,
      _live: true // Mark as live-fetched
    });
  }
  
  // Sort by date (newest first)
  posts.sort((a, b) => b.ts - a.ts);
  
  return { posts: posts.slice(0, 100), total: allEntries.length };
}

/**
 * Check if live fetching is enabled (at least one feed configured)
 */
function isLiveFetchEnabled() {
  return settings.getEnabledFeeds().length > 0;
}

export { fetchAllFeeds, fetchFeed, isLiveFetchEnabled };
export default { fetchAllFeeds, fetchFeed, isLiveFetchEnabled };

