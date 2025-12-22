/**
 * Notification System - Polling timer, IndexedDB for lastSeen, and browser Notification API
 */

import settings from './settings.js';

const DB_NAME = 'eurlex_notifications';
const DB_VERSION = 1;
const STORE_NAME = 'seen_items';

let db = null;
let pollTimer = null;
let lastCheckTime = null;

/**
 * Initialize IndexedDB for storing seen items
 */
async function initDB() {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db);
    
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };
    
    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
  });
}

/**
 * Get all seen item IDs
 */
async function getSeenIds() {
  await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAllKeys();
    request.onsuccess = () => resolve(new Set(request.result));
    request.onerror = () => reject(request.error);
  });
}

/**
 * Mark items as seen
 */
async function markAsSeen(ids) {
  await initDB();
  const timestamp = Date.now();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const id of ids) {
      store.put({ id, timestamp });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Clean up old seen items (older than 30 days)
 */
async function cleanupOldItems() {
  await initDB();
  const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('timestamp');
    const range = IDBKeyRange.upperBound(cutoff);
    const request = index.openCursor(range);
    
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Get new item count since last visit
 */
async function getNewItemCount() {
  try {
    const seenIds = await getSeenIds();
    const response = await fetch('./data/posts.json?v=' + Date.now(), { cache: 'no-store' });
    if (!response.ok) return 0;
    
    const posts = await response.json();
    const enabledKeywords = settings.getEnabledKeywords();
    
    // Filter by keywords if any are set
    const relevant = posts.filter(post => {
      if (enabledKeywords.length === 0) return true;
      const text = `${post.title || ''} ${post.summary || ''} ${(post.tags || []).join(' ')}`.toLowerCase();
      return enabledKeywords.some(kw => text.includes(kw.term.toLowerCase()));
    });
    
    // Count unseen items
    const newItems = relevant.filter(p => !seenIds.has(p.url || p.id || p.title));
    return newItems.length;
  } catch (e) {
    console.warn('[notifications] Error getting new item count:', e);
    return 0;
  }
}

/**
 * Check for new items and show notification if any
 */
async function checkForNewItems() {
  const notifSettings = settings.getNotificationSettings();
  if (!notifSettings.enabled) return { newItems: [], count: 0 };
  
  try {
    const seenIds = await getSeenIds();
    const response = await fetch('./data/posts.json?v=' + Date.now(), { cache: 'no-store' });
    if (!response.ok) throw new Error('Failed to fetch posts');
    
    const posts = await response.json();
    const enabledKeywords = settings.getEnabledKeywords();
    const enabledCategories = settings.getEnabledCategories().map(c => c.name);
    
    // Filter by keywords
    const relevant = posts.filter(post => {
      // Keyword filter
      if (enabledKeywords.length > 0) {
        const text = `${post.title || ''} ${post.summary || ''} ${(post.tags || []).join(' ')}`.toLowerCase();
        if (!enabledKeywords.some(kw => text.includes(kw.term.toLowerCase()))) {
          return false;
        }
      }
      
      // Category filter
      if (enabledCategories.length < settings.getCategories().length) {
        const postCats = post.categories || ['Other'];
        if (!postCats.some(cat => enabledCategories.includes(cat))) {
          return false;
        }
      }
      
      return true;
    });
    
    // Find new items
    const newItems = relevant.filter(p => {
      const id = p.url || p.id || p.title;
      return !seenIds.has(id);
    });
    
    lastCheckTime = new Date();
    
    // Show notification if there are new items
    if (newItems.length > 0 && Notification.permission === 'granted') {
      showNotification(newItems);
    }
    
    // Dispatch event for UI updates
    window.dispatchEvent(new CustomEvent('eurlex:newItems', { 
      detail: { count: newItems.length, items: newItems.slice(0, 5) }
    }));
    
    return { newItems, count: newItems.length };
  } catch (e) {
    console.warn('[notifications] Check failed:', e);
    return { newItems: [], count: 0 };
  }
}

/**
 * Show browser notification for new items
 */
function showNotification(items) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  
  const count = items.length;
  const title = count === 1 
    ? 'New EUR-Lex Update'
    : `${count} New EUR-Lex Updates`;
  
  const body = count === 1
    ? items[0].title || 'New item available'
    : items.slice(0, 3).map(i => i.title || 'New item').join('\n');
  
  const notification = new Notification(title, {
    body,
    icon: './assets/icon.svg',
    badge: './assets/icon.svg',
    tag: 'eurlex-updates',
    renotify: true,
    data: { url: items.length === 1 ? items[0].url : './index.html' }
  });
  
  notification.onclick = function(event) {
    event.preventDefault();
    window.focus();
    if (this.data && this.data.url) {
      window.location.href = this.data.url;
    }
    notification.close();
  };
}

/**
 * Mark all current items as seen
 */
async function markAllAsSeen() {
  try {
    const response = await fetch('./data/posts.json?v=' + Date.now(), { cache: 'no-store' });
    if (!response.ok) return;
    
    const posts = await response.json();
    const ids = posts.map(p => p.url || p.id || p.title).filter(Boolean);
    await markAsSeen(ids);
    
    window.dispatchEvent(new CustomEvent('eurlex:newItems', { detail: { count: 0, items: [] } }));
  } catch (e) {
    console.warn('[notifications] Failed to mark as seen:', e);
  }
}

/**
 * Start polling timer
 */
function startPolling() {
  stopPolling();
  
  const notifSettings = settings.getNotificationSettings();
  if (!notifSettings.enabled) return;
  
  const intervalMs = notifSettings.pollIntervalMinutes * 60 * 1000;
  
  // Initial check after a short delay
  setTimeout(() => checkForNewItems(), 3000);
  
  // Set up recurring checks
  pollTimer = setInterval(() => {
    checkForNewItems();
  }, intervalMs);
  
  console.log(`[notifications] Polling started, interval: ${notifSettings.pollIntervalMinutes}min`);
}

/**
 * Stop polling timer
 */
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('[notifications] Polling stopped');
  }
}

/**
 * Request notification permission
 */
async function requestPermission() {
  if (!('Notification' in window)) {
    return 'unsupported';
  }
  
  if (Notification.permission === 'granted') {
    return 'granted';
  }
  
  if (Notification.permission === 'denied') {
    return 'denied';
  }
  
  return await Notification.requestPermission();
}

/**
 * Initialize notification system
 */
async function init() {
  try {
    await initDB();
    await cleanupOldItems();
    
    // Listen for settings changes
    settings.addListener((newSettings) => {
      if (newSettings.notifications.enabled) {
        startPolling();
      } else {
        stopPolling();
      }
    });
    
    // Start polling if enabled
    const notifSettings = settings.getNotificationSettings();
    if (notifSettings.enabled) {
      startPolling();
    }
    
    console.log('[notifications] Initialized');
  } catch (e) {
    console.error('[notifications] Init failed:', e);
  }
}

/**
 * Get notification badge count
 */
async function getBadgeCount() {
  const notifSettings = settings.getNotificationSettings();
  if (!notifSettings.showBadge) return 0;
  return await getNewItemCount();
}

// Export functions
export {
  init,
  checkForNewItems,
  markAllAsSeen,
  markAsSeen,
  getSeenIds,
  getNewItemCount,
  getBadgeCount,
  startPolling,
  stopPolling,
  requestPermission,
  lastCheckTime
};

export default {
  init,
  checkForNewItems,
  markAllAsSeen,
  markAsSeen,
  getSeenIds,
  getNewItemCount,
  getBadgeCount,
  startPolling,
  stopPolling,
  requestPermission
};

