// Thrown when a post would land in a closed accounting period. Lives in its own
// module so both repository implementations can import it without a cycle.
export class ClosedPeriodError extends Error {
  constructor(public readonly periodId: string) {
    super(`Accounting period ${periodId} is closed`);
    this.name = "ClosedPeriodError";
  }
}
