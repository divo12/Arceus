import postgres from "postgres";
const client = postgres(process.env.DATABASE_URL);
const rows = await client.unsafe(`SELECT column_name FROM information_schema.columns WHERE table_name='sprints' ORDER BY ordinal_position`);
console.log(rows.map(x => x.column_name).join(", "));
await client.end();
