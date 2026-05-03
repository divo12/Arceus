import { embed } from "../packages/hippocampus/src/backends/embedding.ts";
async function main() {
  const v = await embed("hello world test");
  console.log("isArray:", Array.isArray(v), "len:", v.length, "ctor:", v.constructor.name);
  console.log("first3:", v.slice(0,3));
}
main();
