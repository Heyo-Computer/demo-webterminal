# Firecracker rootfs for the Heyo webterminal.
#
#   heyvm mvm build --local-only -c . -f deploy/Dockerfile -n demo-webterminal
#   heyvm create --name pty --backend-type firecracker --image demo-webterminal
#
# This is a microVM rootfs, not a container image: the kernel boots straight
# into /init.sh (init=/init.sh is hardcoded in mvm-ctrl's cmdline) and never
# reads CMD or ENTRYPOINT. Userspace below exists to satisfy that init — sshd
# for `heyvm exec`, iproute2 for the eth0 setup — not just to run the app.
FROM oven/bun:1

# Base userspace, mirroring infra/firecracker/Dockerfile.cloud in heyo.git.
# --no-install-recommends keeps the rootfs small, which matters because the
# ext4 image is sized from the exported tar.
#   openssh-server  — backs `heyvm exec` / `heyvm sh`
#   iproute2        — init.sh configures eth0 with `ip`
#   curl            — readiness probe in start.sh
#   ca-certificates — outbound TLS to the Heyo cloud
RUN apt-get update && apt-get install -y --no-install-recommends \
        openssh-server \
        iproute2 \
        iputils-ping \
        ca-certificates \
        curl \
        procps \
        less \
        vim-tiny \
    && rm -rf /var/lib/apt/lists/*

# SSH access for `heyvm exec` / `heyvm sh`. Host keys are generated at build
# time so sshd does not block on entropy at first boot, and password auth is
# written explicitly because there is no cloud-init to fix it later.
RUN mkdir -p /run/sshd /etc/ssh/sshd_config.d \
    && echo "PermitRootLogin yes" >> /etc/ssh/sshd_config \
    && echo "PermitEmptyPasswords yes" >> /etc/ssh/sshd_config \
    && echo "PasswordAuthentication yes" > /etc/ssh/sshd_config.d/50-heyo.conf \
    && chmod 644 /etc/ssh/sshd_config.d/50-heyo.conf \
    && passwd -d root \
    && ssh-keygen -A

WORKDIR /opt/webterminal

# Dependencies first, so editing a source file doesn't refetch the registry.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Bun runs the TypeScript directly and bundles public/ on demand, so the
# sources ship as-is — there is no build output to copy.
COPY index.ts tsconfig.json ./
COPY src ./src
COPY public ./public

# Boot: /init.sh is PID 1 and prints HEYVM_READY; the deployment's
# start_command then runs start.sh to launch the server.
COPY deploy/init.sh  /init.sh
COPY deploy/start.sh /opt/webterminal/start.sh
RUN chmod +x /init.sh /opt/webterminal/start.sh

# Both files: /etc/hostname is a Docker runtime bind mount and exports as an
# empty file, so /etc/heyo/hostname is what init.sh actually trusts.
RUN mkdir -p /etc/heyo \
    && echo 'pty' > /etc/heyo/hostname \
    && echo 'pty' > /etc/hostname

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 22 3000
CMD ["/init.sh"]
