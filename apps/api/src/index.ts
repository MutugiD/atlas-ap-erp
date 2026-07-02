import { app } from "./app";

export default {
  port: Number(process.env.PORT ?? 3001),
  fetch: app.fetch,
};

