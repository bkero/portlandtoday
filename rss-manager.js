const xml2js = require('xml2js');

class RSSManager {
    constructor(db) {
        this.db = db;
        this.parser = new xml2js.Parser();
    }

    async loadFeedsFromFile() {
        const fs = require('fs');
        try {
            const content = fs.readFileSync('rss-feeds.txt', 'utf8');
            const feeds = this.parseStructuredFeeds(content);
            
            // Get current URLs from file
            const feedUrls = new Set(feeds.map(feed => feed.url));
            
            // Get all feeds currently in database
            const dbFeeds = await this.db.getFeeds();
            
            // Delete feeds that are no longer in the file
            let deletedCount = 0;
            for (const dbFeed of dbFeeds) {
                if (!feedUrls.has(dbFeed.url)) {
                    await this.db.deleteFeed(dbFeed.url);
                    deletedCount++;
                    console.log(`Removed feed: ${dbFeed.title} (${dbFeed.url})`);
                }
            }
            
            // Add/update feeds from file
            for (const feed of feeds) {
                await this.db.addFeed(feed.url, feed.title, feed.category);
                
                // Check if category changed and update existing articles
                const existingFeed = dbFeeds.find(dbFeed => dbFeed.url === feed.url);
                if (existingFeed && existingFeed.category !== feed.category) {
                    await this.db.updateFeedCategory(feed.url, feed.category);
                    await this.db.updateArticlesCategoryBySource(existingFeed.title, feed.category);
                    console.log(`Updated category for ${existingFeed.title} from "${existingFeed.category}" to "${feed.category}"`);
                }
            }
            
            console.log(`Loaded ${feeds.length} feeds from file, removed ${deletedCount} obsolete feeds`);
        } catch (error) {
            console.error('Error loading feeds from file:', error);
        }
    }

    parseStructuredFeeds(text) {
        const lines = text.split('\n');
        const feeds = [];
        let currentCategory = null;
        
        for (const line of lines) {
            const trimmedLine = line.trim();
            
            // Skip empty lines and comments
            if (!trimmedLine || trimmedLine.startsWith('#')) {
                continue;
            }
            
            // Process lines ending with ':' that aren't URLs
            if (trimmedLine.endsWith(':') && !trimmedLine.startsWith('http')) {
                if (trimmedLine === 'categories:') {
                    // Stop processing when we reach categories section
                    break;
                } else if (trimmedLine === 'sources:') {
                    // Skip the sources header
                    continue;
                } else {
                    // Category headers (like "News:", "Advocacy:", "/r/Portland:", etc.)
                    const rawCategory = trimmedLine.slice(0, -1);
                    // Preserve case for special categories like "/r/Portland"
                    currentCategory = rawCategory.startsWith('/r/') ? rawCategory : rawCategory.toLowerCase();
                    continue;
                }
            }
            
            // HTTP/HTTPS URLs
            if (trimmedLine.startsWith('http')) {
                feeds.push({
                    url: trimmedLine,
                    title: this.extractTitleFromUrl(trimmedLine),
                    category: currentCategory || 'general'
                });
            }
        }
        
        return feeds;
    }

    extractTitleFromUrl(url) {
        try {
            const urlObj = new URL(url);
            return urlObj.hostname.replace('www.', '');
        } catch {
            return url;
        }
    }

    async fetchFeed(feedUrl) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            console.log(`Fetching feed: ${feedUrl}`);
            const { default: fetch } = await import('node-fetch');
            const response = await fetch(feedUrl, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const MAX_BYTES = 5 * 1024 * 1024;
            const chunks = [];
            let totalBytes = 0;
            for await (const chunk of response.body) {
                totalBytes += chunk.length;
                if (totalBytes > MAX_BYTES) {
                    throw new Error(`Feed response exceeds 5MB limit: ${feedUrl}`);
                }
                chunks.push(chunk);
            }
            const text = Buffer.concat(chunks).toString('utf8');
            return await this.parser.parseStringPromise(text);
        } catch (error) {
            console.error(`Error fetching feed ${feedUrl}:`, error.message);
            return null;
        } finally {
            clearTimeout(timeout);
        }
    }

    async refreshAllFeeds() {
        const feeds = await this.db.getFeeds();
        console.log(`Refreshing ${feeds.length} feeds...`);
        
        for (const feed of feeds) {
            try {
                const feedData = await this.fetchFeed(feed.url);
                if (feedData) {
                    await this.processFeedData(feed, feedData);
                    await this.db.updateFeedLastUpdated(feed.id);
                }
            } catch (error) {
                console.error(`Error processing feed ${feed.url}:`, error);
            }
        }
        
        console.log('Feed refresh completed');
    }

    async processFeedData(feed, feedData) {
        const channel = feedData.rss?.channel?.[0] || feedData.feed || feedData;
        const items = channel.item || channel.entry || [];
        
        let processedCount = 0;
        
        for (const item of items) {
            try {
                const article = await this.parseArticle(item, feed);
                if (article) {
                    await this.db.addArticle(
                        feed.id,
                        article.title,
                        article.link,
                        article.description,
                        article.date,
                        article.category,
                        article.tags,
                        article.source
                    );
                    processedCount++;
                }
            } catch (error) {
                console.error('Error processing article:', error);
            }
        }
        
        console.log(`Processed ${processedCount} articles from ${feed.title}`);
    }

    async parseArticle(item, feed) {
        const title = this.extractText(item.title);
        const link = this.extractText(item.link) || this.extractText(item.guid);
        const description = this.extractText(item.description) || this.extractText(item.summary);
        const pubDate = this.extractText(item.pubDate) || this.extractText(item.published);
        const category = this.extractText(item.category);

        if (!title || !link) return null;

        const tags = await this.extractTags(title, description, category, feed.category, link);
        
        return {
            title: this.cleanText(title),
            link,
            description: this.cleanText(description) || '',
            date: pubDate ? new Date(pubDate) : new Date(),
            source: feed.title || 'Unknown Source',
            category: feed.category,
            tags
        };
    }

    extractText(field) {
        if (!field) return null;
        if (typeof field === 'string') return field;
        if (Array.isArray(field) && field.length > 0) {
            const firstItem = field[0];
            if (typeof firstItem === 'string') return firstItem;
            // Handle Atom link format: { '$': { href: 'url' } }
            if (firstItem && firstItem.$ && firstItem.$.href) return firstItem.$.href;
            return firstItem._ || firstItem;
        }
        if (typeof field === 'object' && field._) {
            return field._;
        }
        // Handle single Atom link format
        if (typeof field === 'object' && field.$ && field.$.href) {
            return field.$.href;
        }
        return null;
    }

    async extractTags(title, description, category, feedCategory, link) {
        const tags = [];
        let urlCategory = null;
        
        // Special handling for bikeportland.org - force bikeportland category
        if (link && typeof link === 'string' && link.includes('bikeportland.org')) {
            tags.push('bikeportland');
        }
        // Special handling for oregonlive.com - extract category from URL path
        else if (link && typeof link === 'string' && link.includes('oregonlive.com')) {
            try {
                const url = new URL(link);
                const pathSegments = url.pathname.split('/').filter(segment => segment.length > 0);
                if (pathSegments.length > 0) {
                    urlCategory = pathSegments[0];
                    if (urlCategory) {
                        tags.push(urlCategory);
                    }
                }
            } catch (error) {
                // URL parsing failed, continue without URL-based category
            }
        }
        // Special handling for wweek.com URLs - extract category from path
        else if (link && typeof link === 'string' && link.includes('wweek.com')) {
            try {
                const url = new URL(link);
                const pathSegments = url.pathname.split('/').filter(segment => segment.length > 0);
                if (pathSegments.length > 0) {
                    urlCategory = pathSegments[0];
                    if (urlCategory) {
                        tags.push(urlCategory); // Add URL category first for wweek.com
                    }
                }
            } catch (error) {
                // URL parsing failed, continue without URL-based category
            }
        }
        
        if (category && typeof category === 'string') {
            const lowerCategory = category.toLowerCase();
            // Filter out 'front page' category from bikeportland.org
            if (lowerCategory !== 'front page' && !tags.includes(lowerCategory)) {
                tags.push(lowerCategory);
            }
        }

        if (feedCategory && !tags.includes(feedCategory)) {
            tags.push(feedCategory);
        }

        const text = `${title} ${description}`.toLowerCase();
        
        const tagKeywords = {
            'politics': ['election', 'vote', 'government', 'politics', 'policy', 'congress', 'senate'],
            'sports': ['football', 'basketball', 'baseball', 'soccer', 'hockey', 'tennis', 'golf', 'volleyball', 'wrestling', 'track', 'swimming', 'championship', 'tournament', 'playoff', 'league', 'athlete', 'coach', 'stadium', 'sports', 'nfl', 'nba', 'mlb', 'mls', 'ncaa', 'ducks', 'beavers', 'blazers', 'timbers'],
            'technology': ['tech', 'software', 'app', 'digital', 'internet', 'computer', 'ai'],
            'business': ['business', 'economy', 'market', 'stock', 'company', 'financial'],
            'health': ['health', 'medical', 'hospital', 'doctor', 'medicine', 'covid'],
            'weather': ['weather', 'storm', 'rain', 'snow', 'temperature', 'forecast'],
            'news': ['portland', 'oregon', 'local', 'community', 'neighborhood', 'news'],
            'crime': ['police', 'arrest', 'crime', 'investigation', 'court', 'law'],
            'education': ['school', 'student', 'education', 'university', 'college', 'teacher'],
            'environment': ['environment', 'climate', 'green', 'sustainability', 'pollution'],
            'food': ['restaurant', 'food', 'dining', 'chef', 'menu', 'recipe', 'cooking', 'kitchen', 'bar', 'cafe', 'coffee', 'brewery', 'wine', 'drink', 'meal', 'eat', 'cuisine']
        };

        // Find content-based categories
        const contentTags = [];
        Object.entries(tagKeywords).forEach(([tag, keywords]) => {
            if (keywords.some(keyword => {
                // Use word boundary matching to prevent false positives
                // e.g., "app" should not match "appears", "ai" should not match "said"
                const wordBoundaryRegex = new RegExp(`\\b${keyword}\\b`, 'i');
                return wordBoundaryRegex.test(text);
            })) {
                contentTags.push(tag);
            }
        });

        // For Reddit /r/Portland feed, ensure the subreddit name is the primary tag
        if (feedCategory === '/r/Portland') {
            const redditTag = '/r/Portland';
            if (!tags.includes(redditTag)) {
                tags.unshift(redditTag);
            } else {
                const redditIndex = tags.indexOf(redditTag);
                if (redditIndex > 0) {
                    tags.splice(redditIndex, 1);
                    tags.unshift(redditTag);
                }
            }
        } else if (feedCategory === 'food') {
            // For food feeds, prioritize food category over content tags
            // Food-specific feeds should always show in the Food category
            if (!tags.includes('food')) {
                tags.unshift('food');
            } else {
                const foodIndex = tags.indexOf('food');
                if (foodIndex > 0) {
                    tags.splice(foodIndex, 1);
                    tags.unshift('food');
                }
            }
            // Add content tags after food tag
            if (contentTags.length > 0) {
                contentTags.forEach(contentTag => {
                    if (!tags.includes(contentTag)) {
                        tags.push(contentTag);
                    }
                });
            }
        } else if (urlCategory) {
            // URL-derived category (oregonlive, wweek) is the editorial section —
            // keep it pinned as primary and append content tags as secondary signals.
            const urlIndex = tags.indexOf(urlCategory);
            if (urlIndex > 0) {
                tags.splice(urlIndex, 1);
                tags.unshift(urlCategory);
            }
            contentTags.forEach(contentTag => {
                if (!tags.includes(contentTag)) tags.push(contentTag);
            });
        } else {
            // For other feeds, prioritize content-based categorization
            // Use the first content-based tag as primary, fallback to feed category
            if (contentTags.length > 0) {
                // Remove content tags from current position and add to front
                contentTags.forEach(contentTag => {
                    const index = tags.indexOf(contentTag);
                    if (index > -1) tags.splice(index, 1);
                });
                // Add content-based tags to the front
                tags.unshift(...contentTags);
            } else if (feedCategory && !tags.includes(feedCategory)) {
                // No content tags found, use feed category as fallback
                tags.unshift(feedCategory);
            } else if (feedCategory && tags.includes(feedCategory)) {
                // Move feed category to front if no content tags
                const feedIndex = tags.indexOf(feedCategory);
                if (feedIndex > 0) {
                    tags.splice(feedIndex, 1);
                    tags.unshift(feedCategory);
                }
            }
        }

        // Add remaining tags that weren't already included
        contentTags.forEach(tag => {
            if (!tags.includes(tag)) {
                tags.push(tag);
            }
        });

        if (tags.length === 0) {
            tags.push('general');
        }

        return [...new Set(tags)];
    }

    cleanText(text) {
        if (!text) return '';
        return text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    }
}

module.exports = RSSManager;