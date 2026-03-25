import type { HippocampusBridge } from "./hippocampus-contract.js";

export interface MemoryServices<
  TScope = unknown,
  TProjections = unknown,
  TProfile = unknown,
  TDelegation = unknown,
> {
  scope: TScope | null;
  projections: TProjections | null;
  profile: TProfile | null;
  delegation: TDelegation | null;
}

export interface MemoryServiceFactories<
  TScope = unknown,
  TProjections = unknown,
  TProfile = unknown,
  TDelegation = unknown,
> {
  createScope: (bridge: HippocampusBridge) => TScope | null;
  createProjections: (bridge: HippocampusBridge) => TProjections | null;
  createProfile: (bridge: HippocampusBridge) => TProfile | null;
  createDelegation: (bridge: HippocampusBridge) => TDelegation | null;
}

const defaultFactories: MemoryServiceFactories = {
  createScope: () => null,
  createProjections: () => null,
  createProfile: () => null,
  createDelegation: () => null,
};

let memoryServices: MemoryServices = createEmptyMemoryServices();

export function createEmptyMemoryServices(): MemoryServices {
  return {
    scope: null,
    projections: null,
    profile: null,
    delegation: null,
  };
}

export function createMemoryServices<
  TScope = unknown,
  TProjections = unknown,
  TProfile = unknown,
  TDelegation = unknown,
>(
  bridge: HippocampusBridge,
  factories?: MemoryServiceFactories<TScope, TProjections, TProfile, TDelegation>,
): MemoryServices<TScope, TProjections, TProfile, TDelegation> {
  const resolvedFactories =
    factories ??
    (defaultFactories as MemoryServiceFactories<TScope, TProjections, TProfile, TDelegation>);

  return {
    scope: resolvedFactories.createScope(bridge),
    projections: resolvedFactories.createProjections(bridge),
    profile: resolvedFactories.createProfile(bridge),
    delegation: resolvedFactories.createDelegation(bridge),
  };
}

export function initializeMemoryServices(bridge: HippocampusBridge): MemoryServices {
  memoryServices = createMemoryServices(bridge);
  return memoryServices;
}

export function getMemoryServices(): MemoryServices {
  return memoryServices;
}

export function resetMemoryServices(): void {
  memoryServices = createEmptyMemoryServices();
}
