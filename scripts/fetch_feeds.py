#!/usr/bin/env python3
"""
Fetch RSS feeds and update docs/data/posts.json for the frontend.
This is a lightweight alternative to main.py that doesn't require email setup.
"""

import os
import sys
import json
import hashlib
from datetime import datetime, timezone
from pathlib import Path

import yaml
import feedparser

# Add project root to path
PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

def load_config():
    """Load config.yaml"""
    config_path = PROJECT_ROOT / "config.yaml"
    with open(config_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}

def generate_id(url: str) -> str:
    """Generate a stable ID from URL"""
    return hashlib.md5(url.encode()).hexdigest()[:16]

def keyword_match(text: str, keywords: list) -> tuple[bool, int, list]:
    """Check if text matches any keywords, return (matches, score, matched_keywords)"""
    if not keywords:
        return True, 0, []
    
    text_lower = text.lower()
    matched = []
    for kw in keywords:
        if kw.lower() in text_lower:
            matched.append(kw)
    
    return len(matched) > 0, len(matched), matched

def categorize(text: str, taxonomy: list) -> list:
    """Determine categories based on taxonomy rules"""
    categories = []
    text_lower = text.lower()
    
    for cat in taxonomy:
        name = cat.get("name", "Other")
        if name == "Other":
            continue
        includes = cat.get("include", [])
        for pattern in includes:
            if pattern.lower() in text_lower:
                categories.append(name)
                break
    
    if not categories:
        categories = ["Other"]
    
    return list(set(categories))

def fetch_feed(url: str) -> list:
    """Fetch and parse an RSS/Atom feed"""
    try:
        feed = feedparser.parse(url)
        entries = []
        
        for entry in feed.entries[:50]:  # Limit per feed
            title = entry.get("title", "")
            summary = entry.get("summary", "") or entry.get("description", "")
            link = entry.get("link", "")
            
            # Parse published date
            published = None
            if hasattr(entry, "published_parsed") and entry.published_parsed:
                try:
                    t = entry.published_parsed
                    published = datetime(*t[:6], tzinfo=timezone.utc)
                except Exception:
                    pass
            
            if not published:
                published = datetime.now(timezone.utc)
            
            entries.append({
                "title": title,
                "summary": summary,
                "url": link,
                "published": published,
                "feed_url": url,
                "text": f"{title} {summary}"
            })
        
        return entries
    except Exception as e:
        print(f"[error] Failed to fetch {url}: {e}")
        return []

def get_source_name(feed_url: str) -> str:
    """Extract a friendly source name from feed URL"""
    if "eur-lex.europa.eu" in feed_url:
        return "EUR-Lex"
    elif "ecb.europa.eu" in feed_url:
        return "ECB"
    elif "eba.europa.eu" in feed_url:
        return "EBA"
    elif "eiopa.europa.eu" in feed_url:
        return "EIOPA"
    elif "esma.europa.eu" in feed_url:
        return "ESMA"
    elif "europarl.europa.eu" in feed_url:
        return "European Parliament"
    elif "consilium.europa.eu" in feed_url:
        return "Council of the EU"
    else:
        return "Other"

def main():
    print("[fetch_feeds] Starting...")
    
    config = load_config()
    feeds = config.get("feeds", [])
    keywords = config.get("keywords", [])
    taxonomy = config.get("taxonomy", {}).get("categories", [])
    
    print(f"[fetch_feeds] Loaded {len(feeds)} feeds, {len(keywords)} keywords")
    
    # Fetch all feeds
    all_entries = []
    for i, feed_url in enumerate(feeds):
        print(f"[{i+1}/{len(feeds)}] Fetching {feed_url[:60]}...")
        entries = fetch_feed(feed_url)
        all_entries.extend(entries)
    
    print(f"[fetch_feeds] Fetched {len(all_entries)} total entries")
    
    # Filter by keywords and build posts
    posts = []
    seen_urls = set()
    
    for entry in all_entries:
        url = entry["url"]
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        
        # Check keyword match
        matches, score, matched_kws = keyword_match(entry["text"], keywords)
        
        # Include items that match keywords OR have no keywords configured
        if not matches and keywords:
            continue
        
        # Build post object
        source = get_source_name(entry["feed_url"])
        categories = categorize(entry["text"], taxonomy)
        
        post = {
            "id": generate_id(url),
            "source": source,
            "url": url,
            "title": entry["title"],
            "summary": entry["summary"][:500] if entry["summary"] else "",
            "tags": categories + ([source] if source not in categories else []),
            "categories": categories,
            "added": entry["published"].isoformat(),
            "score": score,
            "ts": int(entry["published"].timestamp())
        }
        posts.append(post)
    
    # Sort by date (newest first)
    posts.sort(key=lambda p: p["ts"], reverse=True)
    
    # Limit to most recent 200
    posts = posts[:200]
    
    print(f"[fetch_feeds] {len(posts)} posts after filtering")
    
    # Write to docs/data/posts.json
    output_path = PROJECT_ROOT / "docs" / "data" / "posts.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(posts, f, ensure_ascii=False, indent=2)
    
    print(f"[fetch_feeds] Written to {output_path}")
    
    # Print summary
    if posts:
        newest = posts[0]
        oldest = posts[-1]
        print(f"[fetch_feeds] Date range: {oldest['added'][:10]} to {newest['added'][:10]}")
        print(f"[fetch_feeds] Newest: {newest['title'][:60]}...")

if __name__ == "__main__":
    main()


