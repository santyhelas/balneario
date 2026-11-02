#!/bin/bash
# Recrea la base de prueba local y aplica todas las migraciones.
set -e
H=${PGHOST:-/home/claude/.pgtest}; P=${PGPORT:-5433}
DIR="$(cd "$(dirname "$0")/.." && pwd)"
psql -h $H -p $P -U postgres -qc "drop database if exists balneario_test" -c "create database balneario_test"
psql -h $H -p $P -U postgres -d balneario_test -q -v ON_ERROR_STOP=1 -c "set client_min_messages=warning" \
  -f "$DIR/tests/00_supabase_shim.sql"
for f in "$DIR"/migrations/*.sql; do
  psql -h $H -p $P -U postgres -d balneario_test -q -v ON_ERROR_STOP=1 -f "$f" || { echo "FALLÓ: $f"; exit 1; }
done
echo "Migraciones aplicadas OK"
