/** Ready-made prompts. Clients that support MCP prompts show them as slash commands. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const user = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "morning_check_in",
    {
      title: "Morning check-in",
      description: "How recovered am I, and what should I do today?",
    },
    () =>
      user(
        "Call daily_briefing for today. Then answer in at most 6 short bullets: overall status and the main reason, last night's sleep and HRV versus my baseline, my training form, and one concrete recommendation for today's training. Quote the numbers the tool computed; do not recompute them. Then call show_view with preset readiness and your recommendation as next_steps.",
      ),
  );

  server.registerPrompt(
    "weekly_review",
    {
      title: "Weekly review",
      description: "Review last week's training and recovery, and plan the next one.",
    },
    () =>
      user(
        "Call weekly_report with weeks=2 and training_load with days=56. Review the most recent week: volume and load by sport, intensity split (80/20?), sleep/HRV/resting HR trend, and the change versus the week before. Flag load jumps over 30% or ACWR above 1.3. End with three specific suggestions for next week. Then call show_view with preset weekly and the suggestions as next_steps.",
      ),
  );

  server.registerPrompt(
    "analyze_last_workout",
    {
      title: "Analyze last workout",
      description: "Break down the most recent activity.",
      argsSchema: { sport: z.string().optional().describe("Limit to a sport, e.g. running or cycling") },
    },
    ({ sport }) =>
      user(
        `Call analyze_activity${sport ? ` with sport=${sport}` : ""} for my latest activity. Explain: pacing (splits, negative or positive split), heart rate zones, aerobic decoupling and what it says about durability, best efforts in this session, and any hidden Garmin metrics (VO2 max, performance condition). Keep it under 200 words. Then call show_view with preset activity for the same activity, a one-sentence note per section, and up to three next_steps.`,
      ),
  );

  server.registerPrompt(
    "race_readiness",
    {
      title: "Race readiness",
      description: "Am I ready for my race, and how should I taper?",
      argsSchema: {
        race_date: z.string().describe("YYYY-MM-DD"),
        distance: z.string().describe("e.g. 10k, half marathon, 100 km ride"),
      },
    },
    ({ race_date, distance }) =>
      user(
        `My race is a ${distance} on ${race_date}. Call training_load with days=120, recovery_analysis, and personal_records for the right sport. Assess fitness trend (CTL), current form (TSB), recent best efforts relevant to ${distance}, and recovery. Then give a day-by-day taper outline to race day that targets a TSB of about +5 to +15 on race day, and a realistic goal time range based on my best efforts. Say clearly which numbers come from the tools and which are estimates.`,
      ),
  );
}
