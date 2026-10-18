import type { Metadata } from "next";
import { DevConsole } from "./DevConsole";
import "./dev.css";

export const metadata: Metadata = {
  title: "Backend console",
  description: "Developer test console for the room plan API, research jobs and voice.",
};

export default function DevPage() {
  return <DevConsole />;
}
