"use client";
import { useState } from "react";
import { addDays, todayISO } from "@/lib/format";
import { CATEGORY_LABEL, CATEGORY_TABLES, type Category } from "@/lib/history";
import { useWorkspace } from "@/components/workspace";
import { PageHeader } from "@/components/shell";
import { Field, Input, Select } from "@/components/ui";
import { HistoryFeed, useWorkspaceUsers } from "@/components/history-feed";

type Filter = "todo" | Category | "cobros";

export default function HistorialPage() {
  const { ws } = useWorkspace();
  const today = todayISO(ws.timezone);
  const [from, setFrom] = useState(addDays(today, -6));
  const [to, setTo] = useState(today);
  const [type, setType] = useState<Filter>("todo");
  const [actor, setActor] = useState("");
  const [search, setSearch] = useState("");
  const users = useWorkspaceUsers();

  const tables = type === "todo" ? null : type === "cobros" ? [] : CATEGORY_TABLES[type];
  const includePayments = type === "todo" || type === "cobros";

  return (
    <>
      <PageHeader title="Historial" subtitle="Todo lo que se hizo en el sistema: quién, cuándo y qué cambió. No se puede borrar." />
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <Field label="Desde"><Input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="w-auto" /></Field>
        <Field label="Hasta"><Input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} className="w-auto" /></Field>
        <Field label="Tipo">
          <Select value={type} onChange={(e) => setType(e.target.value as Filter)} className="w-auto">
            <option value="todo">Todo</option>
            {(Object.keys(CATEGORY_LABEL) as (Category | "cobros")[]).map((k) => <option key={k} value={k}>{CATEGORY_LABEL[k]}</option>)}
          </Select>
        </Field>
        {users.length > 1 && (
          <Field label="Usuario">
            <Select value={actor} onChange={(e) => setActor(e.target.value)} className="w-auto">
              <option value="">Todos</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Buscar"><Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Cliente, carpa, N° de reserva…" className="w-64" /></Field>
      </div>
      <HistoryFeed from={from} to={to} tables={tables} includePayments={includePayments} actorId={actor || undefined} search={search} />
    </>
  );
}
