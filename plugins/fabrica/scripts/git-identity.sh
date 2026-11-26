#!/usr/bin/env bash
# Si git no tiene nombre o correo, los toma de la cuenta de gh: el nombre (o
# el login) y el correo público (o el noreply de GitHub). En el dev container
# no había identidad, el `git commit` del worker falló y lo repitió con
# `-c user.name -c user.email` a mano (truckconnect-mobile #22, 2026-11-27);
# ~/.gitconfig no sobrevive a un rebuild. Si git ya tiene identidad, no hace
# nada. fabrica-backlog lo corre antes de lanzar workers.
#
# Usage: fabrica-git-identity
# Requires: git, gh y jq.

set -euo pipefail

if [ -n "$(git config user.name || true)" ] && [ -n "$(git config user.email || true)" ]; then
  exit 0
fi

manual="configúrala con git config --global user.name \"Tu Nombre\" y git config --global user.email tu@correo, o entra a gh con gh auth login y vuelve a correr esto"
if ! user=$(gh api user 2>/dev/null); then
  echo "❌ git no tiene nombre ni correo, y no pude leer tu cuenta de gh: $manual." >&2
  exit 1
fi
login=$(jq -r '.login // empty' <<<"$user")
id=$(jq -r '.id // empty' <<<"$user")
if [ -z "$login" ] || [ -z "$id" ]; then
  echo "❌ git no tiene nombre ni correo, y gh no dio tu cuenta: $manual." >&2
  exit 1
fi
name=$(jq -r '.name // empty' <<<"$user")
email=$(jq -r '.email // empty' <<<"$user")
git config --global user.name "${name:-$login}"
git config --global user.email "${email:-$id+$login@users.noreply.github.com}"
echo "✓ git: $(git config user.name) <$(git config user.email)>, de tu cuenta de gh"
