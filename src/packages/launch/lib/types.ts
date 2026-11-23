/** What the launch gate needs recorded before Live (§17): a passed restore drill and the journal's activation. */
export const LAUNCH_STEPS = ["restore_drill_passed", "journal_activated"] as const;
export type LaunchStep = (typeof LAUNCH_STEPS)[number];
