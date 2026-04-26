/**
 * Task-engine limits — central caps to keep magic numbers out of state
 * machines (cluster C17 — F-381).
 *
 * Today only the artifact-propagation cap lives here, but this is the
 * home for any future "max N items hung off a task" knob (e.g. result
 * tail, command tail) so they all become tunable from one place.
 */

/**
 * Maximum number of `incomingArtifactIds` propagated to a child task
 * when a parent completes. Keeps the array bounded so an agent that
 * produces 200 artifacts per task doesn't drown its downstream peers
 * in context. Empirically 20 is enough to cover all artifacts an
 * agent typically references in one prompt window.
 */
export const MAX_INCOMING_ARTIFACT_IDS = 20;
