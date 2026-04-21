const requireEnv = (key: string): string => {
  const raw = process.env[key];
  const value = raw?.trim() ?? "";
  if (value.length === 0) {
    throw new Error(`Missing required env var ${key}`);
  }
  return value;
};

export interface McpContext {
  beatId: string;
  companyId: string;
  role: string;
  arceusApiBase: string;
  arceusToken: string;
}

export const loadMcpContext = (): McpContext => ({
  beatId: requireEnv("BEAT_ID"),
  companyId: requireEnv("COMPANY_ID"),
  role: requireEnv("ROLE"),
  arceusApiBase: requireEnv("ARCEUS_API"),
  arceusToken: requireEnv("ARCEUS_TOKEN")
});
