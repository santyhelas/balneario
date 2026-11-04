import { test } from "node:test";
import assert from "node:assert/strict";
import { backupFileName, decrypt, deriveKey, encrypt, multipartBody, signState, verifyState } from "./drive-core.ts";

const key = deriveKey("clave-secreta-de-prueba", "drive-token");

test("cifra y descifra el permiso de Drive", () => {
  const enc = encrypt("1//refresh-token", key);
  assert.notEqual(enc, "1//refresh-token");
  assert.equal(decrypt(enc, key), "1//refresh-token");
  assert.equal(decrypt(enc, deriveKey("otra", "drive-token")), null);
  assert.equal(decrypt("basura", key), null);
});

test("el sello no se puede falsificar", () => {
  const s = signState('{"ws":"abc"}', key);
  assert.equal(verifyState(s, key), '{"ws":"abc"}');
  const [p] = s.split(".");
  assert.equal(verifyState(`${p}.firmafalsa`, key), null);
  assert.equal(verifyState(`${Buffer.from('{"ws":"otro"}').toString("base64url")}.${s.split(".")[1]}`, key), null);
});

test("cuerpo para subir y nombre del archivo", () => {
  const b = multipartBody({ name: "x.json", parents: ["f"] }, "{}", "LIM");
  assert.ok(b.startsWith("--LIM\r\nContent-Type: application/json"));
  assert.ok(b.endsWith("--LIM--\r\n"));
  assert.equal(backupFileName("Parador Eólico", new Date("2026-11-04T06:00:00Z")), "copia_Parador_Eolico_2026-11-04_03-00.json");
});
