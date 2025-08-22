class NewsAggregator {
    constructor() {
        this.articles = [];
        this.categories = new Set();
        this.showDetails = false;
        this.todayOnly = true; // Default to showing only today's articles
        this.initializeElements();
        this.bindEvents();
        this.loadArticles();
        this.loadWeather();
    }

    initializeElements() {
        this.elements = {
            rssInput: document.getElementById('rss-input'),
            addFeedBtn: document.getElementById('add-feed'),
            categoryFilter: document.getElementById('category-filter'),
            refreshBtn: document.getElementById('refresh-feeds'),
            loading: document.getElementById('loading'),
            error: document.getElementById('error'),
            articlesContainer: document.getElementById('articles-container'),
            weatherSection: document.getElementById('weather-section'),
            weatherDisplay: document.getElementById('weather-display'),
            weatherTemp: document.getElementById('weather-temp'),
            weatherDesc: document.getElementById('weather-desc'),
            weatherError: document.getElementById('weather-error'),
            detailToggle: document.getElementById('detail-toggle'),
            todayToggle: document.getElementById('today-toggle')
        };
    }

    bindEvents() {
        this.elements.refreshBtn.addEventListener('click', () => this.refreshAllFeeds());
        this.elements.categoryFilter.addEventListener('change', () => this.filterArticles());
        this.elements.detailToggle.addEventListener('change', () => this.toggleDetails());
        this.elements.todayToggle.addEventListener('change', () => this.toggleTodayFilter());
        
        // Add window resize listener to recalculate iframe heights
        window.addEventListener('resize', () => this.handleResize());
    }

    handleResize() {
        // Debounce resize events
        clearTimeout(this.resizeTimeout);
        this.resizeTimeout = setTimeout(() => {
            this.updateIframeHeights();
        }, 250);
    }

    toggleDetails() {
        this.showDetails = this.elements.detailToggle.checked;
        
        // Refresh the display to show/hide details
        this.displayArticles();
    }

    toggleTodayFilter() {
        this.todayOnly = this.elements.todayToggle.checked;
        
        // Refresh the display with new filter
        this.filterArticles();
    }

    updateIframeHeights() {
        // Recalculate heights for all existing iframes
        const iframes = document.querySelectorAll('.category-iframe');
        iframes.forEach((iframe, index) => {
            const categorySection = iframe.closest('.category-section');
            const categoryTitle = categorySection.querySelector('.category-title').textContent.toLowerCase();
            
            // Find articles for this category
            const articlesByCategory = this.groupArticlesByCategory(this.articles);
            const articles = articlesByCategory[categoryTitle] || [];
            
            const newHeight = this.calculateIframeHeight(articles.length);
            iframe.style.height = newHeight + 'px';
        });
    }

    async refreshAllFeeds() {
        try {
            this.showLoading(true);
            
            // Trigger server refresh
            await fetch('/api/refresh', { method: 'POST' });
            
            // Wait a moment for refresh to start
            setTimeout(() => {
                this.loadArticles();
            }, 1000);
            
        } catch (error) {
            console.error('Error refreshing feeds:', error);
            this.showError('Failed to refresh feeds');
            this.showLoading(false);
        }
    }

    async loadArticlesFromAPI() {
        try {
            const response = await fetch('/api/articles?limit=200');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const articles = await response.json();
            
            // Transform articles to match frontend format
            this.articles = articles.map(article => ({
                title: article.title,
                link: article.link,
                description: article.description,
                date: new Date(article.pub_date),
                source: article.source,
                tags: article.tags
            }));
            
            // Update categories based on current filter settings
            this.categories.clear();
            let filteredArticles;
            
            if (this.todayOnly) {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const tomorrow = new Date(today);
                tomorrow.setDate(tomorrow.getDate() + 1);
                
                filteredArticles = this.articles.filter(article => {
                    const articleDate = new Date(article.date);
                    return articleDate >= today && articleDate < tomorrow;
                });
            } else {
                const oneMonthAgo = new Date();
                oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
                
                filteredArticles = this.articles.filter(article => article.date >= oneMonthAgo);
            }
            
            filteredArticles.forEach(article => {
                article.tags.forEach(tag => this.categories.add(tag));
            });
            
            this.updateCategoryFilter();
            this.filterArticles(); // Use filterArticles to apply today filter by default
            this.hideError();
            
        } catch (error) {
            console.error('Error loading articles:', error);
            this.showError('Failed to load articles from server');
        } finally {
            this.showLoading(false);
        }
    }

    updateCategoryFilter() {
        const currentValue = this.elements.categoryFilter.value;
        this.elements.categoryFilter.innerHTML = '<option value="all">All Categories</option>';
        
        // Get categories that have recent articles
        const articlesByCategory = this.groupArticlesByCategory(this.articles);
        const recentCategories = Object.keys(articlesByCategory);
        
        recentCategories.sort().forEach(category => {
            const option = document.createElement('option');
            option.value = category;
            option.textContent = category.charAt(0).toUpperCase() + category.slice(1);
            this.elements.categoryFilter.appendChild(option);
        });

        if (currentValue && recentCategories.includes(currentValue)) {
            this.elements.categoryFilter.value = currentValue;
        }
    }

    filterArticles() {
        const selectedCategory = this.elements.categoryFilter.value;
        
        // Start with all articles
        let filteredArticles = this.articles;
        
        // Apply today filter if enabled
        if (this.todayOnly) {
            const today = new Date();
            today.setHours(0, 0, 0, 0); // Start of today
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1); // Start of tomorrow
            
            filteredArticles = filteredArticles.filter(article => {
                const articleDate = new Date(article.date);
                return articleDate >= today && articleDate < tomorrow;
            });
        } else {
            // If not today only, filter to recent articles (last month)
            const oneMonthAgo = new Date();
            oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
            
            filteredArticles = filteredArticles.filter(article => {
                return article.date >= oneMonthAgo;
            });
        }
        
        // Then filter by selected category
        if (selectedCategory !== 'all') {
            filteredArticles = filteredArticles.filter(article => 
                article.tags.includes(selectedCategory)
            );
        }
        
        this.displayArticles(filteredArticles);
    }

    displayArticles(articlesToShow = this.articles) {
        this.elements.articlesContainer.innerHTML = '';

        if (articlesToShow.length === 0) {
            this.elements.articlesContainer.innerHTML = `
                <div style="text-align: center; padding: 2rem; color: #666;">
                    <h3>No articles found</h3>
                    <p>Add some RSS feeds to get started!</p>
                </div>`;
            return;
        }

        // Group articles by their primary tag/category
        const articlesByCategory = this.groupArticlesByCategory(articlesToShow);
        
        // Create category sections
        Object.entries(articlesByCategory).forEach(([category, articles]) => {
            const categorySection = this.createCategorySection(category, articles);
            this.elements.articlesContainer.appendChild(categorySection);
        });
    }

    groupArticlesByCategory(articles) {
        // Filter articles based on current filter settings
        let recentArticles;
        
        if (this.todayOnly) {
            // Filter to today's articles only
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);
            
            recentArticles = articles.filter(article => {
                const articleDate = new Date(article.date);
                return articleDate >= today && articleDate < tomorrow;
            });
        } else {
            // Filter articles to only include those from the last month
            const oneMonthAgo = new Date();
            oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
            
            recentArticles = articles.filter(article => {
                return article.date >= oneMonthAgo;
            });
        }
        
        const grouped = {};
        
        recentArticles.forEach(article => {
            // Use the first tag as the primary category
            const primaryCategory = article.tags[0] || 'general';
            
            if (!grouped[primaryCategory]) {
                grouped[primaryCategory] = [];
            }
            grouped[primaryCategory].push(article);
        });
        
        // Only return categories that have articles
        const categoriesWithArticles = Object.keys(grouped).filter(category => {
            return grouped[category].length > 0;
        });
        
        // Sort categories by name, but put 'local' and 'news' first
        const sortedCategories = categoriesWithArticles.sort((a, b) => {
            const priority = { 'local': 0, 'news': 1, 'politics': 2, 'business': 3 };
            const aPriority = priority[a] !== undefined ? priority[a] : 99;
            const bPriority = priority[b] !== undefined ? priority[b] : 99;
            
            if (aPriority !== bPriority) {
                return aPriority - bPriority;
            }
            return a.localeCompare(b);
        });
        
        const sortedGrouped = {};
        sortedCategories.forEach(category => {
            sortedGrouped[category] = grouped[category];
        });
        
        return sortedGrouped;
    }

    createCategorySection(category, articles) {
        const sectionDiv = document.createElement('div');
        sectionDiv.className = 'category-section';
        
        const categoryTitle = document.createElement('h2');
        categoryTitle.className = 'category-title';
        categoryTitle.textContent = category.charAt(0).toUpperCase() + category.slice(1);
        
        const iframe = document.createElement('iframe');
        iframe.className = 'category-iframe';
        iframe.setAttribute('scrolling', 'yes');
        iframe.setAttribute('frameborder', '0');
        
        // Calculate dynamic height based on article count
        const dynamicHeight = this.calculateIframeHeight(articles.length);
        iframe.style.height = dynamicHeight + 'px';
        
        // Create HTML content for the iframe
        const iframeContent = this.createIframeContent(articles, this.showDetails);
        iframe.src = 'data:text/html;charset=utf-8,' + encodeURIComponent(iframeContent);
        
        sectionDiv.appendChild(categoryTitle);
        sectionDiv.appendChild(iframe);
        
        return sectionDiv;
    }

    calculateIframeHeight(articleCount) {
        // Responsive settings based on screen width
        const isMobile = window.innerWidth <= 768;
        
        // Base height for iframe container and padding
        const baseHeight = 40;
        
        // Height per article row (approximate)
        const articleRowHeight = isMobile ? 90 : 80; // Slightly taller on mobile
        
        // Maximum height (for scrolling when there are many articles)
        const maxHeight = isMobile ? 250 : 300;
        
        // Minimum height (for at least one article display)
        const minHeight = isMobile ? 100 : 120;
        
        // Calculate height based on article count
        const calculatedHeight = baseHeight + (articleCount * articleRowHeight);
        
        // Apply constraints
        if (calculatedHeight < minHeight) {
            return minHeight;
        } else if (calculatedHeight > maxHeight) {
            return maxHeight;
        } else {
            return calculatedHeight;
        }
    }

    createIframeContent(articles, showDetails = false) {
        const articlesHtml = articles.map(article => this.createArticleRow(article)).join('');
        const containerClass = showDetails ? 'articles-container show-details' : 'articles-container';
        
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body {
            margin: 0;
            padding: 0.5rem;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background-color: #f9f9f9;
        }
        .articles-container {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }
        .article-row {
            background: white;
            border-radius: 6px;
            padding: 0.75rem;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            border-left: 3px solid #667eea;
            transition: box-shadow 0.2s, background-color 0.2s;
            display: grid;
            grid-template-columns: 2fr 1fr 1fr;
            gap: 1rem;
            align-items: start;
        }
        .article-row:hover {
            box-shadow: 0 2px 8px rgba(0,0,0,0.15);
            background-color: #fafafa;
        }
        .article-title-section {
            display: flex;
            flex-direction: column;
            gap: 0.2rem;
        }
        .title-date-row {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            gap: 1rem;
        }
        .article-title {
            font-weight: 600;
            color: #2c3e50;
            text-decoration: none;
            line-height: 1.3;
            font-size: 0.9rem;
            flex: 1;
        }
        .article-title:hover {
            color: #667eea;
        }
        .article-description {
            color: #555;
            line-height: 1.3;
            font-size: 0.75rem;
            display: none;
        }
        .article-source {
            font-weight: 500;
            color: #667eea;
            font-size: 0.8rem;
            display: none;
        }
        .article-date {
            color: #666;
            font-size: 0.75rem;
        }
        .article-tags {
            display: none;
            flex-wrap: wrap;
            gap: 0.2rem;
        }
        .tag {
            background: #e8f2ff;
            color: #667eea;
            padding: 0.1rem 0.4rem;
            border-radius: 8px;
            font-size: 0.65rem;
            font-weight: 500;
        }
        .show-details .article-description {
            display: block;
        }
        .show-details .article-tags {
            display: flex;
        }
        .show-details .article-source {
            display: inline;
        }
        @media (max-width: 600px) {
            .article-row {
                grid-template-columns: 1fr;
                gap: 0.5rem;
            }
        }
    </style>
</head>
<body>
    <div class="${containerClass}">
        ${articlesHtml}
    </div>
</body>
</html>`;
    }

    createArticleRow(article) {
        const formattedDate = article.date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });

        return `
            <div class="article-row">
                <div class="article-title-section">
                    <div class="title-date-row">
                        <a href="${article.link}" target="_blank" class="article-title">
                            ${article.title}
                        </a>
                        <span class="article-date">
                            ${formattedDate}
                        </span>
                    </div>
                    <div class="article-description">
                        ${article.description.slice(0, 100)}${article.description.length > 100 ? '...' : ''}
                    </div>
                </div>
                <div class="article-source">
                    ${article.source}
                </div>
                <div class="article-tags">
                    ${article.tags.map(tag => `<span class="tag">${tag}</span>`).join('')}
                </div>
            </div>`;
    }

    createArticleElement(article) {
        const articleDiv = document.createElement('div');
        articleDiv.className = 'article-card';
        
        const formattedDate = article.date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });

        articleDiv.innerHTML = `
            <a href="${article.link}" target="_blank" class="article-title">
                ${article.title}
            </a>
            <div class="article-meta">
                <span class="article-source">${article.source}</span>
                <span class="article-date">${formattedDate}</span>
            </div>
            <div class="article-description">
                ${article.description.slice(0, 200)}${article.description.length > 200 ? '...' : ''}
            </div>
            <div class="article-tags">
                ${article.tags.map(tag => `<span class="tag">${tag}</span>`).join('')}
            </div>
        `;

        return articleDiv;
    }

    showLoading(show) {
        this.elements.loading.classList.toggle('hidden', !show);
    }

    showError(message) {
        this.elements.error.textContent = message;
        this.elements.error.classList.remove('hidden');
        setTimeout(() => this.hideError(), 5000);
    }

    hideError() {
        this.elements.error.classList.add('hidden');
    }

    async loadArticles() {
        // Load articles from the local API
        await this.loadArticlesFromAPI();
    }

    async loadWeather() {
        try {
            const response = await fetch('/api/weather');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const weather = await response.json();
            
            if (weather.error) {
                this.showWeatherError(weather.error);
            } else {
                this.displayWeather(weather);
            }
        } catch (error) {
            console.error('Error loading weather:', error);
            this.showWeatherError('Weather unavailable');
        }
    }

    displayWeather(weather) {
        // Hide loading and error states
        const loadingElement = this.elements.weatherSection.querySelector('.weather-loading');
        if (loadingElement) loadingElement.classList.add('hidden');
        this.elements.weatherError.classList.add('hidden');
        
        // Show and update weather display
        this.elements.weatherDisplay.classList.remove('hidden');
        this.elements.weatherTemp.textContent = `${weather.temperature}°F`;
        this.elements.weatherDesc.textContent = weather.description;
    }

    showWeatherError(message) {
        // Hide loading and display states
        const loadingElement = this.elements.weatherSection.querySelector('.weather-loading');
        if (loadingElement) loadingElement.classList.add('hidden');
        this.elements.weatherDisplay.classList.add('hidden');
        
        // Show error
        this.elements.weatherError.classList.remove('hidden');
        this.elements.weatherError.textContent = message;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new NewsAggregator();
});