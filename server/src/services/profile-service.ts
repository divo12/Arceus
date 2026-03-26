import type { HabitItem, HippocampusBridge } from "./hippocampus-contract.js";
import { MemoryContainers } from "./memory-scope.js";

export interface EmployeeProfile {
  role: string;
  core_knowledge: string[];
  current_context: string[];
  habits: HabitItem[];
  state: Record<string, unknown>;
}

export class ProfileService {
  constructor(private readonly bridge: HippocampusBridge) {}

  async generateProfile(
    agentId: string,
    startupId: string,
    role: string,
  ): Promise<EmployeeProfile> {
    const container = MemoryContainers.employee(startupId, agentId);
    const [staticMems, dynamicMems, habits, priming] = await Promise.allSettled([
      this.bridge.listMemories(agentId, "static", container),
      this.bridge.listMemories(agentId, "dynamic", container),
      this.bridge.getHabits(agentId),
      this.bridge.getPriming(agentId),
    ]);

    return {
      role,
      core_knowledge: staticMems.status === "fulfilled"
        ? staticMems.value.items.map((item) => item.content)
        : [],
      current_context: dynamicMems.status === "fulfilled"
        ? dynamicMems.value.items.map((item) => item.content)
        : [],
      habits: habits.status === "fulfilled" ? habits.value.habits : [],
      state: {
        priming_prompt: priming.status === "fulfilled" ? priming.value.prompt : "",
        partial: [staticMems, dynamicMems, habits, priming].some(
          (result) => result.status === "rejected",
        ),
      },
    };
  }
}
