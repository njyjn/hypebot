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
