/**
 * Read Items Manager - IndexedDB storage for items marked as read by the user
 */

const DB_NAME = 'eurlex_read_items';
const DB_VERSION = 1;
const STORE_NAME = 'read_items';

let db = null;
let readItemsCache = new Set();

/**
 * Initialize IndexedDB for storing read items
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
 * Get all read item IDs
 */
async function getReadIds() {
  await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAllKeys();
    request.onsuccess = () => {
      readItemsCache = new Set(request.result);
      resolve(readItemsCache);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Check if an item is read (uses cache for performance)
 */
function isRead(id) {
  return readItemsCache.has(id);
}

/**
 * Mark a single item as read
 */
async function markAsRead(id) {
  await initDB();
  const timestamp = Date.now();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ id, timestamp });
    tx.oncomplete = () => {
      readItemsCache.add(id);
      window.dispatchEvent(new CustomEvent('eurlex:itemRead', { detail: { id } }));
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Mark multiple items as read
 */
async function markMultipleAsRead(ids) {
  await initDB();
  const timestamp = Date.now();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const id of ids) {
      store.put({ id, timestamp });
      readItemsCache.add(id);
    }
    tx.oncomplete = () => {
      window.dispatchEvent(new CustomEvent('eurlex:itemsRead', { detail: { ids } }));
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Mark an item as unread
 */
async function markAsUnread(id) {
  await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(id);
    tx.oncomplete = () => {
      readItemsCache.delete(id);
      window.dispatchEvent(new CustomEvent('eurlex:itemUnread', { detail: { id } }));
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Clear all read items
 */
async function clearAllRead() {
  await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    tx.oncomplete = () => {
      readItemsCache.clear();
      window.dispatchEvent(new CustomEvent('eurlex:readCleared'));
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Get count of read items
 */
async function getReadCount() {
  await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Clean up old read items (older than 90 days)
 */
async function cleanupOldItems() {
  await initDB();
  const cutoff = Date.now() - (90 * 24 * 60 * 60 * 1000);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('timestamp');
    const range = IDBKeyRange.upperBound(cutoff);
    const request = index.openCursor(range);
    
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        readItemsCache.delete(cursor.primaryKey);
        cursor.delete();
        cursor.continue();
      }
    };
    
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Initialize read items manager
 */
async function init() {
  try {
    await initDB();
    await getReadIds(); // Populate cache
    await cleanupOldItems();
    console.log('[read-items] Initialized, cached', readItemsCache.size, 'read items');
  } catch (e) {
    console.error('[read-items] Init failed:', e);
  }
}

export {
  init,
  getReadIds,
  isRead,
  markAsRead,
  markMultipleAsRead,
  markAsUnread,
  clearAllRead,
  getReadCount
};

export default {
  init,
  getReadIds,
  isRead,
  markAsRead,
  markMultipleAsRead,
  markAsUnread,
  clearAllRead,
  getReadCount
};
