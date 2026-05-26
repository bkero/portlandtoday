const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const DatabaseManager = require('./database');
const RSSManager = require('./rss-manager');

const STATIC_ROOT = path.resolve(__dirname);
const ALLOWED_STATIC = new Set(['index.html', 'app.js', 'styles.css']);

class NewsServer {
    constructor() {
        this.db = new DatabaseManager();
        this.rssManager = null;
        this.isInitialized = false;
        this.lastRefresh = 0;
        this.weatherCache = {
            data: null,
            timestamp: 0,
            cacheTime: 10 * 60 * 1000 // 10 minutes
        };
    }

    async initialize() {
        try {
            await this.db.initialize();
            this.rssManager = new RSSManager(this.db);

            // Load feeds from file on startup
            await this.rssManager.loadFeedsFromFile();

            // Refresh feeds every hour
            this.refreshInterval = setInterval(() => {
                this.rssManager.refreshAllFeeds().catch(console.error);
            }, 60 * 60 * 1000); // 1 hour

            // Initial refresh
            setTimeout(() => {
                this.rssManager.refreshAllFeeds().catch(console.error);
            }, 2000); // Wait 2 seconds after startup

            this.isInitialized = true;
            console.log('News server initialized successfully');
        } catch (error) {
            console.error('Failed to initialize server:', error);
            process.exit(1);
        }
    }

    handleRequest(req, res) {
        const parsedUrl = url.parse(req.url, true);
        const pathname = parsedUrl.pathname;

        // Security headers on every response
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.setHeader('Content-Security-Policy',
            "default-src 'self'; script-src 'self'; style-src 'self'; " +
            "img-src 'none'; connect-src 'self'; frame-ancestors 'none'; " +
            "object-src 'none'; base-uri 'self'; form-action 'self'");

        // CORS: allow same origin for GET reads; POST endpoints enforce token auth separately
        res.setHeader('Access-Control-Allow-Origin', 'https://pdx.today');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        // Health check (used by Kubernetes liveness/readiness probes)
        if (pathname === '/healthz') {
            res.writeHead(this.isInitialized ? 200 : 503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: this.isInitialized ? 'ok' : 'initializing' }));
            return;
        }

        // RSS feed endpoint
        if (pathname === '/rss' || pathname === '/feed.xml') {
            this.handleRSSRequest(req, res);
            return;
        }

        // API endpoints
        if (pathname.startsWith('/api/')) {
            this.handleApiRequest(req, res, pathname, parsedUrl.query);
            return;
        }

        // Static file serving
        this.serveStaticFile(req, res, pathname);
    }

    async handleApiRequest(req, res, pathname, query) {
        if (!this.isInitialized) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Server not initialized' }));
            return;
        }

        try {
            if (pathname === '/api/articles') {
                // Clamp limit: minimum 1, maximum 500, default 100.
                // parseInt('-1') is truthy so || fallback would allow LIMIT -1 (all rows).
                const limit = Math.min(Math.max(parseInt(query.limit) || 100, 1), 500);
                const articles = await this.db.getArticles(limit);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(articles));
            } else if (pathname === '/api/feeds') {
                const feeds = await this.db.getFeeds();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(feeds));
            } else if (pathname === '/api/weather') {
                const weather = await this.getWeather();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(weather));
            } else if (pathname === '/api/refresh' && req.method === 'POST') {
                // If REFRESH_TOKEN env var is set, require a matching Bearer token.
                const expectedToken = process.env.REFRESH_TOKEN;
                if (expectedToken) {
                    const authHeader = req.headers['authorization'] || '';
                    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
                    if (provided !== expectedToken) {
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Unauthorized' }));
                        return;
                    }
                }
                // Debounce: refuse if a refresh ran in the last 5 minutes.
                const now = Date.now();
                const cooldownMs = 5 * 60 * 1000;
                if (now - this.lastRefresh < cooldownMs) {
                    res.writeHead(429, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Refresh cooldown active, try again later' }));
                    return;
                }
                this.lastRefresh = now;
                this.rssManager.refreshAllFeeds().catch(console.error);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Refresh started' }));
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'API endpoint not found' }));
            }
        } catch (error) {
            console.error('API error:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
    }

    async handleRSSRequest(req, res) {
        if (!this.isInitialized) {
            res.writeHead(503, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
            res.end('<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Error</title><description>Server not initialized</description></channel></rss>');
            return;
        }

        try {
            const rssXml = await this.generateRSSFeed();
            res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
            res.end(rssXml);
        } catch (error) {
            console.error('RSS request error:', error);
            res.writeHead(500, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
            res.end('<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Error</title><description>RSS feed temporarily unavailable</description></channel></rss>');
        }
    }

    serveStaticFile(req, res, pathname) {
        // Resolve the requested path and confirm it stays inside the web root.
        // path.resolve normalises any '..' sequences before the check.
        const requestedPath = path.resolve(STATIC_ROOT, '.' + pathname);
        const filename = pathname === '/' ? 'index.html' : path.basename(requestedPath);

        if (!requestedPath.startsWith(STATIC_ROOT + path.sep) && requestedPath !== STATIC_ROOT) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        // Serve only an explicit allowlist of files.
        if (!ALLOWED_STATIC.has(filename)) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }

        const filePath = path.join(STATIC_ROOT, filename);
        const extname = path.extname(filePath).toLowerCase();
        const mimeTypes = {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.css': 'text/css',
        };
        const contentType = mimeTypes[extname] || 'application/octet-stream';

        fs.readFile(filePath, (error, content) => {
            if (error) {
                if (error.code === 'ENOENT') {
                    res.writeHead(404);
                    res.end('File not found');
                } else {
                    res.writeHead(500);
                    res.end('Server error');
                }
            } else {
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(content, 'utf-8');
            }
        });
    }

    start(port = 3000) {
        const server = http.createServer((req, res) => {
            this.handleRequest(req, res);
        });

        server.listen(port, () => {
            console.log(`Server running at http://localhost:${port}/`);
        });

        // Graceful shutdown
        process.on('SIGINT', () => {
            console.log('\nShutting down gracefully...');
            if (this.refreshInterval) {
                clearInterval(this.refreshInterval);
            }
            this.db.close();
            process.exit(0);
        });
    }

    async getWeather() {
        // Check cache first
        const now = Date.now();
        if (this.weatherCache.data && (now - this.weatherCache.timestamp) < this.weatherCache.cacheTime) {
            return this.weatherCache.data;
        }

        try {
            const { default: fetch } = await import('node-fetch');

            // Portland, OR coordinates
            const lat = 45.5152;
            const lon = -122.6784;

            // Using Open-Meteo (free, no API key required)
            const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&temperature_unit=fahrenheit&timezone=America/Los_Angeles`;

            const response = await fetch(weatherUrl);
            if (!response.ok) {
                throw new Error(`Weather API error: ${response.status}`);
            }

            const data = await response.json();
            const current = data.current_weather;

            const weatherData = {
                temperature: Math.round(current.temperature),
                description: this.getWeatherDescription(current.weathercode),
                timestamp: now
            };

            // Cache the result
            this.weatherCache.data = weatherData;
            this.weatherCache.timestamp = now;

            return weatherData;

        } catch (error) {
            console.error('Weather API error:', error);
            return {
                error: 'Weather data unavailable',
                timestamp: now
            };
        }
    }

    getWeatherDescription(code) {
        // Weather code mapping for Open-Meteo
        const weatherCodes = {
            0: 'Clear',
            1: 'Mainly Clear',
            2: 'Partly Cloudy',
            3: 'Overcast',
            45: 'Foggy',
            48: 'Rime Fog',
            51: 'Light Drizzle',
            53: 'Drizzle',
            55: 'Heavy Drizzle',
            61: 'Light Rain',
            63: 'Rain',
            65: 'Heavy Rain',
            71: 'Light Snow',
            73: 'Snow',
            75: 'Heavy Snow',
            80: 'Light Showers',
            81: 'Showers',
            82: 'Heavy Showers',
            95: 'Thunderstorm'
        };

        return weatherCodes[code] || 'Unknown';
    }

    async generateRSSFeed() {
        try {
            // Get recent articles (last 30 days, limit 50 for RSS)
            const articles = await this.db.getArticles(50);

            // Filter to articles from last 30 days
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

            const recentArticles = articles.filter(article =>
                new Date(article.pub_date) >= thirtyDaysAgo
            );

            const now = new Date();
            const buildDate = now.toUTCString();

            let rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
    <title>Portland Today - Composite Feed</title>
    <link>https://pdx.today/</link>
    <description>Aggregated news from Portland area sources</description>
    <language>en-us</language>
    <lastBuildDate>${buildDate}</lastBuildDate>
    <atom:link href="https://pdx.today/rss" rel="self" type="application/rss+xml" />
    <generator>Portland Today News Aggregator</generator>
    <managingEditor>noreply@portlandtoday.local (Portland Today)</managingEditor>
    <webMaster>noreply@portlandtoday.local (Portland Today)</webMaster>
`;

            recentArticles.forEach(article => {
                const pubDate = new Date(article.pub_date).toUTCString();
                const escapedTitle = this.escapeXml(article.title);
                const escapedDescription = this.escapeXml(article.description || '');
                const escapedSource = this.escapeXml(article.source);
                // Escape link to prevent XML injection; validate it is an http(s) URL.
                const safeLink = /^https?:\/\//.test(article.link) ? this.escapeXml(article.link) : '';
                let categories = [];
                try {
                    categories = JSON.parse(article.tags || '[]');
                } catch (e) {
                    categories = article.tags ? [article.tags] : [];
                }

                rssXml += `    <item>
        <title>${escapedTitle}</title>
        <link>${safeLink}</link>
        <description>${escapedDescription}</description>
        <pubDate>${pubDate}</pubDate>
        <guid isPermaLink="true">${safeLink}</guid>
        <source>${escapedSource}</source>`;

                categories.forEach(category => {
                    rssXml += `
        <category>${this.escapeXml(category)}</category>`;
                });

                rssXml += `
    </item>
`;
            });

            rssXml += `</channel>
</rss>`;

            return rssXml;

        } catch (error) {
            console.error('Error generating RSS feed:', error);
            return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
    <title>Portland Today - Error</title>
    <link>https://pdx.today/</link>
    <description>RSS feed temporarily unavailable</description>
    <item>
        <title>RSS Feed Error</title>
        <description>Unable to generate RSS feed at this time</description>
        <pubDate>${new Date().toUTCString()}</pubDate>
    </item>
</channel>
</rss>`;
        }
    }

    escapeXml(unsafe) {
        if (!unsafe) return '';
        return unsafe.toString()
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}

// Start the server
const newsServer = new NewsServer();
newsServer.initialize().then(() => {
    newsServer.start();
}).catch(console.error);
