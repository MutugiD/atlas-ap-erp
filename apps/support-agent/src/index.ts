import { buildSupportApp } from "./app";

const app = buildSupportApp();
const port = Number(process.env.PORT ?? 3002);

await app.listen({ port, host: "0.0.0.0" });
console.log(`Support Agent V2 listening on http://localhost:${port}`);

