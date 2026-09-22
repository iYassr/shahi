FROM oven/bun:1.3.13
USER root
RUN bun -e 'import {rootCertificates} from "node:tls"; await Bun.write("/etc/ssl/certs/ca-certificates.crt",rootCertificates.join("\n"))' \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt update && apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt install -y --no-install-recommends bash curl ca-certificates git python3 nodejs npm procps util-linux \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://github.com/herdrdev/herdr/releases/download/v0.9.1/herdr-linux-x86_64 -o /usr/local/bin/herdr \
    && echo '2a02fed16beb651ef006e1d43f048f652ca4dc58ad053cd2d44450563d5c54b7  /usr/local/bin/herdr' | sha256sum -c - \
    && chmod 755 /usr/local/bin/herdr
RUN npm install -g @openai/codex@0.154.0 && npm cache clean --force
RUN useradd --uid 1001 --create-home --shell /bin/bash demo \
    && mkdir -p /home/demo/workspace /opt/demo /run/shahi \
    && chmod 700 /run/shahi
COPY build/server.js build/controller.js build/model.js build/tools.js /opt/demo/
COPY container/state.py /opt/demo/state.py
COPY container/codex.toml /opt/demo/codex.toml
COPY container/workspace/ /home/demo/workspace/
RUN chown -R demo:demo /home/demo
EXPOSE 8080
CMD ["bun", "/opt/demo/controller.js"]
