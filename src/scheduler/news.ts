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
  { name: 'Fantasy Football Fix', url: 'https://www.fantasyfootballfix.com' },
];

// Rate limiting - track last API call
let lastTwitterCall = 0;
const TWITTER_MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between Twitter calls
const TWITTER_ENABLED = process.env.ENABLE_TWITTER === 'true' && process.env.TWITTER_BEARER_TOKEN;

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
  
  if (!TWITTER_ENABLED) {
    return news;
  }
  
  const now = Date.now();
  if (now - lastTwitterCall < TWITTER_MIN_INTERVAL_MS) {
    console.log(`[NEWS] Twitter rate-limited. Last check ${Math.round((now - lastTwitterCall) / 1000)}s ago.`);
    return news;
  }
  
  const bearerToken = process.env.TWITTER_BEARER_TOKEN;
  if (!bearerToken) {
    return news;
  }
  
  lastTwitterCall = now;
  
  try {
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
        const playerMatch = tweet.text.match(/([A-Z][a-z]+ [A-Z][a-z]+)/);
        
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

// Common false positives to filter out
const FALSE_POSITIVES = new Set([
  'there', 'their', 'these', 'those', 'the',
  'and', 'are', 'for', 'but', 'not', 'with',
  'has', 'had', 'have', 'was', 'were', 'been',
  'concerns', 'checking', 'looking', 'after',
  'price', 'news', 'tips', 'team', 'players',
  'font', 'block', 'header', 'footer', 'button',
  'login', 'sign', 'search', 'menu', 'home',
]);

export async function checkFPLWebsites(): Promise<NewsItem[]> {
  const news: NewsItem[] = [];
  
  for (const source of FPL_NEWS_SOURCES) {
    try {
      const html = await fetchWithTimeout(source.url, 8000);
      
      let text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[^;]+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      
      const patterns = [
        /(?:injury|injured|doubtful|out\s+for|suspended|setback)\s+(?:the\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/gi,
        /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s+(?:injury|injured|doubtful|out\s+for|setback|return\s+from)/gi,
        /(?:scan|scans)\s+(?:on\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/gi,
      ];
      
      const foundPlayers = new Set<string>();
      
      for (const pattern of patterns) {
        const matches = text.matchAll(pattern);
        for (const match of matches) {
          const playerName = (match[1] || match[0]).trim();
          
          const words = playerName.split(/\s+/);
          const isValid = words.every(w => 
            w.length >= 3 && 
            !FALSE_POSITIVES.has(w.toLowerCase()) &&
            /^[A-Z]/.test(w)
          );
          
          if (isValid && playerName.length > 4) {
            foundPlayers.add(playerName);
          }
        }
      }
      
      if (foundPlayers.size > 0) {
        for (const player of Array.from(foundPlayers).slice(0, 3)) {
          news.push({
            source: source.name,
            title: `${player} - injury/fitness update`,
            content: `Potential injury news for ${player}`,
            timestamp: new Date(),
            priority: 'medium',
            playerInvolved: player,
          });
        }
      }
    } catch {
      // Continue silently
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
  
  allNews.sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return b.timestamp.getTime() - a.timestamp.getTime();
  });
  
  const realNews = allNews.filter(n => 
    n.playerInvolved && 
    n.playerInvolved.length > 4 &&
    !n.title.includes('font') &&
    !n.title.includes('block') &&
    !n.title.includes('header')
  );
  
  if (realNews.length > 0) {
    console.log(`[NEWS] Found ${realNews.length} relevant news items:`);
    for (const item of realNews.slice(0, 5)) {
      console.log(`  - [${item.source}] ${item.title.substring(0, 60)}`);
    }
  } else {
    console.log('[NEWS] No breaking news found.');
  }
  
  return realNews;
}
