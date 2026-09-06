#!/bin/bash
# GhostCut - double-click to start the found-footage horror splicer (macOS).
cd "$(dirname "$0")"
if ! command -v python3 >/dev/null 2>&1; then
  echo
  echo "Python 3 is needed to run GhostCut but wasn't found."
  echo "Install it from https://www.python.org/downloads/ then double-click this file again."
  echo
  read -r -p "Press Return to close."
  exit 1
fi
python3 ghostcut.py "$@"
status=$?
if [ $status -ne 0 ]; then
  echo
  read -r -p "GhostCut stopped with a problem (details above). Press Return to close."
fi
