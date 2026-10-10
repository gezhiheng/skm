import path from 'node:path';
import type { AgentAdapter } from './types.js';

// Verified: https://developers.openai.com/codex/skills/ (2026-10-10).
export const defaultAgentAdapter: AgentAdapter = {
  id: 'codex',
  skillDirectory: projectPath => path.join(projectPath, '.agents', 'skills'),
};
