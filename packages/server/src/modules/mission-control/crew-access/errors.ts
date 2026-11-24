export type CrewAccessErrorCode =
  | "CREW_ACCESS_DENIED"
  | "CREW_ACCESS_UNAVAILABLE";

const MESSAGE: Readonly<Record<CrewAccessErrorCode, string>> = {
  CREW_ACCESS_DENIED: "Crew access could not be restored.",
  CREW_ACCESS_UNAVAILABLE: "Crew access is temporarily unavailable.",
};

export class CrewAccessError extends Error {
  readonly code: CrewAccessErrorCode;
  readonly status: number;

  constructor(code: CrewAccessErrorCode) {
    super(MESSAGE[code]);
    this.name = "CrewAccessError";
    this.code = code;
    this.status = code === "CREW_ACCESS_DENIED" ? 401 : 503;
  }
}
