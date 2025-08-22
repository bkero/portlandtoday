const xml2js = require('xml2js');

class RSSManager {
    constructor(db) {
        this.db = db;
        this.parser = new xml2js.Parser();
        this.articleSectionCache = new Map(); // Cache for articleSection lookups
    }

    async loadFeedsFromFile() {
        const fs = require('fs');
        try {
            const content = fs.readFileSync('rss-feeds.txt', 'utf8');
            const feeds = this.parseStructuredFeeds(content);
            
            for (const feed of feeds) {
                await this.db.addFeed(feed.url, feed.title, feed.category);
            }
            
            console.log(`Loaded ${feeds.length} feeds from file`);
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
            
            // Skip sections headers like "sources:" and "categories:"
            if (trimmedLine.endsWith(':') && !trimmedLine.startsWith('http')) {
                if (trimmedLine === 'categories:') {
                    // Stop processing when we reach categories section
                    break;
                }
                continue;
            }
            
            // Category headers (like "News:", "Advocacy:", etc.)
            if (trimmedLine.endsWith(':') && !trimmedLine.startsWith('http')) {
                currentCategory = trimmedLine.slice(0, -1).toLowerCase();
                continue;
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
        try {
            console.log(`Fetching feed: ${feedUrl}`);
            const { default: fetch } = await import('node-fetch');
            const response = await fetch(feedUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; PortlandToday/1.0)'
                }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const text = await response.text();
            return await this.parser.parseStringPromise(text);
        } catch (error) {
            console.error(`Error fetching feed ${feedUrl}:`, error.message);
            return null;
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
            return typeof field[0] === 'string' ? field[0] : field[0]._ || field[0];
        }
        if (typeof field === 'object' && field._) {
            return field._;
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
        // Special handling for oregonlive.com - fetch articleSection from page
        else if (link && typeof link === 'string' && link.includes('oregonlive.com')) {
            const articleSection = await this.fetchArticleSection(link);
            if (articleSection) {
                console.log(`Extracted articleSection "${articleSection}" from ${link}`);
                // Convert articleSection to tag format (lowercase, replace spaces with hyphens)
                urlCategory = articleSection.toLowerCase().replace(/\s+/g, '-').replace(/&/g, 'and');
                tags.push(urlCategory);
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
            'sports': ['game', 'player', 'team', 'score', 'championship', 'season', 'sports'],
            'technology': ['tech', 'software', 'app', 'digital', 'internet', 'computer', 'ai'],
            'business': ['business', 'economy', 'market', 'stock', 'company', 'financial'],
            'health': ['health', 'medical', 'hospital', 'doctor', 'medicine', 'covid'],
            'weather': ['weather', 'storm', 'rain', 'snow', 'temperature', 'forecast'],
            'local': ['portland', 'oregon', 'local', 'community', 'neighborhood'],
            'crime': ['police', 'arrest', 'crime', 'investigation', 'court', 'law'],
            'education': ['school', 'student', 'education', 'university', 'college', 'teacher'],
            'environment': ['environment', 'climate', 'green', 'sustainability', 'pollution']
        };

        Object.entries(tagKeywords).forEach(([tag, keywords]) => {
            if (keywords.some(keyword => text.includes(keyword))) {
                tags.push(tag);
            }
        });

        if (tags.length === 0) {
            tags.push('general');
        }

        return [...new Set(tags)];
    }

    async fetchArticleSection(link) {
        // Check cache first
        if (this.articleSectionCache.has(link)) {
            return this.articleSectionCache.get(link);
        }

        try {
            const { default: fetch } = await import('node-fetch');
            const response = await fetch(link, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; PortlandToday/1.0)'
                },
                timeout: 5000 // 5 second timeout
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const html = await response.text();
            
            // Look for articleSection in JSON-LD structured data
            const jsonLdMatch = html.match(/"articleSection"\s*:\s*"([^"]+)"/);
            if (jsonLdMatch) {
                const section = jsonLdMatch[1];
                this.articleSectionCache.set(link, section);
                return section;
            }

            // Fallback: look for meta property article:section
            const metaMatch = html.match(/<meta\s+property="article:section"\s+content="([^"]+)"/);
            if (metaMatch) {
                // Decode HTML entities like &amp;
                const section = metaMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
                this.articleSectionCache.set(link, section);
                return section;
            }

            // No section found
            this.articleSectionCache.set(link, null);
            return null;

        } catch (error) {
            console.error(`Error fetching articleSection from ${link}:`, error.message);
            this.articleSectionCache.set(link, null);
            return null;
        }
    }

    cleanText(text) {
        if (!text) return '';
        return text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    }
}

module.exports = RSSManager;