#!/bin/bash
# Recrea la base de prueba, aplica las migraciones y corre las pruebas.
set -e
H=${PGHOST:-/home/claude/.pgtest}; P=${PGPORT:-5433}
DIR="$(cd "$(dirname "$0")" && pwd)"
"$DIR/reset.sh"
psql -h $H -p $P -U postgres -d balneario_test -q -f "$DIR/10_pruebas.sql"
