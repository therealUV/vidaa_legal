"""
Simple backend server to fetch documents and bypass CORS restrictions.
Uses Playwright for JavaScript-rendered pages (like EUR-Lex with AWS WAF).
Run with: python backend/server.py
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import requests
from bs4 import BeautifulSoup
import io
import re
import asyncio
from urllib.parse import urlparse

app = Flask(__name__)
CORS(app)  # Enable CORS for all routes

# Allowed domains for security (prevent open proxy abuse)
ALLOWED_DOMAINS = [
    'eur-lex.europa.eu',
    'europa.eu',
    'europarl.europa.eu',
    'ec.europa.eu',
    'consilium.europa.eu',
    'curia.europa.eu',
    'edpb.europa.eu',
    'eba.europa.eu',
    'esma.europa.eu',
    'eiopa.europa.eu',
]

# Domains that require JavaScript rendering (AWS WAF protection)
JS_REQUIRED_DOMAINS = [
    'eur-lex.europa.eu',
]

def is_allowed_url(url):
    """Check if URL is from an allowed domain."""
    parsed = urlparse(url)
    return any(domain in parsed.netloc for domain in ALLOWED_DOMAINS)

def needs_js_rendering(url):
    """Check if URL requires JavaScript rendering."""
    parsed = urlparse(url)
    return any(domain in parsed.netloc for domain in JS_REQUIRED_DOMAINS)

def extract_html_content(html, url):
    """Extract main content from HTML page."""
    soup = BeautifulSoup(html, 'lxml')
    
    # Remove unwanted elements
    for tag in soup(['script', 'style', 'nav', 'footer', 'header', 'aside', 'noscript']):
        tag.decompose()
    
    # Try to find main content area (EUR-Lex specific selectors first)
    main_content = None
    selectors = [
        '.eli-main-body',      # EUR-Lex documents
        '#docHtml',            # EUR-Lex HTML view
        '.texte',              # EU official documents
        'article',
        'main',
        '[role="main"]',
        '.content',
        '#content',
    ]
    
    for selector in selectors:
        main_content = soup.select_one(selector)
        if main_content:
            break
    
    if not main_content:
        main_content = soup.body or soup
    
    # Extract text with structure
    text_parts = []
    
    # Get title
    title = soup.find('title')
    if title:
        text_parts.append(f"# {title.get_text().strip()}\n")
    
    # Process content
    for element in main_content.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'td', 'th']):
        text = element.get_text().strip()
        if len(text) > 10:  # Skip very short text
            if element.name.startswith('h'):
                level = int(element.name[1])
                text_parts.append(f"\n{'#' * level} {text}\n")
            elif element.name == 'li':
                text_parts.append(f"• {text}")
            else:
                text_parts.append(text)
    
    result = '\n'.join(text_parts)
    
    # Clean up whitespace
    result = re.sub(r'\n{3,}', '\n\n', result)
    result = re.sub(r' {2,}', ' ', result)
    
    return result.strip()

def extract_pdf_content(pdf_bytes):
    """Extract text from PDF using PyMuPDF (fitz)."""
    try:
        import fitz  # PyMuPDF
        
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        text_parts = []
        
        # Limit to first 50 pages for very long documents
        max_pages = min(len(doc), 50)
        
        for page_num in range(max_pages):
            page = doc[page_num]
            text = page.get_text()
            if text.strip():
                text_parts.append(f"\n--- Page {page_num + 1} ---\n{text}")
        
        doc.close()
        return '\n'.join(text_parts)
    except ImportError:
        return "[PDF extraction requires PyMuPDF. Install with: pip install PyMuPDF]"
    except Exception as e:
        return f"[PDF extraction failed: {str(e)}]"

async def fetch_with_playwright(url, timeout=60000):
    """Fetch page content using Playwright (handles JavaScript/AWS WAF)."""
    try:
        from playwright.async_api import async_playwright
        
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(
                user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            )
            page = await context.new_page()
            
            # Navigate and wait for content
            await page.goto(url, wait_until='networkidle', timeout=timeout)
            
            # Wait a bit more for any dynamic content
            await page.wait_for_timeout(2000)
            
            # Get the page content
            html = await page.content()
            
            await browser.close()
            return {'success': True, 'html': html}
    except Exception as e:
        return {'success': False, 'error': str(e)}

def fetch_with_playwright_sync(url, timeout=60000):
    """Synchronous wrapper for Playwright fetch."""
    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        result = loop.run_until_complete(fetch_with_playwright(url, timeout))
        loop.close()
        return result
    except Exception as e:
        return {'success': False, 'error': str(e)}

@app.route('/api/fetch-document', methods=['GET'])
def fetch_document():
    """Fetch a document from a URL and return its content."""
    url = request.args.get('url')
    
    if not url:
        return jsonify({'success': False, 'error': 'Missing url parameter'}), 400
    
    if not is_allowed_url(url):
        return jsonify({'success': False, 'error': 'URL domain not allowed'}), 403
    
    try:
        # Check if this domain requires JavaScript rendering (AWS WAF, etc.)
        if needs_js_rendering(url):
            print(f"[server] Using Playwright for JS-rendered page: {url}")
            result = fetch_with_playwright_sync(url, timeout=60000)
            
            if not result['success']:
                return jsonify({'success': False, 'error': f"Playwright fetch failed: {result['error']}"}), 502
            
            html = result['html']
            content = extract_html_content(html, url)
            
            return jsonify({
                'success': True,
                'content': content,
                'type': 'html',
                'url': url,
                'originalLength': len(content),
                'method': 'playwright'
            })
        
        # Standard fetch for other domains
        headers = {
            'User-Agent': 'Mozilla/5.0 (compatible; EURLexResearchFeed/1.0)',
            'Accept': 'text/html,application/xhtml+xml,application/pdf,*/*',
        }
        
        response = requests.get(url, headers=headers, timeout=30, allow_redirects=True)
        response.raise_for_status()
        
        content_type = response.headers.get('Content-Type', '').lower()
        
        if 'pdf' in content_type or url.lower().endswith('.pdf'):
            # Handle PDF
            content = extract_pdf_content(response.content)
            doc_type = 'pdf'
        else:
            # Handle HTML
            content = extract_html_content(response.text, url)
            doc_type = 'html'
        
        return jsonify({
            'success': True,
            'content': content,
            'type': doc_type,
            'url': response.url,  # Final URL after redirects
            'originalLength': len(content),
            'method': 'requests'
        })
        
    except requests.exceptions.Timeout:
        return jsonify({'success': False, 'error': 'Request timed out'}), 504
    except requests.exceptions.RequestException as e:
        return jsonify({'success': False, 'error': str(e)}), 502
    except Exception as e:
        return jsonify({'success': False, 'error': f'Unexpected error: {str(e)}'}), 500

@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint."""
    return jsonify({'status': 'ok'})

if __name__ == '__main__':
    print("🚀 Starting document fetch server on http://localhost:5001")
    print("📄 Endpoint: GET /api/fetch-document?url=<document_url>")
    print("✅ Allowed domains:", ', '.join(ALLOWED_DOMAINS))
    app.run(host='0.0.0.0', port=5001, debug=True)
