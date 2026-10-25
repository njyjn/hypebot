/** One post or headline read for the mood score. */
export interface MoodItem {
  id: string; // "reddit:t3_abc" or "news:<guid>"
  source: "reddit" | "news";
  title: string;
  text: string; // at most 400 characters
  url: string;
  createdAt: number;
  comments?: string[];
}

export interface MoodTheme {
  text: string;
  url?: string; // only ever a link from the items that were analysed
}

/** One analysed run: the mood of its items and what they were about. */
export interface MoodBatch {
  at: number;
  score: number; // -1 .. 1
  items: number;
  themes: MoodTheme[];
}

/** Everything mood keeps in /data/mood.json. */
export interface MoodState {
  batches: MoodBatch[];
  seen: Record<string, number>; // item id -> when it was analysed
  lastDigestDate?: string; // local YYYY-MM-DD
  failuresInARow: number;
  alerted: boolean;
}

/** The mood_* settings. */
export interface MoodConfig {
  enabled: boolean;
  aiTaskEntity: string;
  subreddits: string[];
  newsQuery: string;
  digestTime: string; // "HH:MM", local time
  redditClientId: string;
  redditClientSecret: string;
}
