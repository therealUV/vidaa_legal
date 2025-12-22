/**
 * AI Module - OpenAI integration for answering questions about feed items
 * Enhanced with full document extraction and legal compliance analysis
 * Updated to use GPT-5.2 with Responses API for reasoning support
 */

import settings from './settings.js';
import { 
  fetchDocumentContent, 
  extractLegalReferences, 
  findRelatedDocuments,
  buildRelatedDocumentsContext 
} from './doc-extractor.js';

// Chat Completions API (for non-reasoning models)
const OPENAI_CHAT_API_URL = 'https://api.openai.com/v1/chat/completions';
// Responses API (for GPT-5.2 with reasoning)
const OPENAI_RESPONSES_API_URL = 'https://api.openai.com/v1/responses';

/**
 * Get the OpenAI API key from settings
 */
function getApiKey() {
  const s = settings.get();
  return s.openai?.apiKey || localStorage.getItem('OPENAI_API_KEY') || '';
}

/**
 * Check if AI is configured
 */
function isConfigured() {
  return !!getApiKey();
}

/**
 * Parse model string to extract model name and reasoning effort
 * Supports format: "gpt-5.2:reasoning=medium" -> { model: "gpt-5.2", reasoningEffort: "medium" }
 */
function parseModelString(modelString) {
  const parts = modelString.split(':');
  const model = parts[0];
  let reasoningEffort = null;
  
  if (parts[1] && parts[1].startsWith('reasoning=')) {
    reasoningEffort = parts[1].replace('reasoning=', '');
  }
  
  return { model, reasoningEffort };
}

/**
 * Call OpenAI Responses API (for GPT-5.2 with reasoning)
 * @see https://platform.openai.com/docs/guides/reasoning
 */
async function callResponsesAPI({ model, systemPrompt, userPrompt, reasoningEffort = 'medium', maxTokens = 4000 }) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('OpenAI API key not configured');
  }

  const requestBody = {
    model,
    input: [
      { role: 'developer', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    reasoning: { effort: reasoningEffort }
  };

  // Add max_output_tokens only for 'none' reasoning (per GPT-5.2 docs)
  // For other reasoning levels, the model controls output length
  if (reasoningEffort === 'none') {
    requestBody.max_output_tokens = maxTokens;
  }

  const response = await fetch(OPENAI_RESPONSES_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    if (response.status === 401) {
      throw new Error('Invalid API key. Please check your OpenAI API key in Settings.');
    }
    throw new Error(error.error?.message || `API error: ${response.status}`);
  }

  const data = await response.json();
  
  // Responses API returns output array with message items
  const outputMessage = data.output?.find(item => item.type === 'message');
  const content = outputMessage?.content?.find(c => c.type === 'output_text');
  
  return {
    content: content?.text || '',
    model,
    usage: data.usage
  };
}

/**
 * Build context from feed items for the AI
 */
function buildContext(items, maxItems = 10) {
  const relevant = items.slice(0, maxItems);
  return relevant.map((item, i) => {
    const date = item.added || item.date || '';
    return `[${i + 1}] ${item.title}\nSource: ${item.source || 'Unknown'}\nDate: ${date}\nSummary: ${(item.summary || '').slice(0, 300)}`;
  }).join('\n\n');
}

/**
 * Ask AI a question about the feed items
 */
async function askQuestion(question, items, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('OpenAI API key not configured. Go to Settings to add your API key.');
  }

  const context = buildContext(items, options.maxItems || 15);
  const { model, reasoningEffort } = parseModelString(options.model || 'gpt-4o-mini');

  const systemPrompt = `You are a helpful assistant that answers questions about EU regulatory news and legal updates. 
You have access to the following recent feed items:

${context}

Instructions:
- Answer the user's question based on the feed items provided
- Cite sources by referring to item numbers like [1], [2], etc.
- If the answer isn't in the provided items, say so
- Be concise but thorough
- Focus on factual information from the sources`;

  const requestBody = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: question }
    ],
    temperature: 0.3,
    max_tokens: 1000
  };
  
  // Add reasoning_effort for o-series reasoning models
  if (reasoningEffort) {
    requestBody.reasoning_effort = reasoningEffort;
  }

  try {
    const response = await fetch(OPENAI_CHAT_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      if (response.status === 401) {
        throw new Error('Invalid API key. Please check your OpenAI API key in Settings.');
      }
      throw new Error(error.error?.message || `API error: ${response.status}`);
    }

    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content || 'No response from AI';

    return {
      answer,
      model,
      usage: data.usage
    };
  } catch (e) {
    if (e.message.includes('API key')) {
      throw e;
    }
    throw new Error(`AI request failed: ${e.message}`);
  }
}

/**
 * Summarize a single item with full document context
 * Uses GPT-5.2 with Responses API for reasoning support
 */
async function summarizeItem(item, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('OpenAI API key not configured');
  }

  const { model, reasoningEffort } = parseModelString(options.model || 'gpt-5.2:reasoning=low');
  
  // Fetch full document content for better summarization
  let documentContent = item.summary || item.description || '';
  let contentSource = 'summary';
  
  if (item.url) {
    try {
      const result = await fetchDocumentContent(item.url, { 
        maxLength: 40000,  // ~10k tokens for summarization
        timeout: 30000 
      });
      
      if (result.success && result.content.length > documentContent.length) {
        documentContent = result.content;
        contentSource = result.type;
      }
    } catch (e) {
      console.warn('[ai] Could not fetch full content for summarization:', e);
    }
  }
  
  const userPrompt = `DOCUMENT TITLE: ${item.title}
SOURCE: ${item.source || 'Unknown'}
DATE: ${item.added || item.date || 'Unknown'}
URL: ${item.url || 'N/A'}

DOCUMENT CONTENT:
${documentContent.slice(0, 35000)}${documentContent.length > 35000 ? '\n\n[Content truncated]' : ''}`;

  const systemPrompt = `You are an EU regulatory analyst. Summarize this document in exactly 2 short paragraphs:

Paragraph 1: What this document is and its main requirements.
Paragraph 2: Who is affected and key dates/deadlines.

Be concise. No bullet points.`;

  try {
    // Use Responses API for GPT-5.2 with low reasoning (faster)
    const result = await callResponsesAPI({
      model,
      systemPrompt,
      userPrompt,
      reasoningEffort: reasoningEffort || 'low',
      maxTokens: 500
    });
    
    return result.content;
  } catch (e) {
    console.warn('[ai] Summarize failed:', e);
    throw e;
  }
}

/**
 * Generate comprehensive legal compliance action items for VIDAA
 * Enhanced with full document extraction, related document analysis, and detailed compliance checklists
 */
async function generateActionItems(item, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('OpenAI API key not configured');
  }

  // Use GPT-5.2 with low reasoning for faster, more concise analysis
  const defaultModel = 'gpt-5.2:reasoning=low';
  const { model, reasoningEffort } = parseModelString(options.model || defaultModel);
  const { allItems = [], fetchFullContent = true, fetchRelatedContent = false } = options;
  
  const itemDate = item.added || item.date || '';
  
  // Progress callback for UI updates
  const onProgress = options.onProgress || (() => {});
  
  // Step 1: Fetch full document content
  onProgress('Fetching full document content...');
  let fullContent = '';
  let contentSource = 'summary';
  
  if (fetchFullContent && item.url) {
    try {
      const result = await fetchDocumentContent(item.url, { 
        maxLength: 80000,  // ~20k tokens worth of text
        timeout: 45000 
      });
      
      if (result.success) {
        fullContent = result.content;
        contentSource = result.type;
        onProgress(`Document loaded (${result.type}, ${Math.round(result.originalLength / 1000)}k chars)`);
      } else {
        console.warn('[ai] Could not fetch full content:', result.error);
        fullContent = item.summary || item.description || '';
      }
    } catch (e) {
      console.warn('[ai] Document fetch failed:', e);
      fullContent = item.summary || item.description || '';
    }
  } else {
    fullContent = item.summary || item.description || '';
  }
  
  // Step 2: Find and analyze related documents
  onProgress('Finding related regulations...');
  let relatedContext = '';
  let relatedDocs = [];
  
  if (allItems.length > 0) {
    relatedDocs = findRelatedDocuments(item, allItems, { maxResults: 5 });
    
    if (relatedDocs.length > 0) {
      const related = await buildRelatedDocumentsContext(relatedDocs, {
        fetchContent: fetchRelatedContent,
        maxContentPerDoc: 3000
      });
      relatedContext = related.context;
      onProgress(`Found ${relatedDocs.length} related document(s)`);
    }
  }
  
  // Step 3: Extract legal references from the document
  const legalRefs = extractLegalReferences(fullContent);
  const refsContext = legalRefs.length > 0 
    ? `\n\nLEGAL REFERENCES DETECTED:\n${legalRefs.map(r => `• ${r}`).join('\n')}`
    : '';
  
  // Step 4: Build the comprehensive prompt
  onProgress('Analyzing document...');
  
  const systemPrompt = `You are a regulatory analyst for VIDAA, a Smart TV operating system.

VIDAA'S BUSINESS:
• Smart TV OS with millions of devices globally
• Revenue: Advertising (programmatic ads, addressable TV), streaming partnerships, app store, data licensing
• Operations: User data collection, content recommendations, ad targeting, device telemetry

YOUR JOB:
Analyze EU regulations and explain how they affect VIDAA specifically.
Be concise but include VIDAA-specific context.

OUTPUT RULES:
• Executive Summary: 2-3 sentences. What is this? How does it affect VIDAA specifically?
• Action Items: 3-5 bullet points. What should VIDAA do? Be specific to their business.
• Use simple language. No legal jargon.`;

  const userPrompt = `ANALYZE THIS DOCUMENT FOR VIDAA:

Title: ${item.title}
Content:
${fullContent.slice(0, 40000)}

---
OUTPUT FORMAT:

## 📋 EXECUTIVE SUMMARY
[2-3 sentences: What is this regulation? How does it specifically affect VIDAA's Smart TV OS, advertising, data, or content business?]

## 🎯 ACTION ITEMS
[3-5 bullet points. Be specific to VIDAA's business. Example: "Update TV ad consent flows" not just "Update consent"]

If the document is NOT relevant to Smart TV, advertising, data, or content platforms, just say:
## 📋 EXECUTIVE SUMMARY
Not directly relevant to VIDAA's Smart TV business.

## 🎯 ACTION ITEMS
• Monitor only - no immediate action needed.`;

  try {
    // Use Responses API for GPT-5.2 with reasoning
    const result = await callResponsesAPI({
      model,
      systemPrompt,
      userPrompt,
      reasoningEffort: 'low',
      maxTokens: 500
    });
    
    onProgress('Analysis complete');
    
    return {
      analysis: result.content,
      metadata: {
        model,
        contentSource,
        documentLength: fullContent.length,
        relatedDocuments: relatedDocs.map(d => ({
          title: d.item.title,
          relationship: d.relationship,
          url: d.item.url
        })),
        legalReferences: legalRefs,
        usage: result.usage
      }
    };
  } catch (e) {
    console.error('[ai] Action items failed:', e);
    throw e;
  }
}

/**
 * Legacy wrapper for backward compatibility
 * Returns just the analysis string for existing UI code
 */
async function generateActionItemsLegacy(item, options = {}) {
  const result = await generateActionItems(item, options);
  return typeof result === 'string' ? result : result.analysis;
}

/**
 * Get key insights from multiple items
 */
async function getInsights(items, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('OpenAI API key not configured');
  }

  const context = buildContext(items, 20);
  const { model, reasoningEffort } = parseModelString(options.model || 'gpt-4o-mini');

  const requestBody = {
    model,
    messages: [
      { 
        role: 'system', 
        content: `Analyze these EU regulatory news items and provide:
1. Key themes (2-3 main topics)
2. Important developments (what's new or changing)
3. Items requiring attention (deadlines, consultations, etc.)

Be concise. Use bullet points. Cite item numbers.` 
      },
      { role: 'user', content: context }
    ],
    temperature: 0.3,
    max_tokens: 500
  };
  
  // Add reasoning_effort for o-series reasoning models
  if (reasoningEffort) {
    requestBody.reasoning_effort = reasoningEffort;
  }

  try {
    const response = await fetch(OPENAI_CHAT_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (e) {
    console.warn('[ai] Insights failed:', e);
    return '';
  }
}

export { 
  askQuestion, 
  summarizeItem, 
  generateActionItems, 
  generateActionItemsLegacy,
  getInsights, 
  isConfigured, 
  getApiKey 
};

export default { 
  askQuestion, 
  summarizeItem, 
  generateActionItems,
  generateActionItemsLegacy,
  getInsights, 
  isConfigured, 
  getApiKey 
};

