"use client";
import type { ReactNode } from "react";
import { WorkspaceProvider } from "@/components/workspace";
import { Shell } from "@/components/shell";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <Shell>{children}</Shell>
    </WorkspaceProvider>
  );
}
