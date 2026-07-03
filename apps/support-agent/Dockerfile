FROM oven/bun:1.3.14-slim

WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY infra ./infra
RUN bun install --frozen-lockfile

ENV PORT=3002
ENV APP_ROLE=web
EXPOSE 3002
CMD ["sh", "-lc", "if [ \"$APP_ROLE\" = \"worker\" ]; then bun run apps/support-agent/src/worker.ts; else bun --filter @atlas/support-agent dev; fi"]
