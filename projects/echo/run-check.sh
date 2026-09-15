#!/bin/bash
# Verifier per-CHECK entrypoint. One container per CHECK. The checkpoint arrives as a
# read-only tar; the command arrives on stdin from the host's frozen list. Nothing else
# is mounted. Exit code is the command's exit code; 4 = setup failed.
#
# STDIN is, in this order and nothing else:
#   line 1  the host's per-container 128-bit hex nonce, terminated by \n
#   rest    the frozen command text, bytes as-is, to EOF
#
# The nonce is the startup handshake, and it exists to tell an INFRASTRUCTURE
# failure apart from a CHECK failure. It is never exported and never appears in
# argv or the environment, and the `read` below consumes it from stdin before
# `cat` sees anything, so the CHECK cannot learn it. `RUN_CHECK_READY <nonce>`
# is printed ONLY after extraction, chdir and command read have all succeeded,
# and it is the first byte the host sees on stdout. A CHECK therefore cannot
# forge it: it cannot print before it runs, and it cannot know the nonce.
set -u
IFS= read -r nonce || exit 4
mkdir -p /work/tree || exit 4
tar -x -C /work/tree -f /archive/checkpoint.tar || exit 4
cd /work/tree || exit 4
cmd=$(cat) || exit 4
printf 'RUN_CHECK_READY %s\n' "$nonce"
unset nonce
exec bash -c "$cmd"
