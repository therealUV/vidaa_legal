/**
 * Settings Manager - localStorage-based persistence for user preferences
 */

const STORAGE_KEY = 'eurlex_settings';

// Default settings structure
const DEFAULT_SETTINGS = {
  feeds: [
    { id: 'eurlex-oj-l', url: 'https://eur-lex.europa.eu/legal-content/EN/RSS/?uri=OJ:L', name: 'EUR-Lex Official Journal L', enabled: true },
    { id: 'eurlex-oj-c', url: 'https://eur-lex.europa.eu/legal-content/EN/RSS/?uri=OJ:C', name: 'EUR-Lex Official Journal C', enabled: true },
    { id: 'ecb-press', url: 'https://www.ecb.europa.eu/rss/press.html', name: 'ECB Press Releases', enabled: true },
    { id: 'ecb-blog', url: 'https://www.ecb.europa.eu/rss/blog.html', name: 'ECB Blog', enabled: true },
    { id: 'eba-news', url: 'https://www.eba.europa.eu/news-press/news/rss.xml', name: 'EBA News', enabled: true },
    { id: 'europarl-press', url: 'https://www.europarl.europa.eu/rss/doc/press-releases/en.xml', name: 'European Parliament Press', enabled: true },
    { id: 'council-press', url: 'https://www.consilium.europa.eu/en/rss/pressreleases.ashx', name: 'Council of the EU Press', enabled: true },
  ],
  keywords: [
    { id: 'kw-cmu', term: 'CMU', enabled: true },
    { id: 'kw-capital-markets', term: 'capital markets union', enabled: true },
    { id: 'kw-mifid', term: 'MiFID', enabled: true },
    { id: 'kw-mifir', term: 'MiFIR', enabled: true },
    { id: 'kw-emir', term: 'EMIR', enabled: true },
    { id: 'kw-ai', term: 'AI', enabled: true },
    { id: 'kw-ai-act', term: 'AI Act', enabled: true },
    { id: 'kw-dora', term: 'DORA', enabled: true },
    { id: 'kw-mica', term: 'MiCA', enabled: true },
    { id: 'kw-aml', term: 'AML', enabled: true },
    { id: 'kw-defence', term: 'defence', enabled: true },
    { id: 'kw-ecb', term: 'ECB', enabled: true },
    { id: 'kw-esma', term: 'ESMA', enabled: true },
  ],
  categories: [
    { id: 'cat-cmu', name: 'CMU & Financial Markets', enabled: true },
    { id: 'cat-ai', name: 'AI & Digital', enabled: true },
    { id: 'cat-defence', name: 'Defence & Security', enabled: true },
    { id: 'cat-derisking', name: 'De-risking & Investment', enabled: true },
    { id: 'cat-other', name: 'Other', enabled: true },
  ],
  notifications: {
    enabled: false,
    pollIntervalMinutes: 15,
    soundEnabled: false,
    showBadge: true,
  },
  openai: {
    apiKey: '',
    model: 'gpt-4o-mini',
  },
  lastExport: null,
  version: 1,
};

/**
 * Settings class for managing user preferences
 */
class SettingsManager {
  constructor() {
    this._settings = null;
    this._listeners = new Set();
  }

  /**
   * Load settings from localStorage, merging with defaults
   */
  load() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        // Merge with defaults to handle new fields
        this._settings = this._mergeWithDefaults(parsed);
      } else {
        this._settings = { ...DEFAULT_SETTINGS };
      }
    } catch (e) {
      console.warn('[settings] Failed to load, using defaults:', e);
      this._settings = { ...DEFAULT_SETTINGS };
    }
    return this._settings;
  }

  /**
   * Merge stored settings with defaults (preserves user data, adds new fields)
   */
  _mergeWithDefaults(stored) {
    return {
      feeds: stored.feeds || DEFAULT_SETTINGS.feeds,
      keywords: stored.keywords || DEFAULT_SETTINGS.keywords,
      categories: this._mergeCategories(stored.categories),
      notifications: { ...DEFAULT_SETTINGS.notifications, ...(stored.notifications || {}) },
      openai: { ...DEFAULT_SETTINGS.openai, ...(stored.openai || {}) },
      lastExport: stored.lastExport || null,
      version: DEFAULT_SETTINGS.version,
    };
  }

  _mergeCategories(storedCats) {
    if (!storedCats) return DEFAULT_SETTINGS.categories;
    // Ensure all default categories exist
    const catMap = new Map(storedCats.map(c => [c.id, c]));
    return DEFAULT_SETTINGS.categories.map(defCat => 
      catMap.has(defCat.id) ? catMap.get(defCat.id) : defCat
    );
  }

  /**
   * Save current settings to localStorage
   */
  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._settings));
      this._notifyListeners();
    } catch (e) {
      console.error('[settings] Failed to save:', e);
    }
  }

  /**
   * Get all settings
   */
  get() {
    if (!this._settings) this.load();
    return this._settings;
  }

  /**
   * Update settings and save
   */
  update(partial) {
    if (!this._settings) this.load();
    this._settings = { ...this._settings, ...partial };
    this.save();
    return this._settings;
  }

  // --- Feeds ---
  getFeeds() {
    return this.get().feeds;
  }

  getEnabledFeeds() {
    return this.getFeeds().filter(f => f.enabled);
  }

  addFeed(url, name) {
    const feeds = [...this.getFeeds()];
    const id = 'feed-' + Date.now();
    feeds.push({ id, url, name: name || url, enabled: true });
    this.update({ feeds });
    return id;
  }

  updateFeed(id, updates) {
    const feeds = this.getFeeds().map(f => 
      f.id === id ? { ...f, ...updates } : f
    );
    this.update({ feeds });
  }

  removeFeed(id) {
    const feeds = this.getFeeds().filter(f => f.id !== id);
    this.update({ feeds });
  }

  toggleFeed(id) {
    const feeds = this.getFeeds().map(f =>
      f.id === id ? { ...f, enabled: !f.enabled } : f
    );
    this.update({ feeds });
  }

  // --- Keywords ---
  getKeywords() {
    return this.get().keywords;
  }

  getEnabledKeywords() {
    return this.getKeywords().filter(k => k.enabled);
  }

  addKeyword(term) {
    const keywords = [...this.getKeywords()];
    const id = 'kw-' + Date.now();
    keywords.push({ id, term, enabled: true });
    this.update({ keywords });
    return id;
  }

  updateKeyword(id, updates) {
    const keywords = this.getKeywords().map(k =>
      k.id === id ? { ...k, ...updates } : k
    );
    this.update({ keywords });
  }

  removeKeyword(id) {
    const keywords = this.getKeywords().filter(k => k.id !== id);
    this.update({ keywords });
  }

  toggleKeyword(id) {
    const keywords = this.getKeywords().map(k =>
      k.id === id ? { ...k, enabled: !k.enabled } : k
    );
    this.update({ keywords });
  }

  // --- Categories ---
  getCategories() {
    return this.get().categories;
  }

  getEnabledCategories() {
    return this.getCategories().filter(c => c.enabled);
  }

  toggleCategory(id) {
    const categories = this.getCategories().map(c =>
      c.id === id ? { ...c, enabled: !c.enabled } : c
    );
    this.update({ categories });
  }

  // --- Notifications ---
  getNotificationSettings() {
    return this.get().notifications;
  }

  updateNotificationSettings(updates) {
    const notifications = { ...this.getNotificationSettings(), ...updates };
    this.update({ notifications });
  }

  // --- OpenAI ---
  getOpenAISettings() {
    return this.get().openai || { apiKey: '', model: 'gpt-4o-mini' };
  }

  updateOpenAISettings(updates) {
    const openai = { ...this.getOpenAISettings(), ...updates };
    this.update({ openai });
  }

  isAIConfigured() {
    const { apiKey } = this.getOpenAISettings();
    return !!apiKey;
  }

  // --- Import/Export ---
  exportSettings() {
    const settings = this.get();
    settings.lastExport = new Date().toISOString();
    this.save();
    return JSON.stringify(settings, null, 2);
  }

  importSettings(jsonString) {
    try {
      const imported = JSON.parse(jsonString);
      // Validate structure
      if (!imported.feeds || !imported.keywords) {
        throw new Error('Invalid settings format');
      }
      this._settings = this._mergeWithDefaults(imported);
      this.save();
      return true;
    } catch (e) {
      console.error('[settings] Import failed:', e);
      return false;
    }
  }

  // --- Reset ---
  reset() {
    this._settings = { ...DEFAULT_SETTINGS };
    this.save();
  }

  // --- Listeners ---
  addListener(fn) {
    this._listeners.add(fn);
  }

  removeListener(fn) {
    this._listeners.delete(fn);
  }

  _notifyListeners() {
    for (const fn of this._listeners) {
      try { fn(this._settings); } catch (e) { console.error(e); }
    }
  }

  // --- Keyword Matching Utility ---
  matchesKeywords(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    const enabledKws = this.getEnabledKeywords();
    if (enabledKws.length === 0) return true; // No keywords = show all
    return enabledKws.some(kw => lower.includes(kw.term.toLowerCase()));
  }

  matchesCategories(itemCategories) {
    const enabledCats = this.getEnabledCategories().map(c => c.name);
    if (enabledCats.length === this.getCategories().length) return true; // All enabled
    if (!itemCategories || itemCategories.length === 0) return enabledCats.includes('Other');
    return itemCategories.some(cat => enabledCats.includes(cat));
  }
}

// Singleton instance
const settings = new SettingsManager();

// Export for use in other modules
export { settings, DEFAULT_SETTINGS };
export default settings;

