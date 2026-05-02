// Reproduce via actual service path
process.env.DATABASE_URL = process.env.DATABASE_URL;
const { embed } = await import("q:/projects/arc2.0/packages/hippocampus/src/backends/embedding.ts");
const v = await embed("hello world test");
console.log("typeof:", typeof v, "isArray:", Array.isArray(v), "len:", v.length, "ctor:", v.constructor.name);
console.log("first3:", v.slice(0,3));
