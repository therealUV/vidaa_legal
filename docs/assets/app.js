// Use localStorage override if present, otherwise fallback to your Vercel base
const API_BASE = localStorage.getItem('API_BASE') || 'https://<your-vercel>.vercel.app';

// Import settings, notifications, live feed fetcher, AI, and read items manager
import settings from './settings.js';
import notifications from './notifications.js';
import { fetchAllFeeds, isLiveFetchEnabled } from './feed-fetcher.js';
import { askQuestion, summarizeItem, generateActionItems, isConfigured as isAIConfigured } from './ai.js';
import readItems from './read-items.js';
import './theme.js';

let POSTS = [], REPORTS = [], AUDIO = { google_drive:"", items:[] };
let TAGS = new Map(), selectedTags = new Set(), selectedSources = new Set(), selectedCats = new Set();
let typePosts = true, typeReports = true, dateWindowDays = 0; // default: All
let newItemCount = 0;
let showReadItems = false; // Whether to show items marked as read

// keep chat aware of the current filters
window.FeedFilters = {
  selectedTags, selectedSources, selectedCats, dateWindowDays
};

const $ = id => document.getElementById(id);
const els = {
  q: $('q'), askAi: $('askAi'), feed: $('feed'),
  answerSection: $('answerSection'), answer: $('answer'),
  aiResults: $('aiResults'), notice: $('notice'), lastSynced: $('lastSynced'),
  fltTypePosts: $('fltTypePosts'), fltTypeReports: $('fltTypeReports'),
  srcBar: $('srcBar'), catBar: $('catBar'), pillbar: $('pillbar'),
  refreshBtn: $('refreshBtn'), clearBtn: $('clearBtn'),
  notifBadge: $('notifBadge'), notifBanner: $('notifBanner'),
  showReadToggle: $('showReadToggle'), readCountBadge: $('readCountBadge')
};

const esc = s => (s||'').replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const fmt = d => new Date(d).toISOString().slice(0,10);

async function jget(path){
  const r = await fetch(path+'?v='+Date.now(), { cache:'no-store' });
  if(!r.ok) throw new Error('Fetch '+path);
  return r.json();
}
function notice(msg){ els.notice && (els.notice.textContent = msg, els.notice.hidden = !msg); }

// Initialize settings
settings.load();

async function loadData(){
  try{
    // Check if live fetching is enabled (user has configured feeds in Settings)
    const useLiveFetch = isLiveFetchEnabled();
    
    let posts = [];
    let reports = [];
    let audio = { google_drive: "", items: [] };
    
    if (useLiveFetch) {
      // Fetch RSS feeds live based on user's Settings
      notice('Fetching live feeds...');
      const result = await fetchAllFeeds((done, total, name) => {
        notice(`Fetching feeds... ${done}/${total}`);
      });
      posts = result.posts || [];
      notice(posts.length > 0 ? '' : result.error || 'No matching items found');
      
      // Don't load static reports when using live feeds - they contain old data
      reports = [];
    } else {
      // Fall back to static JSON files
      const [staticPosts, staticReports, staticAudio] = await Promise.all([
        jget('./data/posts.json'),
        jget('./data/reports.json'),
        jget('./data/audio.json').catch(() => ({ google_drive: "", items: [] })),
      ]);
      posts = staticPosts || [];
      reports = staticReports || [];
      audio = staticAudio || { google_drive: "", items: [] };
    }
    
    POSTS = posts;
    REPORTS = reports;
    AUDIO = audio;

    // Apply user keyword filtering from settings
    const enabledKeywords = settings.getEnabledKeywords();
    if (enabledKeywords.length > 0) {
      POSTS = POSTS.map(p => {
        const text = `${p.title || ''} ${p.summary || ''} ${(p.tags || []).join(' ')}`.toLowerCase();
        const matchCount = enabledKeywords.filter(kw => text.includes(kw.term.toLowerCase())).length;
        return { ...p, _keywordScore: matchCount };
      });
    }

    // facets
    TAGS=new Map(); const sources=new Set();
    for(const p of POSTS){ (p.tags||[]).forEach(t=>TAGS.set(t,(TAGS.get(t)||0)+1)); sources.add(p.source||'Other'); }
    for(const r of REPORTS){ (r.tags||[]).forEach(t=>TAGS.set(t,(TAGS.get(t)||0)+1)); }

    // ---- Sources (dynamic) - only render if #srcBar exists
    if (els.srcBar){
      els.srcBar.innerHTML = Array.from(sources).sort().map(s =>
        `<button class="pill" data-src="${esc(s)}" aria-pressed="${selectedSources.has(s)}">${esc(s)}</button>`
      ).join('');
      els.srcBar.querySelectorAll('.pill').forEach(b => b.onclick = () => {
        const v = b.dataset.src;
        if (selectedSources.has(v)) selectedSources.delete(v); else selectedSources.add(v);
        b.setAttribute('aria-pressed', selectedSources.has(v));
        renderAll();
      });
    } else {
      // if UI has no sources, ensure no source filter is applied
      selectedSources.clear();
    }

    // ---- Categories (dynamic) - render only if #catBar exists
    if (els.catBar){
      const CAT_ORDER = [
        "CMU & Financial Markets","AI & Digital","Defence & Security","De-risking & Investment","Other"
      ];
      const catSet = new Set();
      for (const p of POSTS) (p.categories||[]).forEach(c=>catSet.add(c));
      for (const r of REPORTS) (r.categories||[]).forEach(c=>catSet.add(c));
      const cats = Array.from(catSet);
      cats.sort((a,b)=>{
        const ia=CAT_ORDER.indexOf(a), ib=CAT_ORDER.indexOf(b);
        const ra=ia===-1?999:ia, rb=ib===-1?999:ib;
        return ra===rb ? a.localeCompare(b) : ra-rb;
      });
      
      // Apply user category settings
      const enabledCats = settings.getEnabledCategories().map(c => c.name);
      
      els.catBar.innerHTML = cats.map(c =>
        `<button class="pill" data-cat="${esc(c)}" aria-pressed="${selectedCats.has(c)}">${esc(c)}</button>`
      ).join('');
      els.catBar.querySelectorAll('.pill').forEach(b => b.onclick = () => {
        const v = b.dataset.cat;
        if (selectedCats.has(v)) selectedCats.delete(v); else selectedCats.add(v);
        b.setAttribute('aria-pressed', selectedCats.has(v));
        renderAll();
      });
    } else {
      selectedCats.clear();
    }

    // ---- Tags (top 80) - only if #pillbar exists
    if (els.pillbar){
      const topTags = Array.from(TAGS.entries()).sort((a,b)=>b[1]-a[1]).slice(0,80);
      els.pillbar.innerHTML = topTags.map(([t,c]) =>
        `<button class="pill" data-tag="${esc(t)}" aria-pressed="${selectedTags.has(t)}">${esc(t)} · ${c}</button>`
      ).join('');
      els.pillbar.querySelectorAll('.pill').forEach(b => b.onclick = () => {
        const v = b.dataset.tag;
        if (selectedTags.has(v)) selectedTags.delete(v); else selectedTags.add(v);
        b.setAttribute('aria-pressed', selectedTags.has(v));
        renderAll();
      });
    }

    // ---- controls (null-safe)
    els.fltTypePosts && (els.fltTypePosts.onchange = ()=>{ typePosts=els.fltTypePosts.checked; renderAll(); });
    els.fltTypeReports && (els.fltTypeReports.onchange = ()=>{ typeReports=els.fltTypeReports.checked; renderAll(); });
    document.querySelectorAll('input[name="datewin"]').forEach(r=> r.onchange = ()=>{ dateWindowDays = Number(r.value); renderAll(); });
    els.q && (els.q.oninput = ()=>{ renderAll(); debounceAsk(); });
    els.askAi && (els.askAi.onchange = ()=> maybeAsk());
    els.refreshBtn && (els.refreshBtn.onclick = ()=>{ caches && caches.keys().then(keys=>keys.forEach(k=>caches.delete(k))); loadData(); });
    els.clearBtn && (els.clearBtn.onclick = ()=>{ selectedTags.clear(); selectedSources.clear(); selectedCats.clear(); els.q && (els.q.value=''); const r=document.querySelector('input[name="datewin"][value="0"]'); if(r) r.checked=true; dateWindowDays=0; renderAll(); });

    // Index items for quick lookup (used by summarize)
    updateItemsIndex();
    
    renderAll(); els.lastSynced && (els.lastSynced.textContent = new Date().toLocaleString());
    
    // Update notification badge after load
    updateNotificationBadge();
  }catch(e){ console.error(e); notice('Could not load data: '+e.message); }
}

const inWin = iso => !dateWindowDays || !iso || (new Date(iso).getTime() >= Date.now()-dateWindowDays*864e5);

function passes(item, isReport=false){
  if(isReport && !typeReports) return false;
  if(!isReport && !typePosts) return false;
  if(!inWin(item.added||item.date)) return false;

  // Filter out read items unless showReadItems is enabled
  const itemId = item.id || encodeURIComponent(item.url || item.title || '');
  if (!showReadItems && readItems.isRead(itemId)) return false;

  // Source filter only applies if UI exposed it (otherwise selectedSources will be empty)
  if(selectedSources.size && !isReport && !selectedSources.has(item.source||'Other')) return false;

  // Categories: check union of tags + categories
  if(selectedCats.size){
    const bag = new Set([...(item.tags||[]), ...(item.categories||[])]);
    for(const c of selectedCats){ if(!bag.has(c)) return false; }
  }

  // Tags
  if(selectedTags.size){ for(const t of selectedTags){ if(!(item.tags||[]).includes(t)) return false; } }

  // Text search
  const q = (els.q && els.q.value || '').trim().toLowerCase();
  if(q){
    const hay=(item.title+' '+(item.summary||item.abstract||'')+' '+(item.tags||[]).join(' ')).toLowerCase();
    if(!hay.includes(q)) return false;
  }
  return true;
}

const card = (p, isNew = false) => {
  const itemId = p.id || encodeURIComponent(p.url || p.title || '');
  const feedLabel = p.feedName || p.source || 'Report';
  const sourceLabel = p.sourceDomain && p.sourceDomain !== feedLabel ? ` (${p.sourceDomain})` : '';
  const isItemRead = readItems.isRead(itemId);
  return `<article class="card item${isNew ? ' new-item' : ''}${isItemRead ? ' is-read' : ''}" data-item-id="${esc(itemId)}">
  <button class="btn-mark-read" data-item-id="${esc(itemId)}" title="${isItemRead ? 'Mark as unread' : 'Mark as read'}">
    ${isItemRead ? '↩️' : '✓'}
  </button>
  <div class="feed-badge" title="Feed: ${esc(feedLabel)}">${esc(feedLabel)}</div>
  <h3><a href="${esc(p.url||'#')}" target="_blank" rel="noopener">${esc(p.title||'(no title)')}</a></h3>
  <div class="meta">${esc((p.added?fmt(p.added):p.date)||'')}${sourceLabel ? ` • <span class="source-domain">${esc(sourceLabel)}</span>` : ''}${p._keywordScore ? ` • <span class="relevance">🎯 ${p._keywordScore} keyword${p._keywordScore > 1 ? 's' : ''}</span>` : ''}</div>
  <p class="summary" data-summary-id="${esc(itemId)}">${esc((p.summary||p.abstract||'').slice(0,280))}${(p.summary||p.abstract||'').length>280?'…':''}</p>
  <div class="card-footer">
    <div class="tags">${(p.tags||[]).slice(0,6).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</div>
    <div class="ai-actions">
      <button class="btn-summarize" data-item-id="${esc(itemId)}" title="AI Summary">✨ Summarize</button>
      <button class="btn-action-items" data-item-id="${esc(itemId)}" title="Generate Action Items for VIDAA">🎯 Action Items</button>
    </div>
  </div>
  <div class="action-items-panel" data-action-items-id="${esc(itemId)}" hidden></div>
</article>`;
};

// Store items by ID for quick lookup
let ITEMS_BY_ID = new Map();

function updateItemsIndex() {
  ITEMS_BY_ID.clear();
  for (const p of POSTS) {
    const id = p.id || encodeURIComponent(p.url || p.title || '');
    ITEMS_BY_ID.set(id, p);
  }
}

// Handle summarize button clicks
document.addEventListener('click', async (e) => {
  if (!e.target.classList.contains('btn-summarize')) return;
  
  const itemId = e.target.dataset.itemId;
  const item = ITEMS_BY_ID.get(itemId);
  if (!item) return;
  
  if (!isAIConfigured()) {
    alert('AI not configured. Go to Settings → AI to add your OpenAI API key.');
    return;
  }
  
  const btn = e.target;
  const summaryEl = document.querySelector(`[data-summary-id="${itemId}"]`);
  
  // Show loading state
  btn.disabled = true;
  btn.textContent = '⏳ Summarizing...';
  
  try {
    const summary = await summarizeItem(item);
    if (summaryEl && summary) {
      summaryEl.innerHTML = `<strong>AI Summary:</strong><br>${esc(summary).replace(/\n/g, '<br>')}`;
      summaryEl.classList.add('ai-summary');
    }
    btn.textContent = '✓ Done';
    setTimeout(() => { btn.textContent = '✨ Summarize'; btn.disabled = false; }, 2000);
  } catch (err) {
    alert('Summarize failed: ' + err.message);
    btn.textContent = '✨ Summarize';
    btn.disabled = false;
  }
});

// Handle Action Items button clicks - Enhanced with full document analysis
document.addEventListener('click', async (e) => {
  if (!e.target.classList.contains('btn-action-items')) return;
  
  const itemId = e.target.dataset.itemId;
  const item = ITEMS_BY_ID.get(itemId);
  if (!item) return;
  
  if (!isAIConfigured()) {
    alert('AI not configured. Go to Settings → AI to add your OpenAI API key.');
    return;
  }
  
  const btn = e.target;
  const panelEl = document.querySelector(`[data-action-items-id="${itemId}"]`);
  
  // Toggle panel if already showing
  if (panelEl && !panelEl.hidden && panelEl.innerHTML) {
    panelEl.hidden = true;
    return;
  }
  
  // Show loading state with progress
  btn.disabled = true;
  const originalBtnText = btn.textContent;
  btn.textContent = '⏳ Starting...';
  
  // Show panel with loading indicator
  if (panelEl) {
    panelEl.innerHTML = `
      <div class="action-items-content">
        <div class="action-items-header">
          <span class="action-items-label">VIDAA Action Items</span>
          <button class="action-items-close" data-close-id="${esc(itemId)}">×</button>
        </div>
        <div class="action-items-body">
          <div class="analysis-loading">
            <div class="loading-spinner"></div>
            <p class="loading-status">Initializing analysis...</p>
            <p class="loading-hint">This may take 30-60 seconds for full document analysis</p>
          </div>
        </div>
      </div>
    `;
    panelEl.hidden = false;
  }
  
  const updateProgress = (status) => {
    const statusEl = panelEl?.querySelector('.loading-status');
    if (statusEl) statusEl.textContent = status;
    btn.textContent = `⏳ ${status.slice(0, 20)}...`;
  };
  
  try {
    // Pass all items for related document detection
    const result = await generateActionItems(item, {
      allItems: POSTS,
      fetchFullContent: true,
      fetchRelatedContent: false, // Set to true for even deeper analysis
      onProgress: updateProgress
    });
    
    // Handle both legacy string response and new object response
    const analysis = typeof result === 'string' ? result : result.analysis;
    const metadata = typeof result === 'object' ? result.metadata : null;
    
    if (panelEl && analysis) {
      // Convert markdown to HTML with enhanced formatting
      let html = analysis
        // Section headers
        .replace(/## 📋 EXECUTIVE SUMMARY/g, '<h4 class="ai-section-title executive">📋 Executive Summary</h4>')
        .replace(/## 🎯 ACTION ITEMS/g, '<h4 class="ai-section-title checklist">🎯 Action Items</h4>')
        // Sub-headers
        .replace(/### ([^\n]+)/g, '<h5 class="ai-subsection">$1</h5>')
        // Bold text
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        // Tables (basic markdown table support)
        .replace(/\|([^\n]+)\|\n\|[-:\| ]+\|\n((?:\|[^\n]+\|\n?)+)/g, (match, header, body) => {
          const headers = header.split('|').filter(h => h.trim()).map(h => `<th>${h.trim()}</th>`).join('');
          const rows = body.trim().split('\n').map(row => {
            const cells = row.split('|').filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join('');
            return `<tr>${cells}</tr>`;
          }).join('');
          return `<table class="compliance-table"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
        })
        // List items
        .replace(/^- /gm, '• ')
        .replace(/^\d+\. /gm, (match) => `<span class="list-number">${match}</span>`)
        // Line breaks
        .replace(/\n/g, '<br>');
      
      // Build metadata section if available
      let metadataHtml = '';
      if (metadata) {
        metadataHtml = `
          <div class="analysis-metadata">
            <span class="meta-item" title="AI Model Used">🤖 ${esc(metadata.model)}</span>
            <span class="meta-item" title="Content Source">📄 ${esc(metadata.contentSource)}</span>
            <span class="meta-item" title="Document Length">📏 ${Math.round(metadata.documentLength / 1000)}k chars</span>
            ${metadata.relatedDocuments?.length > 0 ? `<span class="meta-item" title="Related Documents Found">🔗 ${metadata.relatedDocuments.length} related</span>` : ''}
            ${metadata.legalReferences?.length > 0 ? `<span class="meta-item" title="Legal References Detected">⚖️ ${metadata.legalReferences.length} refs</span>` : ''}
          </div>
        `;
        
        // Add related documents section if any
        if (metadata.relatedDocuments?.length > 0) {
          metadataHtml += `
            <details class="related-docs-section">
              <summary>📎 Related Documents (${metadata.relatedDocuments.length})</summary>
              <ul class="related-docs-list">
                ${metadata.relatedDocuments.map(doc => `
                  <li>
                    <span class="rel-type">${esc(doc.relationship)}</span>
                    <a href="${esc(doc.url)}" target="_blank" rel="noopener">${esc(doc.title?.slice(0, 80))}${doc.title?.length > 80 ? '...' : ''}</a>
                  </li>
                `).join('')}
              </ul>
            </details>
          `;
        }
      }
      
      panelEl.innerHTML = `
        <div class="action-items-content enhanced">
          <div class="action-items-header">
            <span class="action-items-label">VIDAA Action Items</span>
            <div class="action-items-actions">
              <button class="btn-copy-analysis" data-item-id="${esc(itemId)}" title="Copy to clipboard">📋 Copy</button>
              <button class="action-items-close" data-close-id="${esc(itemId)}">×</button>
            </div>
          </div>
          ${metadataHtml}
          <div class="action-items-body enhanced">${html}</div>
        </div>
      `;
      panelEl.hidden = false;
      
      // Scroll the panel into view
      panelEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    btn.textContent = '✓ Analysis Complete';
    setTimeout(() => { btn.textContent = '🎯 Action Items'; btn.disabled = false; }, 3000);
  } catch (err) {
    console.error('[app] Action Items failed:', err);
    if (panelEl) {
      panelEl.innerHTML = `
        <div class="action-items-content error">
          <div class="action-items-header">
            <span class="action-items-label">Analysis Failed</span>
            <button class="action-items-close" data-close-id="${esc(itemId)}">×</button>
          </div>
          <div class="action-items-body">
            <p class="error-message">❌ ${esc(err.message)}</p>
            <p class="error-hint">This could be due to rate limits, network issues, or document access restrictions. Try again in a few moments.</p>
          </div>
        </div>
      `;
    }
    btn.textContent = '🎯 Action Items';
    btn.disabled = false;
  }
});

// Handle copy analysis button
document.addEventListener('click', async (e) => {
  if (!e.target.classList.contains('btn-copy-analysis')) return;
  
  const itemId = e.target.dataset.itemId;
  const panelEl = document.querySelector(`[data-action-items-id="${itemId}"]`);
  const bodyEl = panelEl?.querySelector('.action-items-body');
  
  if (bodyEl) {
    try {
      // Get text content, preserving some structure
      const text = bodyEl.innerText;
      await navigator.clipboard.writeText(text);
      e.target.textContent = '✓ Copied!';
      setTimeout(() => { e.target.textContent = '📋 Copy'; }, 2000);
    } catch (err) {
      console.warn('[app] Copy failed:', err);
    }
  }
});

// Handle closing action items panel
document.addEventListener('click', (e) => {
  if (!e.target.classList.contains('action-items-close')) return;
  const itemId = e.target.dataset.closeId;
  const panelEl = document.querySelector(`[data-action-items-id="${itemId}"]`);
  if (panelEl) panelEl.hidden = true;
});

// Handle mark as read button clicks
document.addEventListener('click', async (e) => {
  if (!e.target.classList.contains('btn-mark-read')) return;
  
  const itemId = e.target.dataset.itemId;
  const btn = e.target;
  const cardEl = btn.closest('.card.item');
  
  if (readItems.isRead(itemId)) {
    // Mark as unread
    await readItems.markAsUnread(itemId);
    btn.textContent = '✓';
    btn.title = 'Mark as read';
    cardEl?.classList.remove('is-read');
  } else {
    // Mark as read
    await readItems.markAsRead(itemId);
    btn.textContent = '↩️';
    btn.title = 'Mark as unread';
    cardEl?.classList.add('is-read');
    
    // If not showing read items, animate and remove the card
    if (!showReadItems && cardEl) {
      cardEl.classList.add('fade-out');
      setTimeout(() => {
        renderFeed();
        updateReadCountBadge();
      }, 300);
    }
  }
  
  updateReadCountBadge();
});

// Update read count badge
async function updateReadCountBadge() {
  if (els.readCountBadge) {
    const count = await readItems.getReadCount();
    els.readCountBadge.textContent = count > 0 ? count : '';
    els.readCountBadge.classList.toggle('visible', count > 0);
  }
}

// Handle show read toggle
function setupShowReadToggle() {
  if (els.showReadToggle) {
    els.showReadToggle.checked = showReadItems;
    els.showReadToggle.onchange = () => {
      showReadItems = els.showReadToggle.checked;
      renderAll();
    };
  }
}

function renderFeed(){
  let items = POSTS.filter(p=>passes(p,false));
  
  // Sort by date (newest first)
  items.sort((a,b)=> new Date(b.added||b.date) - new Date(a.added||a.date));
  
  items = items.slice(0, 50); // show more items with full-width layout
  els.feed && (els.feed.innerHTML = items.length ? items.map(p => card(p)).join('') : '<p>No items match.</p>');
}


function renderAll(){ renderFeed(); maybeAsk(); }

/* Ask AI */
let askTimer; function debounceAsk(){ clearTimeout(askTimer); askTimer=setTimeout(maybeAsk,400); }
async function maybeAsk(){
  const q = (els.q && els.q.value || '').trim();
  if(!els.askAi || !els.askAi.checked || !q){ 
    els.answerSection && (els.answerSection.hidden=true); 
    return; 
  }
  
  // Check if OpenAI is configured
  if(!isAIConfigured()){ 
    notice('AI not configured. Go to Settings → AI to add your OpenAI API key.'); 
    els.answerSection && (els.answerSection.hidden=true); 
    return; 
  }
  
  try{
    // Show loading state
    els.answerSection && (els.answerSection.hidden=false);
    els.answer && (els.answer.innerHTML = '<p class="loading">Thinking...</p>');
    els.aiResults && (els.aiResults.innerHTML = '');
    
    // Get filtered posts for context
    const filteredPosts = POSTS.filter(p => passes(p, false)).slice(0, 15);
    
    // Ask OpenAI
    const result = await askQuestion(q, filteredPosts);
    
    // Format the answer with markdown-like formatting
    const formattedAnswer = result.answer
      .replace(/\[(\d+)\]/g, '<strong>[$1]</strong>')
      .replace(/\n/g, '<br>');
    
    els.answer && (els.answer.innerHTML = `<p>${formattedAnswer}</p>`);
    
    // Show the top relevant posts as sources
    const topPosts = filteredPosts.slice(0, 5);
    els.aiResults && (els.aiResults.innerHTML = topPosts.map(p => card(p)).join(''));
  }catch(e){ 
    console.warn('[AI]', e); 
    els.answer && (els.answer.innerHTML = `<p class="error">Error: ${esc(e.message)}</p>`);
  }
}

/* Notification Badge & Banner */
async function updateNotificationBadge() {
  try {
    newItemCount = await notifications.getBadgeCount();
    
    // Update badge
    if (els.notifBadge) {
      if (newItemCount > 0) {
        els.notifBadge.textContent = newItemCount > 99 ? '99+' : newItemCount;
        els.notifBadge.classList.add('visible');
      } else {
        els.notifBadge.classList.remove('visible');
      }
    }
    
    // Update banner
    if (els.notifBanner && newItemCount > 0) {
      els.notifBanner.innerHTML = `
        <span class="banner-text">${newItemCount} new update${newItemCount > 1 ? 's' : ''} since your last visit</span>
        <button class="banner-btn" id="markSeenBtn">Mark as read</button>
        <button class="banner-close" id="closeBannerBtn">×</button>
      `;
      els.notifBanner.classList.add('visible');
      
      $('markSeenBtn')?.addEventListener('click', async () => {
        await notifications.markAllAsSeen();
        els.notifBanner.classList.remove('visible');
        updateNotificationBadge();
      });
      
      $('closeBannerBtn')?.addEventListener('click', () => {
        els.notifBanner.classList.remove('visible');
      });
    }
  } catch (e) {
    console.warn('[app] Badge update failed:', e);
  }
}

// Listen for new items from notification system
window.addEventListener('eurlex:newItems', (e) => {
  newItemCount = e.detail.count;
  updateNotificationBadge();
});

/* SW */
if('serviceWorker' in navigator){ 
  navigator.serviceWorker.register('./assets/sw.js')
    .then(reg => console.log('[SW] Registered:', reg.scope))
    .catch(e => console.warn('[SW] Registration failed:', e)); 
}

// Initialize notifications
notifications.init();

// Initialize read items manager and load data
readItems.init().then(() => {
  setupShowReadToggle();
  loadData().then(() => {
    updateReadCountBadge();
  });
});
