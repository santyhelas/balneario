"use client";
import type { ReactNode } from "react";
import { WorkspaceProvider } from "@/components/workspace";
import { StatusProvider } from "@/components/status";
import { Shell } from "@/components/shell";
import { WeatherProvider } from "@/components/weather";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <StatusProvider>
        <WeatherProvider>
          <Shell>{children}</Shell>
        </WeatherProvider>
      </StatusProvider>
    </WorkspaceProvider>
  );
}
