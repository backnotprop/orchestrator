export const BUILT_IN_PROVIDER_LIMIT_PROVIDERS = ["codex", "copilot", "claude"] as const;

export type BuiltInProviderLimitProvider = (typeof BUILT_IN_PROVIDER_LIMIT_PROVIDERS)[number];
export type ProviderLimitProvider = BuiltInProviderLimitProvider | (string & {});

export type ProviderLimitStatus = "available" | "partial" | "unavailable";
export type ProviderLimitConfidence = "exact" | "estimated" | "unknown";

export type ProviderLimitSource =
  | "codex-app-server"
  | "codex-oauth"
  | "copilot-api"
  | "claude-oauth"
  | "claude-cli"
  | "manual"
  | (string & {});

export type ProviderLimitWindow = {
  id: string;
  label: string;
  usedPercent?: number;
  remainingPercent?: number;
  resetsAt?: string;
  resetDescription?: string;
  limitDescription?: string;
};

export type ProviderCreditsSnapshot = {
  remaining?: number;
  used?: number;
  limit?: number;
  resetsAt?: string;
  unit?: string;
};

export type ProviderResetCreditsSnapshot = {
  availableCount?: number;
  nextExpiresAt?: string;
};

export type ProviderLimitAccount = {
  id?: string;
  email?: string;
  username?: string;
  organization?: string;
  plan?: string;
  loginMethod?: string;
};

export type ProviderLimitError = {
  code: string;
  message: string;
  hint?: string;
};

export type ProviderLimitSnapshot = {
  provider: ProviderLimitProvider;
  status: ProviderLimitStatus;
  source?: ProviderLimitSource;
  confidence: ProviderLimitConfidence;
  account?: ProviderLimitAccount;
  windows: ProviderLimitWindow[];
  credits?: ProviderCreditsSnapshot;
  resetCredits?: ProviderResetCreditsSnapshot;
  updatedAt: string;
  staleAfter?: string;
  error?: ProviderLimitError;
};

export type ProviderLimitsReport = {
  schemaVersion: 1;
  generatedAt: string;
  providers: ProviderLimitSnapshot[];
};

export type ProviderLimitReaderInput = {
  provider: ProviderLimitProvider;
  workspaceRoot: string;
  orchestratorDir?: string;
  timeoutMs: number;
  now?: Date;
};

export type ProviderLimitReader = {
  provider: ProviderLimitProvider;
  read(input: ProviderLimitReaderInput): Promise<ProviderLimitSnapshot>;
};
