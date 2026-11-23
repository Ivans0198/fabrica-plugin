# Contenedor desechable para correr los workers de la fábrica con
# bypassPermissions: sin preguntas, pero con la red cerrada salvo lo de
# allowed-domains.txt. Basado en el dev container de referencia de Claude Code
# (github.com/anthropics/claude-code/tree/main/.devcontainer). Lo escribió
# fabrica-devcontainer; es del proyecto, edítalo si hace falta.
FROM node:24-bookworm

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

# git entra a GitHub con la sesión de gh (en un volumen), también al clonar el
# plugin privado. En el sistema y no en ~/.gitconfig, que no sobrevive a una
# reconstrucción.
RUN git config --system credential.https://github.com.helper '!gh auth git-credential'

RUN mkdir -p /home/node/.claude /home/node/.config/gh \
  && chown -R node:node /home/node/.claude /home/node/.config

# Como root, en /usr/local/bin: Debian reinicia el PATH en las shells de login
# (las de VS Code y el CLI de dev containers), y un prefijo de npm propio se
# perdía. La versión va fija y las actualizaciones apagadas en
# devcontainer.json: para subir de versión, cambia CLAUDE_CODE_VERSION y
# reconstruye.
ARG CLAUDE_CODE_VERSION=2.1.319
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# La lista de dominios va dentro de la imagen, de root: si el firewall la
# leyera del proyecto, el agente podría agrandarla y volver a correrlo.
COPY allowed-domains.txt /usr/local/etc/fabrica-allowed-domains.txt
COPY init-firewall.sh /usr/local/bin/init-firewall.sh
RUN chmod 0755 /usr/local/bin/init-firewall.sh \
  && chmod 0644 /usr/local/etc/fabrica-allowed-domains.txt \
  && echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/node-firewall \
  && chmod 0440 /etc/sudoers.d/node-firewall

USER node
