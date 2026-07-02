FROM oven/bun:1.3.14-slim

WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile

ENV PORT=3002
ENV APP_ROLE=web
EXPOSE 3002
CMD ["bun", "--filter", "@atlas/support-agent", "dev"]

