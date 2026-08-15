# Firecracker rootfs for the Heyo webterminal.
#
#   heyvm mvm build -f deploy/Dockerfile -c . -n demo-webterminal
#
# The guest boots without a service manager, so nothing here starts the app —
# the deployment's start_command runs /opt/webterminal/start.sh.
FROM oven/bun:1

# curl backs the readiness probe in start.sh; ca-certificates is needed for the
# outbound TLS this server does to the Heyo cloud.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/webterminal

# Dependencies first, so editing a source file doesn't refetch the registry.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Bun runs the TypeScript directly and bundles public/ on demand, so the
# sources ship as-is — there is no build output to copy.
COPY index.ts tsconfig.json ./
COPY src ./src
COPY public ./public

COPY deploy/start.sh ./start.sh
RUN chmod +x ./start.sh

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000
CMD ["/opt/webterminal/start.sh"]
