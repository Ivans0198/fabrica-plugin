# Contenedor desechable para correr los workers de la fábrica con
# bypassPermissions: sin preguntas, pero con la red cerrada salvo lo de
# allowed-domains.txt. Basado en el dev container de referencia de Claude Code
# (github.com/anthropics/claude-code/tree/main/.devcontainer). Lo escribió
# fabrica-devcontainer; es del proyecto, edítalo si hace falta.
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
  git \
  gh \
  jq \
  sudo \
  less \
  procps \
  curl \
  ca-certificates \
  iptables \
  ipset \
  iproute2 \
  dnsutils \
  aggregate \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

ENV DEVCONTAINER=true

RUN mkdir -p /usr/local/share/npm-global /home/node/.claude /home/node/.config/gh \
  && chown -R node:node /usr/local/share/npm-global /home/node/.claude /home/node/.config

# La lista de dominios va dentro de la imagen, de root: si el firewall la
# leyera del proyecto, el agente podría agrandarla y volver a correrlo.
COPY allowed-domains.txt /usr/local/etc/fabrica-allowed-domains.txt
COPY init-firewall.sh /usr/local/bin/init-firewall.sh
RUN chmod 0755 /usr/local/bin/init-firewall.sh \
  && chmod 0644 /usr/local/etc/fabrica-allowed-domains.txt \
  && echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/node-firewall \
  && chmod 0440 /etc/sudoers.d/node-firewall

USER node
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}
