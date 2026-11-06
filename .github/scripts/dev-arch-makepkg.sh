#!/usr/bin/env bash
set -euo pipefail

dir="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
[[ "$dir" == */.github/scripts ]] \
    || { echo "Error: This script should be run from the .github/scripts directory"; exit 1; }
cd "$dir/../../package/archlinux" \
    || { echo "Failed to enter directory"; exit 1; }

chown -R builder:builder src

PACKAGER=${PACKAGER:-"MoYingJi <moyingjiaw@outlook.com>"}
sudo="sudo --set-home --user builder"

$sudo env PACKAGER="$PACKAGER" makepkg --syncdeps --noconfirm
