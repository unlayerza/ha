export class HAError extends Error { constructor(message:string, public code="HA_ERROR"){super(message);this.name="HAError"} }
export class StaleTermError extends HAError { constructor(message="stale term"){super(message,"STALE_TERM")} }
export class FencedError extends HAError { constructor(message="node is fenced"){super(message,"FENCED")} }
export class QuorumError extends HAError { constructor(message="quorum unavailable"){super(message,"NO_QUORUM")} }
export class AuthenticationError extends HAError { constructor(message="authentication failed"){super(message,"AUTH_FAILED")} }
export class AdmissionError extends HAError { constructor(message="node admission rejected"){super(message,"ADMISSION_REJECTED")} }
export class StateConflictError extends HAError { constructor(message="state conflict"){super(message,"STATE_CONFLICT")} }
