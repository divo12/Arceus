declare module "cytoscape-cose-bilkent" {
  import type cytoscape from "cytoscape";

  const register: (cytoscapeInstance: typeof cytoscape) => void;
  export default register;
}
