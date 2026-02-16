// FPL News Intelligence Service
// Monitors Twitter/X and FPL websites for leaks and breaking news

export interface NewsItem {
  source: string;
  title: string;
  content: string;
  timestamp: Date;
  url?: string;
  priority: 'high' | 'medium' | 'low';
  playerInvolved?: string;
}

const FPL_ACCOUNT_NAMES = [
  'LiveFPL',
  'FPLFran',
  'FPL_Review',
  'FPLGod',
  'J叫叫',
  'FPLTips',
  'BenCrellin',
  'TheFPLGeneral',
  'PremierLeague',
];

const FPL_NEWS_SOURCES = [
  { name: 'FPL Review', url: 'https://www.fplreview.com/news' },
  { name: 'Fantasy Football Fix', url: 'https://www.fantasyfootballfix.com/fpl_injury_news' },
];

async function fetchWithTimeout(url: string, timeout = 5000): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: controller.signal,
    });
    return await response.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function checkTwitterNews(): Promise<NewsItem[]> {
  const news: NewsItem[] = [];
  const bearerToken = process.env.TWITTER_BEARER_TOKEN;
  
  if (!bearerToken) {
    console.log('[NEWS] Twitter API token not configured. Skipping Twitter.');
    return news;
  }
  
  try {
    // Search for recent tweets from popular FPL accounts
    const query = FPL_ACCOUNT_NAMES.map(name => `from:${name}`).join(' OR ');
    const url = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&tweet.fields=created_at,author_id&expansions=author_ids&max_results=20`;
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
      },
    });
    
    if (!response.ok) {
      console.log(`[NEWS] Twitter API error: ${response.status}`);
      return news;
    }
    
    const data = await response.json() as {
      data?: { id: string; text: string; created_at: string; author_id: string }[];
      includes?: { users: { id: string; name: string; username: string }[] };
    };
    
    if (!data.data) return news;
    
    const users = data.includes?.users || [];
    
    for (const tweet of data.data) {
      const user = users.find(u => u.id === tweet.author_id);
      const text = tweet.text.toLowerCase();
      
      // Look for injury/transfer news keywords
      const isNews = text.includes('injury') || 
        text.includes('doub') || 
        text.includes('out') || 
        text.includes('confirmed') ||
        text.includes('breaking') ||
        text.includes('setback') ||
        text.includes('return') ||
        text.includes('fit') ||
        text.includes('scans') ||
        text.includes('suspended');
      
      if (isNews) {
        const playerMatch = text.match(/([A-Z][a-z]+ [A-Z][a-z]+)/);
        
        news.push({
          source: `Twitter/@${user?.username || 'unknown'}`,
          title: tweet.text.substring(0, 100),
          content: tweet.text,
          timestamp: new Date(tweet.created_at),
          priority: text.includes('breaking') || text.includes('confirmed') ? 'high' : 'medium',
          playerInvolved: playerMatch?.[1],
        });
      }
    }
  } catch (error) {
    console.log('[NEWS] Twitter API error:', error);
  }
  
  return news;
}

export async function checkFPLWebsites(): Promise<NewsItem[]> {
  const news: NewsItem[] = [];
  
  for (const source of FPL_NEWS_SOURCES) {
    try {
      const html = await fetchWithTimeout(source.url, 8000);
      
      // Extract injury news from the HTML (simplified parsing)
      const injuryMatches = html.match(/([A-Z][a-z]+ [A-Z][a-z]+).*?(injury|injured|doubt|out|suspended|fit|return)/gi) || [];
      
      for (const match of injuryMatches.slice(0, 5)) {
        const playerMatch = match.match(/^([A-Z][a-z]+ [A-Z][a-z]+)/);
        
        news.push({
          source: source.name,
          title: match.substring(0, 80),
          content: match,
          timestamp: new Date(),
          priority: match.toLowerCase().includes('breaking') ? 'high' : 'medium',
          playerInvolved: playerMatch?.[1],
        });
      }
    } catch (error) {
      // Silently continue on error
    }
  }
  
  return news;
}

export async function gatherFPLNews(): Promise<NewsItem[]> {
  console.log('[NEWS] Gathering FPL news from multiple sources...');
  
  const [twitterNews, websiteNews] = await Promise.all([
    checkTwitterNews(),
    checkFPLWebsites(),
  ]);
  
  const allNews = [...twitterNews, ...websiteNews];
  
  // Sort by priority and timestamp
  allNews.sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return b.timestamp.getTime() - a.timestamp.getTime();
  });
  
  if (allNews.length > 0) {
    console.log(`[NEWS] Found ${allNews.length} news items:`);
    for (const item of allNews.slice(0, 5)) {
      console.log(`  - [${item.source}] ${item.title.substring(0, 60)}...`);
    }
  } else {
    console.log('[NEWS] No breaking news found.');
  }
  
  return allNews;
}
