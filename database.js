const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class DatabaseManager {
    constructor() {
        this.db = null;
    }

    async initialize() {
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database('news.db', (err) => {
                if (err) {
                    reject(err);
                } else {
                    console.log('Connected to SQLite database');
                    this.createTables().then(resolve).catch(reject);
                }
            });
        });
    }

    async createTables() {
        return new Promise((resolve, reject) => {
            const createFeedsTable = `
                CREATE TABLE IF NOT EXISTS feeds (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    url TEXT UNIQUE NOT NULL,
                    title TEXT,
                    category TEXT,
                    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `;

            const createArticlesTable = `
                CREATE TABLE IF NOT EXISTS articles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    feed_id INTEGER,
                    title TEXT NOT NULL,
                    link TEXT UNIQUE NOT NULL,
                    description TEXT,
                    pub_date DATETIME,
                    category TEXT,
                    tags TEXT,
                    source TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (feed_id) REFERENCES feeds (id)
                )
            `;

            this.db.run(createFeedsTable, (err) => {
                if (err) {
                    reject(err);
                } else {
                    this.db.run(createArticlesTable, (err) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
                }
            });
        });
    }

    async addFeed(url, title, category) {
        return new Promise((resolve, reject) => {
            const stmt = this.db.prepare('INSERT OR IGNORE INTO feeds (url, title, category) VALUES (?, ?, ?)');
            stmt.run([url, title, category], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.lastID);
                }
            });
            stmt.finalize();
        });
    }

    async getFeeds() {
        return new Promise((resolve, reject) => {
            this.db.all('SELECT * FROM feeds ORDER BY category, title', (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    async addArticle(feedId, title, link, description, pubDate, category, tags, source) {
        return new Promise((resolve, reject) => {
            const stmt = this.db.prepare(`
                INSERT OR REPLACE INTO articles 
                (feed_id, title, link, description, pub_date, category, tags, source) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            stmt.run([feedId, title, link, description, pubDate, category, JSON.stringify(tags), source], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.lastID);
                }
            });
            stmt.finalize();
        });
    }

    async getArticles(limit = 100) {
        return new Promise((resolve, reject) => {
            this.db.all(`
                SELECT a.*, f.category as feed_category 
                FROM articles a 
                LEFT JOIN feeds f ON a.feed_id = f.id 
                ORDER BY a.pub_date DESC 
                LIMIT ?
            `, [limit], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    // Parse tags JSON back to array
                    const articles = rows.map(row => ({
                        ...row,
                        tags: JSON.parse(row.tags || '[]'),
                        pub_date: new Date(row.pub_date)
                    }));
                    resolve(articles);
                }
            });
        });
    }

    async updateFeedLastUpdated(feedId) {
        return new Promise((resolve, reject) => {
            this.db.run('UPDATE feeds SET last_updated = CURRENT_TIMESTAMP WHERE id = ?', [feedId], (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    close() {
        if (this.db) {
            this.db.close();
        }
    }
}

module.exports = DatabaseManager;