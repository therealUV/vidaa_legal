/**
 * Document Extractor Module
 * Fetches and extracts full content from HTML pages and PDFs for legal analysis
 */

// PDF.js library (loaded from CDN if needed)
let pdfjsLib = null;

/**
 * Initialize PDF.js library
 */
async function initPdfJs() {
  if (pdfjsLib) return pdfjsLib;
  
  // Load PDF.js from CDN
  if (!window.pdfjsLib) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }
  
  pdfjsLib = window.pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  return pdfjsLib;
}

/**
 * Strip HTML tags and clean text
 */
function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract main content from HTML, focusing on article/main elements
 */
function extractMainContent(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  
  // Try to find the main content area
  const selectors = [
    'article',
    'main',
    '[role="main"]',
    '.content',
    '.article-content',
    '.post-content',
    '#content',
    '#main',
    '.eli-main-body', // EUR-Lex specific
    '.texte',         // EU official documents
    '.doc-content'
  ];
  
  let mainEl = null;
  for (const sel of selectors) {
    mainEl = doc.querySelector(sel);
    if (mainEl) break;
  }
  
  // Fall back to body
  if (!mainEl) mainEl = doc.body;
  if (!mainEl) return stripHtml(html);
  
  // Extract structured content
  const sections = [];
  
  // Get headings and their content
  const headings = mainEl.querySelectorAll('h1, h2, h3, h4, h5, h6');
  headings.forEach(h => {
    const level = parseInt(h.tagName[1]);
    const text = h.textContent.trim();
    if (text) {
      sections.push({ type: 'heading', level, text });
    }
  });
  
  // Get paragraphs
  const paragraphs = mainEl.querySelectorAll('p');
  paragraphs.forEach(p => {
    const text = p.textContent.trim();
    if (text && text.length > 20) { // Skip very short paragraphs
      sections.push({ type: 'paragraph', text });
    }
  });
  
  // Get list items (often contain important legal points)
  const listItems = mainEl.querySelectorAll('li');
  listItems.forEach(li => {
    const text = li.textContent.trim();
    if (text && text.length > 10) {
      sections.push({ type: 'list-item', text });
    }
  });
  
  // Get tables (often contain dates, requirements)
  const tables = mainEl.querySelectorAll('table');
  tables.forEach(table => {
    const rows = [];
    table.querySelectorAll('tr').forEach(tr => {
      const cells = [];
      tr.querySelectorAll('th, td').forEach(cell => {
        cells.push(cell.textContent.trim());
      });
      if (cells.length > 0) {
        rows.push(cells.join(' | '));
      }
    });
    if (rows.length > 0) {
      sections.push({ type: 'table', text: rows.join('\n') });
    }
  });
  
  // Combine into structured text
  let result = '';
  for (const section of sections) {
    if (section.type === 'heading') {
      result += '\n\n' + '#'.repeat(section.level) + ' ' + section.text + '\n';
    } else if (section.type === 'paragraph') {
      result += '\n' + section.text;
    } else if (section.type === 'list-item') {
      result += '\n• ' + section.text;
    } else if (section.type === 'table') {
      result += '\n\n[TABLE]\n' + section.text + '\n[/TABLE]\n';
    }
  }
  
  // If structured extraction failed, fall back to full text
  if (result.trim().length < 200) {
    result = stripHtml(mainEl.innerHTML);
  }
  
  return result.trim();
}

/**
 * Extract text from a PDF file
 */
async function extractPdfText(url) {
  try {
    const pdf = await initPdfJs();
    
    // Fetch PDF as array buffer
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch PDF: ${response.status}`);
    
    const arrayBuffer = await response.arrayBuffer();
    const pdfDoc = await pdf.getDocument({ data: arrayBuffer }).promise;
    
    const textParts = [];
    const numPages = pdfDoc.numPages;
    
    // Extract text from each page (limit to first 50 pages for very long docs)
    const maxPages = Math.min(numPages, 50);
    
    for (let i = 1; i <= maxPages; i++) {
      const page = await pdfDoc.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map(item => item.str)
        .join(' ')
        .replace(/\s+/g, ' ');
      
      if (pageText.trim()) {
        textParts.push(`[Page ${i}]\n${pageText}`);
      }
    }
    
    if (numPages > maxPages) {
      textParts.push(`\n[Note: Document has ${numPages} pages, showing first ${maxPages}]`);
    }
    
    return textParts.join('\n\n');
  } catch (e) {
    console.warn('[doc-extractor] PDF extraction failed:', e);
    return null;
  }
}

/**
 * Detect if URL points to a PDF
 */
function isPdfUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return lower.endsWith('.pdf') || 
         lower.includes('/pdf/') || 
         lower.includes('format=pdf') ||
         lower.includes('type=pdf');
}

// Backend server URL for CORS-free document fetching
const BACKEND_URL = localStorage.getItem('BACKEND_URL') || 'http://localhost:5001';

/**
 * Try to fetch document via backend server (bypasses CORS)
 */
async function fetchViaBackend(url, timeout = 30000) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    const backendUrl = `${BACKEND_URL}/api/fetch-document?url=${encodeURIComponent(url)}`;
    const response = await fetch(backendUrl, {
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      return { success: false, error: error.error || `HTTP ${response.status}` };
    }
    
    const data = await response.json();
    return data;
  } catch (e) {
    if (e.name === 'AbortError') {
      return { success: false, error: 'Backend request timeout' };
    }
    // Backend not available - return specific error so we can fallback
    return { success: false, error: 'backend_unavailable', isBackendError: true };
  }
}

/**
 * Fetch and extract full document content
 * First tries backend server (CORS-free), falls back to direct fetch
 */
async function fetchDocumentContent(url, options = {}) {
  const { maxLength = 100000, timeout = 30000 } = options;
  
  if (!url) return { success: false, error: 'No URL provided' };
  
  // Try backend server first (handles CORS)
  console.log('[doc-extractor] Trying backend server for:', url);
  const backendResult = await fetchViaBackend(url, timeout);
  
  if (backendResult.success) {
    console.log('[doc-extractor] Backend success:', backendResult.type, backendResult.originalLength, 'chars');
    return {
      success: true,
      content: backendResult.content.slice(0, maxLength),
      type: backendResult.type,
      truncated: backendResult.content.length > maxLength,
      originalLength: backendResult.originalLength,
      source: 'backend'
    };
  }
  
  // If backend is unavailable, try direct fetch (may fail due to CORS)
  if (backendResult.isBackendError) {
    console.log('[doc-extractor] Backend unavailable, trying direct fetch...');
  } else {
    console.log('[doc-extractor] Backend error:', backendResult.error);
  }
  
  try {
    // Handle PDFs
    if (isPdfUrl(url)) {
      const pdfText = await extractPdfText(url);
      if (pdfText) {
        return {
          success: true,
          content: pdfText.slice(0, maxLength),
          type: 'pdf',
          truncated: pdfText.length > maxLength,
          originalLength: pdfText.length,
          source: 'direct'
        };
      }
    }
    
    // Handle HTML/text
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'EURLex-Compliance-Analyzer/1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9'
      }
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }
    
    const contentType = response.headers.get('content-type') || '';
    
    // Check if response is actually a PDF
    if (contentType.includes('application/pdf')) {
      const arrayBuffer = await response.arrayBuffer();
      const pdf = await initPdfJs();
      const pdfDoc = await pdf.getDocument({ data: arrayBuffer }).promise;
      
      const textParts = [];
      const maxPages = Math.min(pdfDoc.numPages, 50);
      
      for (let i = 1; i <= maxPages; i++) {
        const page = await pdfDoc.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map(item => item.str).join(' ');
        if (pageText.trim()) {
          textParts.push(`[Page ${i}]\n${pageText}`);
        }
      }
      
      const pdfText = textParts.join('\n\n');
      return {
        success: true,
        content: pdfText.slice(0, maxLength),
        type: 'pdf',
        truncated: pdfText.length > maxLength,
        originalLength: pdfText.length,
        source: 'direct'
      };
    }
    
    // Handle HTML
    const html = await response.text();
    const content = extractMainContent(html);
    
    return {
      success: true,
      content: content.slice(0, maxLength),
      type: 'html',
      truncated: content.length > maxLength,
      originalLength: content.length,
      source: 'direct'
    };
    
  } catch (e) {
    if (e.name === 'AbortError') {
      return { success: false, error: 'Request timeout' };
    }
    // Include original backend error if direct fetch also failed
    const errorMsg = backendResult.isBackendError 
      ? `Direct fetch failed (${e.message}). Start the backend server: python backend/server.py`
      : e.message;
    return { success: false, error: errorMsg };
  }
}

/**
 * Extract CELEX ID from text or URL
 */
function extractCelexId(text) {
  if (!text) return null;
  
  // CELEX patterns: 32024R1234, 32019L0790, etc.
  const patterns = [
    /CELEX[:\s]*(\d{5}[A-Z]\d{4}(?:\(\d+\))?)/i,
    /(\d{5}[A-Z]\d{4}(?:\(\d+\))?)/,
    /(?:Regulation|Directive|Decision)\s*\(?EU\)?\s*(?:No\.?\s*)?(\d{4}\/\d+)/i
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  
  return null;
}

/**
 * Extract regulation/directive references from text
 */
function extractLegalReferences(text) {
  if (!text) return [];
  
  const references = new Set();
  
  // EU Regulation patterns
  const regPatterns = [
    /Regulation\s*\(?EU\)?\s*(?:No\.?\s*)?(\d{4}\/\d+|\d+\/\d{4})/gi,
    /Regulation\s*\(?EU\)?\s*(\d{4}\/\d+)/gi,
    /(?:EU|EC)\s*(?:No\.?\s*)?(\d+\/\d{4})/gi
  ];
  
  // EU Directive patterns
  const dirPatterns = [
    /Directive\s*\(?EU\)?\s*(?:No\.?\s*)?(\d{4}\/\d+|\d+\/\d{4})/gi,
    /Directive\s*(\d{4}\/\d+)/gi
  ];
  
  // Common regulation acronyms
  const acronyms = {
    'GDPR': 'Regulation (EU) 2016/679',
    'DSA': 'Regulation (EU) 2022/2065',
    'DMA': 'Regulation (EU) 2022/1925',
    'AI Act': 'Regulation (EU) 2024/1689',
    'MiCA': 'Regulation (EU) 2023/1114',
    'DORA': 'Regulation (EU) 2022/2554',
    'ePrivacy': 'Directive 2002/58/EC',
    'NIS2': 'Directive (EU) 2022/2555',
    'CRA': 'Cyber Resilience Act',
    'Data Act': 'Regulation (EU) 2023/2854',
    'MiFID II': 'Directive 2014/65/EU',
    'MiFIR': 'Regulation (EU) 600/2014'
  };
  
  // Find regulation references
  for (const pattern of regPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      references.add(`Regulation ${match[1]}`);
    }
  }
  
  // Find directive references
  for (const pattern of dirPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      references.add(`Directive ${match[1]}`);
    }
  }
  
  // Find acronym references
  for (const [acronym, fullName] of Object.entries(acronyms)) {
    if (text.includes(acronym)) {
      references.add(fullName);
    }
  }
  
  return Array.from(references);
}

/**
 * Find related documents in the dataset
 */
function findRelatedDocuments(item, allItems, options = {}) {
  const { maxResults = 10 } = options;
  
  if (!item || !allItems || allItems.length === 0) return [];
  
  const itemText = `${item.title || ''} ${item.summary || ''}`.toLowerCase();
  const itemCelex = extractCelexId(item.title) || extractCelexId(item.url);
  const itemRefs = extractLegalReferences(itemText);
  
  const scored = [];
  
  for (const other of allItems) {
    if (other.id === item.id || other.url === item.url) continue;
    
    let score = 0;
    let relationship = null;
    
    const otherText = `${other.title || ''} ${other.summary || ''}`.toLowerCase();
    const otherCelex = extractCelexId(other.title) || extractCelexId(other.url);
    const otherRefs = extractLegalReferences(otherText);
    
    // Same CELEX base (amendments, implementations)
    if (itemCelex && otherCelex) {
      const itemBase = itemCelex.slice(0, 9);
      const otherBase = otherCelex.slice(0, 9);
      if (itemBase === otherBase) {
        score += 50;
        relationship = 'same-regulation';
      }
    }
    
    // References each other
    if (itemRefs.some(ref => otherText.includes(ref.toLowerCase()))) {
      score += 30;
      relationship = relationship || 'references';
    }
    if (otherRefs.some(ref => itemText.includes(ref.toLowerCase()))) {
      score += 30;
      relationship = relationship || 'referenced-by';
    }
    
    // Amendment/implementing act patterns
    const amendPatterns = [
      /amend(?:ing|s|ed)?/i,
      /implement(?:ing|s|ed)?/i,
      /supplement(?:ing|s|ed)?/i,
      /delegat(?:ing|ed)/i,
      /corrigendum/i
    ];
    
    for (const pattern of amendPatterns) {
      if (pattern.test(other.title) && otherRefs.some(ref => itemText.includes(ref.toLowerCase()))) {
        score += 40;
        relationship = 'amendment';
        break;
      }
    }
    
    // Category/tag overlap
    const itemCats = new Set([...(item.categories || []), ...(item.tags || [])]);
    const otherCats = new Set([...(other.categories || []), ...(other.tags || [])]);
    const overlap = [...itemCats].filter(c => otherCats.has(c)).length;
    score += overlap * 5;
    
    // Title similarity (simple word overlap)
    const itemWords = new Set(itemText.split(/\s+/).filter(w => w.length > 4));
    const otherWords = new Set(otherText.split(/\s+/).filter(w => w.length > 4));
    const wordOverlap = [...itemWords].filter(w => otherWords.has(w)).length;
    score += Math.min(wordOverlap * 2, 20);
    
    // Recency bonus for related items
    if (other.added || other.date) {
      const daysDiff = Math.abs(Date.now() - new Date(other.added || other.date).getTime()) / 86400000;
      if (daysDiff < 30) score += 10;
      else if (daysDiff < 90) score += 5;
    }
    
    if (score > 10) {
      scored.push({
        item: other,
        score,
        relationship: relationship || 'related'
      });
    }
  }
  
  // Sort by score and return top results
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
}

/**
 * Build context from related documents for AI analysis
 */
async function buildRelatedDocumentsContext(relatedDocs, options = {}) {
  const { fetchContent = false, maxContentPerDoc = 5000 } = options;
  
  if (!relatedDocs || relatedDocs.length === 0) {
    return { context: '', documents: [] };
  }
  
  const documents = [];
  const contextParts = [];
  
  for (let i = 0; i < relatedDocs.length; i++) {
    const { item, relationship } = relatedDocs[i];
    const refs = extractLegalReferences(`${item.title} ${item.summary || ''}`);
    
    let docInfo = {
      index: i + 1,
      title: item.title,
      url: item.url,
      date: item.added || item.date,
      relationship,
      references: refs
    };
    
    let contextEntry = `[Related Doc ${i + 1}] (${relationship})
Title: ${item.title}
Date: ${item.added || item.date || 'Unknown'}
URL: ${item.url}
Summary: ${(item.summary || '').slice(0, 500)}`;
    
    // Optionally fetch full content
    if (fetchContent && item.url) {
      const result = await fetchDocumentContent(item.url, { maxLength: maxContentPerDoc });
      if (result.success) {
        docInfo.content = result.content;
        docInfo.contentType = result.type;
        contextEntry += `\n\n[Full Content]\n${result.content.slice(0, maxContentPerDoc)}`;
      }
    }
    
    documents.push(docInfo);
    contextParts.push(contextEntry);
  }
  
  return {
    context: contextParts.join('\n\n---\n\n'),
    documents
  };
}

export {
  fetchDocumentContent,
  extractMainContent,
  extractPdfText,
  extractCelexId,
  extractLegalReferences,
  findRelatedDocuments,
  buildRelatedDocumentsContext,
  isPdfUrl,
  stripHtml
};

export default {
  fetchDocumentContent,
  extractMainContent,
  extractCelexId,
  extractLegalReferences,
  findRelatedDocuments,
  buildRelatedDocumentsContext
};


