export type Rank = "S" | "A" | "B" | "C" | "F";
export type SyncStatus = "pending" | "synced" | "failed";
export type Profile = { id: string; nickname: string; color: string; createdAt: string };
export type ScoringConfig = {
  mode: "demo" | "decisions";
  provider: "OpenAI Decisions API";
  model: "gpt-6-luna";
  ready: boolean;
};
export type TitleSuggestions = { suggestions: string[]; source: "ai" | "demo" | "unavailable" };
export type Evaluation = {
  id: string;
  score: number;
  rank: Rank;
  reason: string;
  tags: string[];
  axes: { atmosphere: number; light: number; symbolism: number; story: number };
  createdAt: string;
  isDemo: boolean;
  criteriaVersion?: string;
  ai?: {
    provider: "openai-decisions" | "demo";
    model: string;
    criteriaVersion: string;
    rawScores: Record<keyof Evaluation["axes"], {
      score: number;
      confidence: number;
      probabilities: { label: string; value: number; probability: number }[];
    }>;
    predicates: Record<string, number>;
    usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  };
};
export type Photo = {
  id: string;
  userId: string;
  title: string;
  titleSuggestions?: TitleSuggestions;
  image: string;
  createdAt: string;
  evaluation: Evaluation;
  syncStatus: SyncStatus;
  syncUpdatedAt?: string;
  isSample: boolean;
};
export type RankingEntry = Profile & { highCount: number; sCount: number; aCount: number; position: number };
export type AppState = {
  profiles: Profile[];
  photos: Photo[];
  ranking: RankingEntry[];
  ai: ScoringConfig;
  drive?: { mode: "demo" | "google"; connected: boolean; folderName?: string };
  criteria?: {
    version: string;
    ranks: { rank: Rank; min: number; max: number }[];
    axes: { key: keyof Evaluation["axes"]; label: string; maxPoints: number }[];
  };
};
export type PhotoInput = { userId: string; title: string; image: string; sampleKey?: string; requestId?: string };
