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
        "Call daily_briefing for today. If data_freshness says last night has not synced, say that first and suggest syncing the watch; the call then rests on the other signals. Then answer in at most 6 short bullets: overall status and the main reason, last night's sleep and the overnight signals (HRV, resting HR, overnight stress) versus my baseline, the illness watch if it is not clear, my training form, the countdown to my next race if there is one, and one concrete recommendation for today's training. Quote the numbers the tool computed; do not recompute them. Then call show_view with preset readiness and your recommendation as next_steps.",
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
        "Call weekly_report with weeks=2, training_load with days=56, and training_status. Review the most recent week: volume and load by sport, the kinds of session, intensity split (80/20?), any records, sleep/HRV/resting HR trend, and the change versus the week before. Flag load jumps over 30% or ACWR above 1.3, and say what training_status and its load focus show is short. End with three specific suggestions for next week. Then call show_view with preset weekly and the suggestions as next_steps.",
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
        `Call analyze_activity${sport ? ` with sport=${sport}` : ""} for my latest activity. If it is an interval session, explain the reps: the structure, how even they were, the fade, and how fast heart rate came down in the rests; do not discuss kilometre splits. Otherwise explain pacing (splits, negative or positive split) and aerobic decoupling. In both cases cover heart rate zones, any records, and the hidden Garmin metrics (VO2 max, performance condition). Keep it under 200 words. Then call show_view with preset activity for the same activity, a one-sentence note per section, and up to three next_steps.`,
      ),
  );

  server.registerPrompt(
    "workout_progress",
    {
      title: "Workout progress",
      description: "Am I getting better at this workout?",
      argsSchema: { sport: z.string().optional().describe("Limit to a sport, e.g. running or cycling") },
    },
    ({ sport }) =>
      user(
        `Call compare_workouts${sport ? ` with sport=${sport}` : ""} for my latest activity. Say what it was matched on, how today's pace, heart rate and speed per heartbeat compare with the previous session of that kind and with the average of the earlier ones, and what the trend is. Mention the temperature if it differs, because heat lowers speed per heartbeat. Quote the tool's numbers; do not compute your own. Keep it under 150 words.`,
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
        `My race is a ${distance} on ${race_date}. First call race_calendar with action list, and add the race (action add) if it is not there yet. Then call race_predictor for the right sport, load_forecast with end_date=${race_date} and scenario=taper, training_status, and recovery_analysis. Report: the predicted time for ${distance} with its range and confidence, and the gap to my goal if I have one; my fitness trend and training status; the form the taper gives on race day and how it compares with training on or resting; and my recovery. Then give a day-by-day taper outline to race day. Use load_forecast (with target_tsb if needed) for every form number and race_predictor for every time and pace: do not estimate them yourself.`,
      ),
  );
}
