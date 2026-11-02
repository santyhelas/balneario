"use client";
import type { ReactNode } from "react";
import { WorkspaceProvider } from "@/components/workspace";
import { StatusProvider } from "@/components/status";
import { Shell } from "@/components/shell";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <StatusProvider>
        <Shell>{children}</Shell>
      </StatusProvider>
    </WorkspaceProvider>
  );
}
